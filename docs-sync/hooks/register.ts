import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

// 判定の上限。モデルは作業中のセッションと同じものを使う
const MAX_TOKENS = 4096
const JUDGE_TIMEOUT_MS = 5 * 60 * 1000
// 1 回の判定に渡すテキストの上限(文字数)。超えたら関係するドキュメントを先に選ばせ、差分を分けて判定する
const PROMPT_BUDGET = 300_000
// 差分を分けて判定するときの回数の上限。入りきらないファイルは、判定できなかったものとして扱う
const MAX_PARTS = 5
// 判定の対象にするドキュメント
const DOC_FILE = /\.mdx?$/
// 差分を分けるときに判定から外すファイル。lock ファイル・minify されたもの・source map は、ドキュメントとのずれに関係しない
// (バイナリと、.gitattributes で linguist-generated・linguist-vendored のものも外す)
const SKIP_FILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|go\.sum|flake\.lock|Podfile\.lock|Package\.resolved|packages\.lock\.json|mix\.lock|pubspec\.lock)$|\.min\.(js|css)$|\.map$/

const ASK_CANCEL = '中止する'

type Finding = { doc: string; issue: string; fix: string }
// ok の detail は、通した理由を Claude に伝える文
// drift の unchecked は、差分を分けて判定したときに判定できなかったファイル
// split は、同じコマンドの中の mover のために判定できないので、分けて実行させる
type Verdict =
  | { status: 'ok'; detail: string }
  | { status: 'drift'; findings: Finding[]; unchecked: string[] }
  | { status: 'split'; mover: string }
type Doc = { path: string; text: string }
// コマンドから読み取った PR 作成の内容
// mover は、同じコマンドの中で先に実行される、読むだけでない git コマンド(`git commit` など)
// repo は -R / --repo の指定(PR を出す先のリポジトリ)
export type PrCreate = { cds: string[]; base?: string; head?: string; repo?: string; mover?: string }
// コマンドから読み取った git push の内容。remote は push 先の指定(省略時は git の既定)、refs が空なら今のブランチを push する
export type Push = { cds: string[]; remote?: string; refs: PushRef[]; mover?: string }
// push する refspec。src は push するコミット、dst は push 先のブランチ(省略時は src と同じ)
export type PushRef = { src: string; dst?: string }

// 割り込む操作ごとの言い回し。command・blocked・retry は Claude に、ask・proceed はユーザーに見せる
type Action = { command: string; blocked: string; retry: string; ask: string; proceed: string }
const PR_CREATE: Action = {
  command: 'gh pr create',
  blocked: 'PR creation was blocked',
  retry: 'Commit the fixes, push them, and run gh pr create again.',
  ask: 'このまま PR を作成しますか?',
  proceed: 'このまま PR を作成する',
}
const PUSH: Action = {
  command: 'git push',
  blocked: 'the push was blocked',
  retry: 'Commit the fixes and push again. The push sends them together with the commits it was going to send.',
  ask: 'このまま push しますか?',
  proceed: 'このまま push する',
}

// 止めたときに Claude へ示す、次に取れる手段
type Hint = (action: Action) => string
const RETRY: Hint = a => `Run ${a.command} again. The failure may be temporary.`
const SPLIT_PR: Hint = () => 'Split the branch into smaller pull requests, so that each diff is small enough to check.'
const DISABLE: Hint = () => 'To turn docs-sync off for a while, the user can run claude plugin disable docs-sync@skills-dir (and enable it again afterwards).'
const BY_HAND: Hint = a =>
  `If the user wants to go ahead without the check, they can run ${a.command} themselves in their own terminal. docs-sync only checks the commands that Claude runs.`
const fetchBase = (remote: string): Hint => () => `Fetch the base branch (git fetch ${remote}) and run again.`

// 判定できなかったことを表す。ユーザーに続けるか聞く。
// hints は止めたときに示す手段、files は判定できなかったファイル、
// skip はユーザーが続けることを選んだときに記録する先(もう一度実行しても判定できない、差分が大きすぎるときだけ)
class CheckFailed extends Error {
  hints: Hint[]
  files: string[]
  skip?: { key: string; head: string }
  constructor(message: string, hints: Hint[] = [], files: string[] = []) {
    super(message)
    this.hints = hints
    this.files = files
  }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const pr = parsePrCreate(e.command)
    // gh pr create があれば、同じコマンドの git push は PR を作る前のものなので、gh pr create として判定する
    const pushes = pr === undefined ? parsePush(e.command) : []
    if (pr === undefined && pushes.length === 0) return next(e)
    const action = pr !== undefined ? PR_CREATE : PUSH

    let verdict: Verdict | undefined
    try {
      verdict = pr !== undefined ? await checkPrCreate($, pr, next.signal) : await checkPushes($, pushes, next.signal)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const failed = err instanceof CheckFailed ? err : new CheckFailed(reason)
      if (!(await confirmAfterFailure($, action, failed))) return { deny: failureDeny(action, reason, failed.hints) }
      const r = await next(e)
      // 差分が大きすぎて判定しきれなかったコミットで続けることを選び、コマンドが実行されたら、
      // 同じ base ではもう判定しない(記録できなくても続ける)
      if (failed.skip !== undefined && r.deny === undefined) {
        try {
          await $.store.set(failed.skip.key, failed.skip.head)
        } catch {}
      }
      return withNote(r, failureNote(action, reason))
    }

    // 開いている PR がないブランチへの push は、判定しない(PR を作るときに判定する)
    if (verdict === undefined) return next(e)
    if (verdict.status === 'ok') return withNote(await next(e), passNote(action, verdict.detail))
    if (verdict.status === 'split') return { deny: splitDeny(action, verdict.mover) }
    return { deny: driftDeny(action, verdict.findings, verdict.unchecked) }
  }).catch(async ($, e, next) => {
    // hook 自体が落ちたときは通さない側に倒す
    return { deny: failureDeny(actionOf(e.command), `the docs-sync hook failed (${next.error.kind})`, [RETRY]) }
  })
}

// hook が落ちたときの言い回しに使う。解析でも落ちるなら、PR の作成として扱う
function actionOf(command: string): Action {
  try {
    return parsePrCreate(command) === undefined && parsePush(command).length > 0 ? PUSH : PR_CREATE
  } catch {
    return PR_CREATE
  }
}

// gh pr create で作る PR の内容(base...head の差分)とドキュメントを比べる
async function checkPrCreate($: EngineInterface, pr: PrCreate, signal: AbortSignal): Promise<Verdict> {
  if (pr.mover !== undefined) return { status: 'split', mover: pr.mover }
  const root = await resolveRoot($, pr.cds)
  const head = await resolveHead($, root, pr.head)
  if (head === undefined) throw new CheckFailed(`could not resolve the head ${pr.head ?? 'HEAD'}`)
  // PR を出す先のリポジトリ(fork の構成なら元のリポジトリ)と、その既定のブランチ。
  // remote が 1 つで -R もなければ、その remote を使うしかないので gh には問い合わせない
  const remotes = await remoteRepos($, root)
  const only = pr.repo === undefined && remotes.names.length === 1 ? remotes.names[0] : undefined
  const target = only === undefined ? await ghRepo($, root, pr.repo) : undefined
  const remote = only ?? remoteFor(remotes.repos, target?.repo)
  const branch = pr.base ?? target?.defaultBranch
  const base = await resolveBase($, root, remote, branch)
  if (base === undefined) throw new CheckFailed(baseFailure(remote, branch), [fetchBase(remote)])
  return check($, root, base, head, signal)
}

// コマンドの中の push を順に見て、開いている PR を更新するものを、push するコミットで判定する。
// 判定するものがなければ undefined。最初のずれ(または分けて実行させるもの)で止める
async function checkPushes($: EngineInterface, pushes: Push[], signal: AbortSignal): Promise<Verdict | undefined> {
  // 開いている PR の一覧は、リポジトリごとに 1 回だけ問い合わせる
  const cache: PushCache = { prs: new Map(), remotes: new Map() }
  const details: string[] = []
  for (const push of pushes) {
    const v = await checkPush($, push, cache, signal)
    if (v === undefined) continue
    if (v.status !== 'ok') return v
    details.push(v.detail)
  }
  return details.length > 0 ? { status: 'ok', detail: details.join('; ') } : undefined
}

// push 1 つ分。push 先のブランチに開いている PR があれば、push するコミットで PR の内容を判定する。
// 判定するものがなければ undefined。refspec が複数あれば順に判定し、最初のずれで止める
// コマンドの中の push で使い回す、リポジトリ(root)ごとの開いている PR の一覧と、remote からリポジトリへの対応
type PushCache = { prs: Map<string, OpenPr[] | undefined>; remotes: Map<string, Remotes> }

async function checkPush($: EngineInterface, push: Push, cache: PushCache, signal: AbortSignal): Promise<Verdict | undefined> {
  // push 先が今のブランチや設定で決まる push の前に mover があると、mover がブランチや設定を変えうるので、
  // 実行前の今の状態からは push 先(と開いている PR があるか)がわからない。PR の有無に関係なく分けて実行させる
  if (push.mover !== undefined && dependsOnCurrentState(push)) return { status: 'split', mover: push.mover }
  // 場所がわからなければ、開いている PR があるかもわからないので、PR がないときと同じく判定しない
  let root: string
  try {
    root = await resolveRoot($, push.cds)
  } catch {
    return undefined
  }
  const current = await git($, ['symbolic-ref', '--short', '--quiet', 'HEAD'], root)
  const remote = await pushRemote($, root, push.remote, current)
  if (remote === undefined) return undefined
  const refs = await pushRefs($, root, push.refs, remote.name, current)
  if (refs.length === 0) return undefined
  // 開いている PR を、push 先のリポジトリとブランチで突き合わせる
  if (!cache.prs.has(root)) cache.prs.set(root, await openPrs($, root))
  const prs = cache.prs.get(root)
  if (prs === undefined) return undefined

  const targets = refs.flatMap(ref => prs.filter(p => p.repo === remote.repo && p.head === ref.dst).map(pr => ({ ref, pr })))
  // 開いている PR を更新する push の前に、読むだけでない git コマンドがあるなら、push するコミットがまだわからない
  if (targets.length > 0 && push.mover !== undefined) return { status: 'split', mover: push.mover }

  const details: string[] = []
  for (const { ref, pr } of targets) {
    const head = await firstCommit($, root, [ref.src])
    if (head === undefined) throw new CheckFailed(`could not resolve the commit to push (${ref.src})`)
    if (!cache.remotes.has(root)) cache.remotes.set(root, await remoteRepos($, root))
    const baseRemote = remoteFor(cache.remotes.get(root)!.repos, pr.baseRepo)
    const base = await resolveBase($, root, baseRemote, pr.base)
    if (base === undefined) throw new CheckFailed(`${baseFailure(baseRemote, pr.base)} for PR #${pr.number}`, [fetchBase(baseRemote)])
    const v = await check($, root, base, head, signal)
    if (v.status !== 'ok') return v
    details.push(`for PR #${pr.number} (${ref.dst}), ${v.detail}`)
  }
  return details.length > 0 ? { status: 'ok', detail: details.join('; ') } : undefined
}

// push 先が、今のブランチや設定(upstream・pushRemote など)で決まる push か。
// remote か refspec を省いたもの、push 先が HEAD(今のブランチ)の refspec を含むもの
function dependsOnCurrentState(push: Push): boolean {
  return push.remote === undefined || push.refs.length === 0 || push.refs.some(ref => (ref.dst ?? ref.src).replace(/^\+/, '') === 'HEAD')
}

// コマンド内の cd をたどった先の、git リポジトリのルート
async function resolveRoot($: EngineInterface, cds: string[]): Promise<string> {
  const cwd = await resolveCwd($, cds)
  const root = await git($, ['rev-parse', '--show-toplevel'], cwd)
  if (root === undefined) throw new CheckFailed(`not inside a git repository (${cwd})`)
  return root
}

// base...head の差分とドキュメントを比べ、結果を返す。判定できなければ CheckFailed を投げる
async function check($: EngineInterface, root: string, base: string, head: string, signal: AbortSignal): Promise<Verdict> {
  // 同じ base で最後に通ったコミット、または判定しきれずに続けることが選ばれたコミットと同じなら判定し直さない
  const cacheKey = `pass:${root}:${base}`
  const skipKey = `skip:${root}:${base}`
  const short = head.slice(0, 7)
  if ((await $.store.get(cacheKey)) === head) {
    return { status: 'ok', detail: `commit ${short} already passed the check against ${base}, so it was not checked again` }
  }
  if ((await $.store.get(skipKey)) === head) {
    return { status: 'ok', detail: `the user already chose to go ahead without a full check for commit ${short} against ${base}, so it was not checked again` }
  }

  const v = await compare($, root, base, head, { key: skipKey, head }, signal)
  if (v.status === 'ok' && v.checked) {
    // 記録できなくても判定結果は変えない(次回また判定するだけ)
    try {
      await $.store.set(cacheKey, head)
    } catch {}
  }
  return v.status === 'ok' ? { status: 'ok', detail: v.detail } : v
}

// 判定する差分のかたまり。files は含まれるファイル
type Piece = { files: string[]; diff: string }
type Compared = { status: 'ok'; detail: string; checked: boolean } | Extract<Verdict, { status: 'drift' }>

// check の本体。checked は、モデルで判定してずれがなかったか(差分やドキュメントがなくて通したときは false)。
// skip は、差分が大きすぎて判定しきれなかったときに、ユーザーが続けることを選んだら記録する先
async function compare($: EngineInterface, root: string, base: string, head: string, skip: { key: string; head: string }, signal: AbortSignal): Promise<Compared> {
  const range = `${base}...${head}`
  const short = head.slice(0, 7)
  // 差分全体が 4 MiB を超えて切れたときも、ファイルごとに取り直して分けて判定する
  const whole = await gitOut($, ['diff', '--no-color', range], root)
  if (whole === undefined) throw new CheckFailed(`git diff ${range} failed`, [RETRY])
  if (whole !== TRUNCATED && whole.trim() === '') {
    return { status: 'ok', detail: `there is no diff between ${base} and ${short}, so there was nothing to check`, checked: false }
  }

  const docs = await readDocs($, root, head)
  if (docs.length === 0) {
    return { status: 'ok', detail: `the repository has no Markdown documents at ${short}, so there was nothing to check`, checked: false }
  }

  // 実装を読む判定なので、作業中のセッションと同じモデルで見る
  const model = await $.session.model()
  // 差分全体とドキュメントが予算に入るか、差分全体が予算の半分までなら、1 回で判定する(入らないドキュメントは選ばせる)
  if (whole !== TRUNCATED && (whole.length + sizeOf(docs) <= PROMPT_BUDGET || whole.length <= PROMPT_BUDGET / 2)) {
    const changed = (await git($, ['diff', '--name-only', range], root)) ?? ''
    const selected = await selectDocs($, model, docs, PROMPT_BUDGET - whole.length, changed, signal)
    const findings = await judge($, model, selected, whole, signal)
    if (findings.length > 0) return { status: 'drift', findings, unchecked: [] }
    const checked = `checked the diff ${base}...${short} against ${selected.length} of ${docs.length} documents and found no mismatch between the implementation and the documentation`
    return { status: 'ok', detail: checked, checked: true }
  }

  // 入らなければ、ドキュメントに関係しないファイルを外し、ファイルごとの差分を詰めて分ける
  const files = await fileDiffs($, root, range, head, whole)
  if (files.pieces.length === 0 && files.huge.length === 0 && files.unreadable.length === 0) {
    return { status: 'ok', detail: `the diff ${base}...${short} only changes files that do not affect the documentation (such as lock files, generated files and binaries), so there was nothing to check`, checked: false }
  }
  // 各回に変更されたファイルの一覧も渡すので、その分を除いた残りを、ドキュメントと差分で分ける。
  // ドキュメントには、差分が入りきらないときでも半分までを使う
  const changed = changedList(files.paths, files.skipped)
  const avail = PROMPT_BUDGET - changed.length
  const total = files.pieces.reduce((n, p) => n + p.diff.length, 0)
  const selected = files.pieces.length > 0 ? await selectDocs($, model, docs, avail - Math.min(total, avail / 2), changed, signal) : []
  const budget = avail - sizeOf(selected)
  // 1 つで 1 回分に入らないファイルは判定できない
  const tooLarge = [...files.huge, ...files.pieces.filter(p => p.diff.length > budget).flatMap(p => p.files)]
  const parts = packPieces(files.pieces.filter(p => p.diff.length <= budget), budget)
  const judged = parts.slice(0, MAX_PARTS)
  const unchecked = [...tooLarge, ...files.unreadable, ...parts.slice(MAX_PARTS).flatMap(p => p.files)]

  // ずれが見つかっても、残りの部分も最後まで判定して、まとめて伝える
  const findings: Finding[] = []
  const failures: string[] = []
  try {
    for (const [i, part] of judged.entries()) {
      if (judged.length > 1) showStatus($, `docs-sync: 差分を分けて確認しています(${i + 1}/${judged.length})`)
      // 1 回で済むなら、分けていることは伝えない(ほかのファイルについての指摘を控えさせないため)
      const context = judged.length > 1 ? { index: i + 1, count: judged.length, changed } : undefined
      try {
        findings.push(...(await judge($, model, selected, part.diff, signal, context)))
      } catch (err) {
        if (!(err instanceof CheckFailed)) throw err
        failures.push(err.message)
        unchecked.push(...part.files)
      }
    }
  } finally {
    if (judged.length > 1) showStatus($, undefined)
  }

  if (findings.length > 0) return { status: 'drift', findings, unchecked }
  if (unchecked.length > 0) {
    const why = [
      ...(tooLarge.length > 0 ? [`${tooLarge.length} too large to check on their own`] : []),
      ...(files.unreadable.length > 0 ? [`git diff failed for ${files.unreadable.length}`] : []),
      ...(parts.length > MAX_PARTS ? [`the diff needed ${parts.length} parts and only ${MAX_PARTS} are checked`] : []),
      ...failures.map(f => `a part failed: ${f}`),
    ].join('; ')
    const rest = failures.length < judged.length ? ', and the rest has no mismatch' : ''
    // 一時的な失敗があれば、もう一度実行すれば判定できるかもしれないので、続けることを選んでも記録しない
    const transient = files.unreadable.length > 0 || failures.length > 0
    const err = new CheckFailed(
      `the diff is too large to check in full: ${unchecked.length} changed files could not be checked (${why})${rest}`,
      transient ? [RETRY, SPLIT_PR, DISABLE] : [SPLIT_PR, DISABLE],
      unchecked,
    )
    if (!transient) err.skip = skip
    throw err
  }

  const how = judged.length > 1 ? ` in ${judged.length} parts` : ''
  const left = files.skipped.size > 0 ? ` (leaving out ${files.skipped.size} files that do not affect the documentation, such as lock files)` : ''
  const checked = `checked the diff ${base}...${short}${how}${left} against ${selected.length} of ${docs.length} documents and found no mismatch between the implementation and the documentation`
  return { status: 'ok', detail: checked, checked: true }
}

function sizeOf(docs: Doc[]): number {
  return docs.reduce((n, d) => n + d.text.length, 0)
}

// 進み具合をプロンプトの下に出す(undefined で消す)。出せなくても判定は続ける
function showStatus($: EngineInterface, text: string | undefined): void {
  try {
    $.ui.status(text)
  } catch {}
}

// 変更されたファイル 1 つ。binary は、numstat で行数が出ない(バイナリの)もの
type FileEntry = { path: string; binary: boolean }

// 差分をファイルごとに分ける。差分全体を取れていれば、ファイルの境目で分ける(numstat は差分全体と同じ順・同じ rename の扱いで並ぶ)。
// 切れていた、または numstat と数が合わないときは、rename を削除と追加として扱い、ファイルごとに取り直す。
// paths は変更されたすべてのファイル、skipped はドキュメントに関係しないので外したもの、
// huge は 1 つで 4 MiB を超えたもの、unreadable は差分を取れなかったもの
async function fileDiffs(
  $: EngineInterface,
  root: string,
  range: string,
  head: string,
  whole: string | typeof TRUNCATED,
): Promise<{ paths: string[]; pieces: Piece[]; skipped: Set<string>; huge: string[]; unreadable: string[] }> {
  let entries: FileEntry[] | undefined
  let sections: string[] = []
  if (whole !== TRUNCATED) {
    entries = await numstat($, root, [range])
    sections = splitSections(whole)
    if (sections.length !== entries.length) entries = undefined
  }
  const byFile = entries === undefined
  entries ??= await numstat($, root, ['--no-renames', range])

  const generated = await generatedFiles($, root, head, entries.map(e => e.path))
  const pieces: Piece[] = []
  const skipped = new Set<string>()
  const huge: string[] = []
  const unreadable: string[] = []
  for (const [i, { path, binary }] of entries.entries()) {
    if (binary || SKIP_FILE.test(path) || generated.has(path)) {
      skipped.add(path)
      continue
    }
    const diff = byFile ? await gitOut($, ['diff', '--no-color', '--no-renames', range, '--', `:(literal)${path}`], root) : sections[i]!
    if (diff === undefined) unreadable.push(path)
    else if (diff === TRUNCATED) huge.push(path)
    else if (diff.trim() !== '') pieces.push({ files: [path], diff })
  }
  return { paths: entries.map(e => e.path), pieces, skipped, huge, unreadable }
}

// git diff --numstat -z の結果。rename・copy は、パスが空で、続く 2 つが元と先のパスになるので、先のパスを使う
async function numstat($: EngineInterface, root: string, args: string[]): Promise<FileEntry[]> {
  const out = await git($, ['diff', '--numstat', '-z', ...args], root)
  if (out === undefined) throw new CheckFailed(`git diff --numstat ${args.join(' ')} failed`, [RETRY])
  const tokens = out.split('\0')
  const entries: FileEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\S+)\t(\S+)\t([\s\S]*)$/.exec(tokens[i]!)
    if (m === null) continue
    let path = m[3]!
    if (path === '') {
      path = tokens[i + 2] ?? ''
      i += 2
    }
    entries.push({ path, binary: m[1] === '-' })
  }
  return entries
}

// 差分全体を、ファイルごとの区切り(行頭の `diff --git `)で分ける
function splitSections(diff: string): string[] {
  const starts = [...diff.matchAll(/^diff --git /gm)].map(m => m.index)
  return starts.map((start, i) => diff.slice(start, starts[i + 1] ?? diff.length))
}

// 差分を分けて判定するときに各回へ渡す、変更されたファイルの一覧の上限(文字数)
const CHANGED_BUDGET = 20_000

// 各回に渡す、ブランチ全体の変更されたファイルの一覧。外したものには印を付け、長すぎれば先頭だけにする
function changedList(paths: string[], skipped: Set<string>): string {
  const lines: string[] = []
  let used = 0
  for (const [i, path] of paths.entries()) {
    const line = skipped.has(path) ? `${path} (left out: does not affect the documentation)` : path
    if (used + line.length + 1 > CHANGED_BUDGET) {
      lines.push(`... and ${paths.length - i} more files`)
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

// .gitattributes で linguist-generated・linguist-vendored が指定されたファイル。head 時点の .gitattributes で見る
// (--source が使えない古い git では、作業ツリーのもの)。確かめられなければ空
async function generatedFiles($: EngineInterface, root: string, head: string, paths: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (paths.length === 0) return out
  const attrs = ['linguist-generated', 'linguist-vendored']
  for (const source of [['--source', head], []]) {
    const r = await git($, ['check-attr', '-z', '--stdin', ...source, ...attrs], root, paths.join('\0') + '\0')
    if (r === undefined) continue
    // path・属性・値の 3 つずつ。値は set・true のときだけ外す
    const fields = r.split('\0')
    for (let i = 0; i + 2 < fields.length; i += 3) {
      if (fields[i + 2] === 'set' || fields[i + 2] === 'true') out.add(fields[i]!)
    }
    return out
  }
  return out
}

// ファイルごとの差分を、順に budget まで詰めて、判定 1 回分ずつにまとめる
function packPieces(pieces: Piece[], budget: number): Piece[] {
  const parts: Piece[] = []
  for (const p of pieces) {
    const last = parts[parts.length - 1]
    if (last !== undefined && last.diff.length + p.diff.length <= budget) {
      last.files.push(...p.files)
      last.diff += p.diff
    } else {
      parts.push({ files: [...p.files], diff: p.diff })
    }
  }
  return parts
}

// 通したコマンドの結果に、Claude だけが読む一文を添える
function withNote(r: ToolCallResult<'Bash'>, note: string): ToolCallResult<'Bash'> {
  if (r.deny !== undefined) return r
  return { ...r, context: [...(r.context ?? []), note] }
}

// git の出力が 4 MiB を超えて切れたことを表す
const TRUNCATED = Symbol('truncated')
// 出力をそのまま返す(trim しない)git のサブコマンド
const RAW_OUTPUT = new Set(['diff', 'show', 'check-attr'])

// git を cwd で実行し、成功したら stdout を返す。出力が切れたら TRUNCATED、失敗したら undefined
async function gitOut($: EngineInterface, args: string[], cwd: string, stdin?: string): Promise<string | typeof TRUNCATED | undefined> {
  try {
    const r = await $.process.run(['git', ...args], stdin === undefined ? { cwd } : { cwd, stdin })
    if (r.exitCode !== 0) return undefined
    if (r.isStdoutTruncated) return TRUNCATED
    return RAW_OUTPUT.has(args[0]!) ? r.stdout : r.stdout.trim()
  } catch {
    return undefined
  }
}

// git を cwd で実行し、成功したら stdout を返す。出力が切れたときも失敗として扱う
async function git($: EngineInterface, args: string[], cwd: string, stdin?: string): Promise<string | undefined> {
  const out = await gitOut($, args, cwd, stdin)
  return out === TRUNCATED ? undefined : out
}

// コマンド内の cd を順にたどり、gh pr create が実行される場所を求める
async function resolveCwd($: EngineInterface, cds: string[]): Promise<string> {
  let cwd = await $.session.cwd()
  // Windows かどうかは、cd で移る前のセッションの cwd で一度だけ決める
  const windows = DRIVE.test(cwd)
  for (const dir of cds) {
    let target = dir
    if (target === '' || target === '~' || target.startsWith('~/')) {
      const home = await $.env.get('HOME')
      if (home === undefined) throw new CheckFailed('could not resolve ~ in cd')
      target = home + target.slice(1)
    }
    cwd = joinDir(cwd, target, windows)
  }
  return cwd
}

// Windows のドライブ文字で始まるパス(D:、D:/、D:\、D:repo)
const DRIVE = /^[A-Za-z]:/

// cd の行き先を、今いる場所から求める。Windows では、区切り文字を / にそろえ、
// ドライブ文字で始まるパスを絶対パスとして扱う。Git Bash・MSYS2 の /d/... と Cygwin の /cygdrive/d/... は、
// git が解決できる D:/... に直す
export function joinDir(cwd: string, target: string, windows: boolean): string {
  if (!windows) return target.startsWith('/') ? target : `${cwd}/${target}`
  const t = target.replace(/\\/g, '/')
  const mount = /^(?:\/cygdrive)?\/([A-Za-z])(\/.*)?$/.exec(t)
  if (mount !== null) return `${mount[1]!.toUpperCase()}:${mount[2] ?? '/'}`
  if (DRIVE.test(t)) return t.length === 2 ? `${t}/` : t
  if (t.startsWith('/')) return t
  return `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${t}`
}

// PR の head のコミット。--head があれば push 済みの origin/<branch> を優先し、なければ HEAD
async function resolveHead($: EngineInterface, root: string, flag: string | undefined): Promise<string | undefined> {
  if (flag === undefined) return git($, ['rev-parse', 'HEAD'], root)
  // fork の `owner:branch` はブランチ名だけを使う
  const branch = flag.includes(':') ? flag.slice(flag.indexOf(':') + 1) : flag
  return firstCommit($, root, [`origin/${branch}`, branch])
}

// base のブランチの指定があれば <remote>/<base>、origin/<base>、ローカルの <base> の順に試し、
// なければ remote(と origin)の既定ブランチを使う。remote は、PR の base があるリポジトリを指すもの
// (fork の構成なら upstream など)。<remote>/<base> をまだ fetch していなければ、origin のものに戻る
async function resolveBase($: EngineInterface, root: string, remote: string, branch: string | undefined): Promise<string | undefined> {
  const remotes = remote === 'origin' ? ['origin'] : [remote, 'origin']
  const candidates = branch !== undefined ? [...remotes.map(r => `${r}/${branch}`), branch] : []
  if (branch === undefined) {
    // remote ごとに、既定ブランチ(<remote>/HEAD が指すもの)、<remote>/main の順に試す
    for (const r of remotes) {
      const remoteHead = await git($, ['symbolic-ref', '--short', `refs/remotes/${r}/HEAD`], root)
      if (remoteHead !== undefined) candidates.push(remoteHead)
      candidates.push(`${r}/main`)
    }
    candidates.push('main')
  }
  for (const ref of candidates) {
    if ((await git($, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root)) !== undefined) return ref
  }
  return undefined
}

// base を解決できなかったときの理由。何を fetch すればよいかがわかるように、remote とブランチを含める
function baseFailure(remote: string, branch: string | undefined): string {
  return branch !== undefined
    ? `could not resolve the base branch ${branch} (tried ${remote}/${branch}${remote === 'origin' ? '' : `, origin/${branch}`} and ${branch})`
    : `could not resolve the default branch of ${remote} (tried ${remote}/HEAD, ${remote}/main${remote === 'origin' ? '' : ', origin/HEAD, origin/main'} and main)`
}

// names はすべての remote の名前、repos は remote の名前からそれが指すリポジトリ(owner/name、小文字)への対応
// (URL からリポジトリを読み取れた remote だけ)
type Remotes = { names: string[]; repos: Map<string, string> }

// git remote -v の fetch の行から、remote の一覧を作る。partial clone の remote は行末に [blob:none] などが付く
async function remoteRepos($: EngineInterface, root: string): Promise<Remotes> {
  const names: string[] = []
  const repos = new Map<string, string>()
  for (const line of ((await git($, ['remote', '-v'], root)) ?? '').split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)(?:\s.*)?$/.exec(line)
    if (m === null) continue
    names.push(m[1]!)
    const repo = repoOf(m[2]!)
    if (repo !== undefined) repos.set(m[1]!, repo)
  }
  return { names, repos }
}

// リポジトリ(owner/name)を指す remote。origin が指していれば origin、なければほかの remote から探す。
// 見つからない、またはリポジトリがわからなければ origin
function remoteFor(remotes: Map<string, string>, repo: string | undefined): string {
  if (repo === undefined || remotes.get('origin') === repo) return 'origin'
  for (const [name, r] of remotes) if (r === repo) return name
  return 'origin'
}

// gh が PR を出す先とするリポジトリ(owner/name、小文字)と、その既定のブランチ。-R の指定があればそのリポジトリ。
// gh で確かめられなければ undefined
async function ghRepo($: EngineInterface, root: string, flag: string | undefined): Promise<{ repo: string; defaultBranch?: string } | undefined> {
  try {
    const argv = ['gh', 'repo', 'view', ...(flag !== undefined ? [flag] : []), '--json', 'nameWithOwner,defaultBranchRef']
    const r = await $.process.run(argv, { cwd: root, timeoutMs: GH_TIMEOUT_MS })
    if (r.exitCode !== 0) return undefined
    const v = parseJson(r.stdout) as { nameWithOwner?: unknown; defaultBranchRef?: { name?: unknown } } | undefined
    if (typeof v?.nameWithOwner !== 'string') return undefined
    const name = v.defaultBranchRef?.name
    return typeof name === 'string' && name !== '' ? { repo: v.nameWithOwner.toLowerCase(), defaultBranch: name } : { repo: v.nameWithOwner.toLowerCase() }
  } catch {
    return undefined
  }
}

// 候補のうち最初に解決できた ref のコミット
async function firstCommit($: EngineInterface, root: string, refs: string[]): Promise<string | undefined> {
  for (const ref of refs) {
    const sha = await git($, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root)
    if (sha !== undefined) return sha
  }
  return undefined
}

// push 先の remote と、それが指す GitHub のリポジトリ(owner/name、小文字)。
// remote の指定がなければ、git と同じく pushRemote・pushDefault・upstream の remote・origin の順に決める。
// リポジトリを URL から読み取れなければ undefined
async function pushRemote($: EngineInterface, root: string, given: string | undefined, current: string | undefined): Promise<{ name?: string; repo: string } | undefined> {
  let name = given
  if (name === undefined && current !== undefined) {
    name = (await git($, ['config', `branch.${current}.pushRemote`], root)) ?? (await git($, ['config', 'remote.pushDefault'], root)) ?? (await git($, ['config', `branch.${current}.remote`], root))
  }
  name ??= 'origin'
  // remote の名前ではなく URL を直接指定した push
  const isUrl = name.includes(':') || name.includes('/')
  const url = isUrl ? name : await git($, ['remote', 'get-url', '--push', name], root)
  const repo = url === undefined ? undefined : repoOf(url)
  if (repo === undefined) return undefined
  return { name: isUrl ? undefined : name, repo }
}

// remote の URL(git@host:owner/name.git・https://host/owner/name など)から owner/name を取り出す
export function repoOf(url: string): string | undefined {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  return m === null ? undefined : `${m[1]}/${m[2]}`.toLowerCase()
}

// push する refspec を、push するコミット(src)と push 先のブランチ名(dst)にそろえる。
// refspec がなければ今のブランチを push する。push 先が upstream の remote ならその upstream のブランチへ、
// ほかの remote なら同じ名前のブランチへ
async function pushRefs($: EngineInterface, root: string, refs: PushRef[], remote: string | undefined, current: string | undefined): Promise<Required<PushRef>[]> {
  if (refs.length === 0) {
    // detached HEAD から refspec なしで push することはできないので、判定するものはない
    if (current === undefined) return []
    const upstreamRemote = await git($, ['config', `branch.${current}.remote`], root)
    const merge = remote !== undefined && remote === upstreamRemote ? await git($, ['config', `branch.${current}.merge`], root) : undefined
    return [{ src: 'HEAD', dst: merge?.replace(/^refs\/heads\//, '') ?? current }]
  }
  const out: Required<PushRef>[] = []
  for (const ref of refs) {
    const src = ref.src.replace(/^\+/, '')
    // `:branch` はブランチの削除なので判定しない
    if (src === '') continue
    let dst = ref.dst ?? src
    if (dst === 'HEAD') {
      if (current === undefined) continue
      dst = current
    }
    out.push({ src, dst: dst.replace(/^refs\/heads\//, '') })
  }
  return out
}

// repo は head のブランチがあるリポジトリ、baseRepo は PR を出した先のリポジトリ(どちらも owner/name、小文字)
type OpenPr = { number: number; base: string; head: string; repo: string; baseRepo?: string }
const GH_TIMEOUT_MS = 15_000

// 開いている PR の一覧。gh で確かめられなければ undefined
async function openPrs($: EngineInterface, root: string): Promise<OpenPr[] | undefined> {
  try {
    const r = await $.process.run(
      ['gh', 'pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,url,baseRefName,headRefName,headRepository,headRepositoryOwner'],
      { cwd: root, timeoutMs: GH_TIMEOUT_MS },
    )
    if (r.exitCode !== 0 || r.isStdoutTruncated) return undefined
    const list = parseJson(r.stdout)
    if (!Array.isArray(list)) return undefined
    return list.flatMap(p => {
      const owner = p?.headRepositoryOwner?.login
      const name = p?.headRepository?.name
      if (typeof p?.number !== 'number' || typeof p.baseRefName !== 'string' || typeof p.headRefName !== 'string') return []
      if (typeof owner !== 'string' || typeof name !== 'string') return []
      // PR の URL(https://<host>/<owner>/<name>/pull/<number>)から、PR を出した先のリポジトリを読む
      const base = typeof p.url === 'string' ? /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(p.url) : null
      const pr: OpenPr = { number: p.number, base: p.baseRefName, head: p.headRefName, repo: `${owner}/${name}`.toLowerCase() }
      return [base === null ? pr : { ...pr, baseRepo: `${base[1]}/${base[2]}`.toLowerCase() }]
    })
  } catch {
    return undefined
  }
}

// head のコミット時点のドキュメントを読む。PR に入るのはコミット済みの内容なので、作業ツリーからは読まない
async function readDocs($: EngineInterface, root: string, head: string): Promise<Doc[]> {
  const list = await git($, ['ls-tree', '-r', '--name-only', head], root)
  if (list === undefined) throw new CheckFailed('git ls-tree failed')
  const paths = list.split('\n').filter(p => DOC_FILE.test(p))
  const docs: Doc[] = []
  for (const path of paths) {
    const text = await git($, ['show', `${head}:${path}`], root)
    if (text !== undefined) docs.push({ path, text })
  }
  return docs
}

// room(ドキュメントに使える文字数)に収まればすべて渡す。収まらなければ、差分に関係しそうなドキュメントをモデルに選ばせる
async function selectDocs($: EngineInterface, model: string, docs: Doc[], room: number, changed: string, signal: AbortSignal): Promise<Doc[]> {
  if (docs.reduce((n, d) => n + d.text.length, 0) <= room) return docs

  const r = await $.model.complete(
    {
      model,
      system: SELECT_SYSTEM,
      prompt: selectPrompt(docs, changed),
      maxTokens: MAX_TOKENS,
      timeoutMs: JUDGE_TIMEOUT_MS,
    },
    { signal },
  )
  if (!r.isAnswered) throw new CheckFailed(`model call failed (${r.reason})`, [RETRY])

  const wanted = parseJson(r.text)
  if (!Array.isArray(wanted)) throw new CheckFailed('could not read the model reply', [RETRY])
  const names = new Set(wanted.map(p => normalizePath(String(p))))
  const picked = docs.filter(d => names.has(d.path))

  // room に入るものだけを渡す。入らない大きなものは飛ばし、後ろのものは続けて入れる
  const out: Doc[] = []
  let used = 0
  for (const d of picked) {
    if (used + d.text.length > room) continue
    out.push(d)
    used += d.text.length
  }
  // 1 件も渡せないなら、ドキュメントなしで「ずれなし」と判定してしまうので、判定できない扱いにする
  if (out.length === 0) throw new CheckFailed('no documents could be selected for the check')
  return out
}

// 差分を分けて判定するときの、何回目か(index / count)と、ブランチ全体の変更されたファイルの一覧
type PartContext = { index: number; count: number; changed: string }

// ずれの指摘を返す。ずれがなければ空。part があれば、差分の一部として判定させる
async function judge($: EngineInterface, model: string, docs: Doc[], diff: string, signal: AbortSignal, part?: PartContext): Promise<Finding[]> {
  const r = await $.model.complete(
    {
      model,
      system: part === undefined ? JUDGE_SYSTEM : `${JUDGE_SYSTEM}\n\n${JUDGE_PART}`,
      prompt: judgePrompt(docs, diff, part),
      maxTokens: MAX_TOKENS,
      timeoutMs: JUDGE_TIMEOUT_MS,
    },
    { signal },
  )
  if (!r.isAnswered) throw new CheckFailed(`model call failed (${r.reason})`, [RETRY])

  const v = parseJson(r.text) as { status?: unknown; findings?: unknown } | undefined
  if (v?.status === 'ok') return []
  if (v?.status === 'drift' && Array.isArray(v.findings) && v.findings.length > 0) {
    return v.findings.map(f => ({
      doc: String(f?.doc ?? ''),
      issue: String(f?.issue ?? ''),
      fix: String(f?.fix ?? ''),
    }))
  }
  throw new CheckFailed('could not read the model reply', [RETRY])
}

// 判定できなかったとき、続けるかをユーザーに聞く。答えられない(-p 実行・閉じた)ときは中止。
// 差分の一部だけを判定できなかったときは、そのファイルを示す
async function confirmAfterFailure($: EngineInterface, action: Action, failed: CheckFailed): Promise<boolean> {
  const question =
    failed.files.length > 0
      ? `docs-sync: 差分が大きく、一部のファイルで実装とドキュメントの差異を確認できませんでした(${failed.message})。確認できなかったファイル: ${listFiles(failed.files, n => ` ほか ${n} 件`)}。${action.ask}`
      : `docs-sync: 実装とドキュメントの差異を確認できませんでした(${failed.message})。${action.ask}`
  try {
    const answer = await $.ui.ask(question, { header: 'docs-sync', options: [action.proceed, ASK_CANCEL] })
    return answer === action.proceed
  } catch {
    return false
  }
}

// コマンドが gh pr create を実行するなら、その内容を返す。引用符やヒアドキュメントの中の文字列には反応しない
export function parsePrCreate(command: string): PrCreate | undefined {
  return findPrCreate(splitCommand(command), [])
}

// 区切りを順にたどって、最初の gh pr create を探す
function findPrCreate(segments: Segment[], outerCds: string[]): PrCreate | undefined {
  return collectCommands(segments, outerCds, (words, cds, mover) => {
    if (words[0] !== 'gh' || words[1] !== 'pr' || words[2] !== 'create') return undefined
    const args = parseCreateArgs(words.slice(3))
    if (args.help) return undefined
    const pr: PrCreate = { cds, base: args.base, head: args.head }
    if (args.repo !== undefined) pr.repo = args.repo
    return mover === undefined ? pr : { ...pr, mover }
  })[0]
}

// コマンドが実行する git push を、実行する順にすべて返す。ブランチの削除・dry run・タグだけの push などは含めない
export function parsePush(command: string): Push[] {
  return collectCommands(splitCommand(command), [], (words, cds, mover) => {
    const g = parseGit(words, cds)
    if (g === undefined || g.sub !== 'push') return undefined
    // bare リポジトリなど、場所を読み取れない git push は判定しない
    if (g.here === undefined) return undefined
    const args = parsePushArgs(g.rest)
    if (args === undefined) return undefined
    return mover === undefined ? { cds: g.here, ...args } : { cds: g.here, ...args, mover }
  })
}

// git のコマンドなら、サブコマンドとその引数、実行される場所(cds に全体のオプションの分を足したもの)を返す。
// -C は cd と同じく場所を変える(--work-tree は作業ツリーを変えるだけで、リポジトリは今いる場所から探すので変えない)。
// --git-dir は、.git を指すならその親へ移り、それ以外(bare リポジトリなど)は場所を読み取れないので here を undefined にする
function parseGit(words: string[], cds: string[]): { sub: string; rest: string[]; here?: string[] } | undefined {
  if (words[0] !== 'git') return undefined
  let here: string[] | undefined = [...cds]
  let i = 1
  while (i < words.length && words[i]!.startsWith('-')) {
    const w = words[i]!
    const eq = w.startsWith('--') ? w.indexOf('=') : -1
    const name = eq < 0 ? w : w.slice(0, eq)
    const takesValue = GIT_VALUE_OPTIONS.has(name)
    const value = !takesValue ? undefined : eq < 0 ? words[i + 1] : w.slice(eq + 1)
    if (name === '-C') here?.push(value ?? '')
    if (name === '--git-dir') {
      const dir = (value ?? '').replace(/\/+$/, '')
      if (dir !== '.git' && !dir.endsWith('/.git')) here = undefined
      else if (dir !== '.git') here?.push(dir.slice(0, -'/.git'.length) || '/')
    }
    i += takesValue && eq < 0 ? 2 : 1
  }
  const sub = words[i]
  if (sub === undefined) return undefined
  return here === undefined ? { sub, rest: words.slice(i + 1) } : { sub, rest: words.slice(i + 1), here }
}

// 読むだけの git のサブコマンド。これ以外の git コマンド(push は除く)と gh pr checkout は、
// コミットを作ったり、ブランチの指すコミットや今のブランチを変えたりしうるので、mover として扱う
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'fetch', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file',
  'describe', 'blame', 'grep', 'shortlog', 'merge-base', 'for-each-ref', 'show-ref', 'name-rev', 'check-ignore',
  'count-objects', 'whatchanged', 'help', 'version',
])

// 実行する前の今は、その後ろの push・PR に入るコミットがわからなくなるコマンドなら、その名前(`git commit` など)
function moverOf(words: string[], cds: string[]): string | undefined {
  if (words[0] === 'gh' && words[1] === 'pr' && words[2] === 'checkout') return 'gh pr checkout'
  const g = parseGit(words, cds)
  if (g === undefined || g.sub === 'push' || READ_ONLY_GIT.has(g.sub)) return undefined
  return `git ${g.sub}`
}

// 区切りを順にたどり、match が値を返したコマンドを、実行する順にすべて返す。match は、対象外なら undefined を返す。
// cds はそこまでに実行される cd、mover はそこまでに実行される、読むだけでない git コマンド(最初のもの)
function collectCommands<T>(
  segments: Segment[],
  outerCds: string[],
  match: (words: string[], cds: string[], mover: string | undefined) => T | undefined,
  state: { mover?: string } = {},
): T[] {
  const out: T[] = []
  const cds = [...outerCds]
  for (const segment of segments) {
    // コマンド置換は区切りより先に、サブシェルで実行される。外の cd は引き継ぐが、中の cd は外に漏れない。
    // 中で作ったコミットはリポジトリに残るので、mover は外にも引き継ぐ
    for (const sub of segment.subs) out.push(...collectCommands(sub, cds, match, state))
    const words = stripPrefixes(segment.words)
    if (words[0] === 'cd') {
      if (words[1] !== '-') cds.push(words[1] ?? '')
      continue
    }
    const found = match(words, [...cds], state.mover)
    if (found !== undefined) out.push(found)
    state.mover ??= moverOf(words, cds)
  }
  return out
}

// git の全体のオプションのうち、値を取るもの
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'])
// git push のうち、値を取るオプション(--opt=value の形でないとき、次の単語が値)
const PUSH_VALUE_FLAGS = new Set(['--repo', '--push-option', '--receive-pack', '--exec'])
// これがあれば判定しない。削除・dry run・ヘルプ・すべての ref の push
const PUSH_SKIP_FLAGS = new Set(['--delete', '--dry-run', '--help', '--all', '--branches', '--mirror', '--prune'])

// git push の引数から push 先と refspec を読む。判定しない push なら undefined
function parsePushArgs(args: string[]): { remote?: string; refs: PushRef[] } | undefined {
  const positional: string[] = []
  let repo: string | undefined
  let tags = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a
      if (PUSH_SKIP_FLAGS.has(name)) return undefined
      if (name === '--tags') tags = true
      if (PUSH_VALUE_FLAGS.has(name)) {
        const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i]
        if (name === '--repo') repo = v
      }
    } else if (a.startsWith('-') && a.length > 1) {
      // `-uf` のような短いオプションの連結。-d・-n・-h は判定しない、-o は値を取る
      for (let k = 1; k < a.length; k++) {
        const ch = a[k]!
        if ('dnh'.includes(ch)) return undefined
        if (ch === 'o') {
          if (k === a.length - 1) i += 1
          break
        }
      }
    } else {
      positional.push(a)
    }
  }
  // 1 つ目は push 先のリモート、残りが refspec
  const refs = positional.slice(1).map(spec => {
    const colon = spec.indexOf(':')
    return colon < 0 ? { src: spec } : { src: spec.slice(0, colon), dst: spec.slice(colon + 1) }
  })
  // refspec のない --tags は、タグだけを push する
  if (refs.length === 0 && tags) return undefined
  const remote = positional[0] ?? repo
  return remote === undefined ? { refs } : { remote, refs }
}

// 先頭の環境変数の指定(NAME=value)と、env・command・time などの前置きを飛ばす
function stripPrefixes(segment: string[]): string[] {
  const isAssign = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)
  let i = 0
  while (i < segment.length) {
    const w = segment[i]!
    if (isAssign(w)) {
      i += 1
    } else if (w === 'env') {
      i += 1
      while (i < segment.length) {
        const a = segment[i]!
        if (a === '--') {
          i += 1
          break
        }
        if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(a)) i += 2
        else if (a.startsWith('-') || isAssign(a)) i += 1
        else break
      }
    } else if (['command', 'time', 'nohup', 'exec'].includes(w)) {
      i += 1
      while (i < segment.length && segment[i]!.startsWith('-')) i += 1
    } else {
      break
    }
  }
  return segment.slice(i)
}

// gh pr create のフラグのうち、値を取るもの(短い形 → 長い形)
const VALUE_FLAGS: Record<string, string> = {
  a: 'assignee',
  B: 'base',
  b: 'body',
  F: 'body-file',
  H: 'head',
  l: 'label',
  m: 'milestone',
  p: 'project',
  R: 'repo',
  r: 'reviewer',
  T: 'template',
  t: 'title',
}
const LONG_VALUE_FLAGS = new Set([...Object.values(VALUE_FLAGS), 'recover'])

// gh pr create の引数から --base / --head / --repo / --help を読む。ほかのフラグの値(--title "-Hotfix" など)は読み飛ばす
function parseCreateArgs(args: string[]): { base?: string; head?: string; repo?: string; help: boolean } {
  const values: Record<string, string> = {}
  let help = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') break
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq)
      if (name === 'help') help = true
      if (LONG_VALUE_FLAGS.has(name)) {
        const v = eq < 0 ? args[++i] : a.slice(eq + 1)
        if (v !== undefined) values[name] = v
      }
    } else if (a.startsWith('-') && a.length > 1) {
      // `-dBmain` のような短いフラグの連結も読む
      for (let k = 1; k < a.length; k++) {
        const ch = a[k]!
        if (ch === 'h') help = true
        const name = VALUE_FLAGS[ch]
        if (name === undefined) continue
        const rest = a.slice(k + 1)
        const v = rest !== '' ? rest.replace(/^=/, '') : args[++i]
        if (v !== undefined) values[name] = v
        break
      }
    }
  }
  return { base: values['base'], head: values['head'], repo: values['repo'], help }
}

type Heredoc = { delim: string; strip: boolean }
// コマンドの区切り 1 つ。subs は、その中の $(...) とバッククォートで実行されるコマンド(置換ごとに 1 つ)
export type Segment = { words: string[]; subs: Segment[][] }

// シェルのコマンドを、&& ; | ( ) 改行で区切られた単語の列に分ける。
// 引用符は外して 1 つの単語にする。$(...) とバッククォートは中身ごと 1 つの単語の一部にしたうえで、
// 中で実行されるコマンドも、その区切りの subs として解析する。ヒアドキュメントの本文とコメントは読み飛ばす。
// リダイレクト(> file、2>&1、&> file など)は、演算子もリダイレクト先も単語に含めない
export function splitCommand(command: string): Segment[] {
  const segments: Segment[] = []
  let words: string[] = []
  let subs: Segment[][] = []
  let word = ''
  let inWord = false
  // 次の単語がリダイレクト先なら true
  let dropNext = false
  const heredocs: Heredoc[] = []

  const endWord = () => {
    if (inWord) {
      if (dropNext) dropNext = false
      else words.push(word)
    }
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    dropNext = false
    if (words.length > 0 || subs.length > 0) segments.push({ words, subs })
    words = []
    subs = []
  }

  let i = 0
  while (i < command.length) {
    const c = command[i]!
    if (c === "'") {
      const close = command.indexOf("'", i + 1)
      const end = close < 0 ? command.length : close
      word += command.slice(i + 1, end)
      inWord = true
      i = end + 1
    } else if (c === '"') {
      const r = scanDouble(command, i, subs)
      word += r.text
      inWord = true
      i = r.end
    } else if (c === '$' && command[i + 1] === '(') {
      const end = scanSubst(command, i + 2)
      subs.push(splitCommand(substBody(command, i + 2, end)))
      word += command.slice(i, end)
      inWord = true
      i = end
    } else if (c === '`') {
      const end = scanBacktick(command, i)
      subs.push(splitCommand(substBody(command, i + 1, end, '`')))
      word += command.slice(i, end)
      inWord = true
      i = end
    } else if (c === '\\') {
      if (i + 1 < command.length && command[i + 1] !== '\n') {
        word += command[i + 1]
        inWord = true
      }
      i += 2
    } else if (c === '#' && !inWord) {
      while (i < command.length && command[i] !== '\n') i += 1
    } else if (c === '\n') {
      endSegment()
      i = skipHeredocBodies(command, i + 1, heredocs)
      heredocs.length = 0
    } else if (c === '<' && command.startsWith('<<', i) && !command.startsWith('<<<', i)) {
      endWord()
      const r = readHeredocOp(command, i)
      heredocs.push(r.heredoc)
      i = r.end
    } else if (c === '>' || c === '<' || (c === '&' && command[i + 1] === '>')) {
      // 直前の fd の数字(2> の 2)も、リダイレクトの一部として捨てる
      if (inWord && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      } else {
        endWord()
      }
      let j = c === '&' ? i + 2 : i + 1
      if (command[j] === '>' || command[j] === '|') j += 1
      if (command[j] === '&' && /[0-9-]/.test(command[j + 1] ?? '')) {
        // 2>&1 のような fd の複製。リダイレクト先は数字か -
        j += 1
        while (j < command.length && /[0-9-]/.test(command[j]!)) j += 1
      } else {
        // >& file は、stdout と stderr をファイルへ送る。リダイレクト先は次の単語
        if (command[j] === '&') j += 1
        dropNext = true
      }
      i = j
    } else if (';&|()'.includes(c)) {
      endSegment()
      i += 1
    } else if (/\s/.test(c)) {
      endWord()
      i += 1
    } else {
      word += c
      inWord = true
      i += 1
    }
  }
  endSegment()
  return segments
}

// i は開きの " の位置。閉じの " の次の位置と、中身を返す。中の $(...) とバッククォートは入れ子として読み、
// subs があれば、その中で実行されるコマンドの解析結果を加える
function scanDouble(s: string, i: number, subs?: Segment[][]): { end: number; text: string } {
  let text = ''
  let j = i + 1
  while (j < s.length && s[j] !== '"') {
    const c = s[j]!
    if (c === '\\' && j + 1 < s.length) {
      text += s[j + 1]
      j += 2
    } else if (c === '$' && s[j + 1] === '(') {
      const end = scanSubst(s, j + 2)
      subs?.push(splitCommand(substBody(s, j + 2, end)))
      text += s.slice(j, end)
      j = end
    } else if (c === '`') {
      const end = scanBacktick(s, j)
      subs?.push(splitCommand(substBody(s, j + 1, end, '`')))
      text += s.slice(j, end)
      j = end
    } else {
      text += c
      j += 1
    }
  }
  return { end: j + 1, text }
}

// コマンド置換の中身。start は中身の先頭、end は閉じ(close)の次の位置。閉じていなければ末尾まで
function substBody(s: string, start: number, end: number, close = ')'): string {
  return s.slice(start, s[end - 1] === close ? end - 1 : end)
}

// i は $( の中身の先頭。対応する ) の次の位置を返す。中の引用符・ヒアドキュメント・入れ子の括弧を考慮する
function scanSubst(s: string, i: number): number {
  let depth = 1
  let j = i
  const heredocs: Heredoc[] = []
  while (j < s.length) {
    const c = s[j]!
    if (c === "'") {
      const close = s.indexOf("'", j + 1)
      j = close < 0 ? s.length : close + 1
    } else if (c === '"') {
      j = scanDouble(s, j).end
    } else if (c === '`') {
      j = scanBacktick(s, j)
    } else if (c === '\\') {
      j += 2
    } else if (c === '<' && s.startsWith('<<', j) && !s.startsWith('<<<', j)) {
      const r = readHeredocOp(s, j)
      heredocs.push(r.heredoc)
      j = r.end
    } else if (c === '\n') {
      j = skipHeredocBodies(s, j + 1, heredocs)
      heredocs.length = 0
    } else if (c === '(') {
      depth += 1
      j += 1
    } else if (c === ')') {
      depth -= 1
      j += 1
      if (depth === 0) return j
    } else {
      j += 1
    }
  }
  return s.length
}

// i は開きのバッククォートの位置。閉じの次の位置を返す
function scanBacktick(s: string, i: number): number {
  let j = i + 1
  while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1
  return j + 1
}

// i は << の位置。ヒアドキュメントの区切り語と、その次の位置を返す
function readHeredocOp(s: string, i: number): { heredoc: Heredoc; end: number } {
  let j = i + 2
  const strip = s[j] === '-'
  if (strip) j += 1
  while (s[j] === ' ' || s[j] === '\t') j += 1
  let delim = ''
  while (j < s.length && !/[\s;&|()<>]/.test(s[j]!)) {
    if (s[j] !== '"' && s[j] !== "'" && s[j] !== '\\') delim += s[j]
    j += 1
  }
  return { heredoc: { delim, strip }, end: j }
}

// i は改行の次の位置。続くヒアドキュメントの本文を、それぞれの区切り行まで読み飛ばす
function skipHeredocBodies(s: string, i: number, heredocs: Heredoc[]): number {
  let j = i
  for (const h of heredocs) {
    while (j < s.length) {
      const eol = s.indexOf('\n', j)
      const lineEnd = eol < 0 ? s.length : eol
      const line = s.slice(j, lineEnd)
      j = lineEnd + 1
      if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
    }
  }
  return Math.min(j, s.length)
}

// 返答から最初の JSON 値を取り出す。コードブロックで囲まれていてもよい
export function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.search(/[[{]/)
  if (start < 0) return undefined
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, '')
}

// ファイルの一覧を、長くなりすぎないように先頭の 10 件までにして並べる
function listFiles(files: string[], more = (n: number) => ` and ${n} more`): string {
  const shown = files.slice(0, 10).join(', ')
  return files.length > 10 ? `${shown}${more(files.length - 10)}` : shown
}

export function driftDeny(action: Action, findings: Finding[], unchecked: string[] = []): string {
  const lines = findings.map(f => `- ${f.doc}: ${f.issue}${f.fix ? ` (suggested fix: ${f.fix})` : ''}`)
  // 一部を判定できなかったときも、判定できた部分のずれをまとめて伝える
  const partial =
    unchecked.length > 0
      ? ['', `The diff was too large to check in full, so these changed files were not checked: ${listFiles(unchecked)}. The findings above come from the rest of the diff.`]
      : []
  return [
    `docs-sync: ${action.blocked} because the documentation does not match the implementation on this branch.`,
    '',
    'Findings:',
    ...lines,
    ...partial,
    '',
    'What to do:',
    '1. Update the documentation to match the implementation.',
    '2. If the project treats its docs as the spec (e.g. CLAUDE.md says so) and the implementation deviates from that spec, do not edit either side yet: ask the user which one to change.',
    '3. If you think a finding is wrong, explain why to the user and ask how to proceed. Do not try to get around this check.',
    `4. ${action.retry} docs-sync checks the new commit.`,
  ].join('\n')
}

export function splitDeny(action: Action, mover: string): string {
  return [
    `docs-sync: ${action.blocked} because this command runs ${mover} before ${action.command}. docs-sync checks before the command runs, so it cannot see the commits that ${mover} will make or move.`,
    `Run the part up to ${mover} as its own command first, then run ${action.command} as a separate command so that docs-sync can check the commits it sends. Do not try to get around this check.`,
  ].join('\n')
}

export function passNote(action: Action, detail: string): string {
  return `docs-sync: the documentation check ran before this ${action.command} and let it through: ${detail}.`
}

export function failureNote(action: Action, reason: string): string {
  return `docs-sync: the documentation check could not run before this ${action.command} (${reason}), and the user chose to go ahead anyway. The documentation was not verified against the implementation.`
}

export function failureDeny(action: Action, reason: string, hints: Hint[] = []): string {
  return [
    `docs-sync: ${action.blocked} because the documentation check could not run (${reason}).`,
    'This does not mean that the documentation is out of date: docs-sync could not finish the check.',
    '',
    'Tell the user what happened, and offer these options:',
    ...[...hints, BY_HAND].map(h => `- ${h(action)}`),
    '',
    'Do not try to get around this check yourself.',
  ].join('\n')
}

const JUDGE_SYSTEM = `You check whether a branch's documentation still matches its implementation, before a pull request is opened.

You get the branch's diff against its base, and the repository's Markdown documents as of the branch head.

Report a finding only when a document now says something the code no longer does, or misses something it clearly should cover given what the document already covers. Examples:
- A document describes a behavior, option, argument, command, file, or name that the diff changed, renamed, or removed.
- The diff adds a user-facing feature, option, or argument, and a document that lists such things (a usage section, an argument table, an index of components) does not mention it.
- A project rule in the documents (e.g. "update the README list when adding X") requires a document change that the diff does not make.

Do not report:
- Style, wording, typos, or formatting, unless they make a statement wrong.
- Missing documentation for internal details that no document covers at this level.
- Anything unrelated to the diff.

Reply with JSON only, no prose:
{"status":"ok"}
or
{"status":"drift","findings":[{"doc":"<document path, or the path that should be added>","issue":"<what does not match, citing the code>","fix":"<what to change in the document>"}]}`

const SELECT_SYSTEM = `You pick which documents might need an update for a code change.

Reply with a JSON array of document paths only, exactly as listed, no prose. Include project instruction files (such as CLAUDE.md or AGENTS.md) and any document that describes the changed files, their behavior, or lists the components they belong to.`

// 差分を分けて判定するときに、JUDGE_SYSTEM に足す
const JUDGE_PART = `The branch's diff is too large for one check, so it is split into parts, and you get one of them. The other parts are checked separately.
The <changed-files> list covers the whole branch. The documents are as of the branch head, so they already include any documentation changes made in other parts.
Report only findings about the changes in your part of the diff.`

function judgePrompt(docs: Doc[], diff: string, part?: PartContext): string {
  const docBlocks = docs.map(d => `<document path="${d.path}">\n${d.text}\n</document>`).join('\n\n')
  const head = part === undefined ? '' : `<changed-files>\n${part.changed}\n</changed-files>\n\n<part index="${part.index}" of="${part.count}">\n`
  const tail = part === undefined ? '' : '\n</part>'
  return `${head}<diff>\n${diff}\n</diff>${tail}\n\n<documents>\n${docBlocks}\n</documents>`
}

function selectPrompt(docs: Doc[], changed: string): string {
  const list = docs.map(d => `- ${d.path} (${firstHeading(d.text)})`).join('\n')
  return `<changed-files>\n${changed}\n</changed-files>\n\n<documents>\n${list}\n</documents>`
}

function firstHeading(text: string): string {
  return /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? 'no heading'
}

import type { EngineInterface, Register } from 'claude-code'

// 判定の上限。モデルは作業中のセッションと同じものを使う
const MAX_TOKENS = 4096
const JUDGE_TIMEOUT_MS = 5 * 60 * 1000
// 1 回の判定に渡すテキストの上限(文字数)。超えたら関係するドキュメントを先に選ばせる
const PROMPT_BUDGET = 300_000
// 判定の対象にするドキュメント
const DOC_FILE = /\.mdx?$/

const ASK_CONTINUE = 'このまま PR を作成する'
const ASK_CANCEL = '中止する'

type Finding = { doc: string; issue: string; fix: string }
type Verdict = { status: 'ok' } | { status: 'drift'; findings: Finding[] }
type Doc = { path: string; text: string }
// コマンドから読み取った PR 作成の内容
export type PrCreate = { cds: string[]; base?: string; head?: string }

// 判定できなかったことを表す。ユーザーに続けるか聞く
class CheckFailed extends Error {}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const pr = parsePrCreate(e.command)
    if (pr === undefined) return next(e)

    let verdict: Verdict
    try {
      verdict = await check($, pr, next.signal)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return (await confirmAfterFailure($, reason)) ? next(e) : { deny: failureDeny(reason) }
    }

    if (verdict.status === 'ok') return next(e)
    return { deny: driftDeny(verdict.findings) }
  }).catch(async ($, e, next) => {
    // hook 自体が落ちたときは通さない側に倒す
    return { deny: failureDeny(`the docs-sync hook failed (${next.error.kind})`) }
  })
}

// PR に入る内容(base...head の差分)とドキュメントを比べ、結果を返す。判定できなければ CheckFailed を投げる
async function check($: EngineInterface, pr: PrCreate, signal: AbortSignal): Promise<Verdict> {
  const cwd = await resolveCwd($, pr.cds)
  const root = await git($, ['rev-parse', '--show-toplevel'], cwd)
  if (root === undefined) throw new CheckFailed(`not inside a git repository (${cwd})`)

  const head = await resolveHead($, root, pr.head)
  if (head === undefined) throw new CheckFailed(`could not resolve the head ${pr.head ?? 'HEAD'}`)

  const base = await resolveBase($, root, pr.base)
  if (base === undefined) throw new CheckFailed(`could not resolve the base branch ${pr.base ?? ''}`.trim())

  // 同じ base で最後に通ったコミットと同じなら判定し直さない
  const cacheKey = `pass:${root}:${base}`
  if ((await $.store.get(cacheKey)) === head) return { status: 'ok' }

  const diff = await git($, ['diff', '--no-color', `${base}...${head}`], root)
  if (diff === undefined) throw new CheckFailed(`git diff ${base}...${head} failed`)
  if (diff.trim() === '') return { status: 'ok' }
  if (diff.length > PROMPT_BUDGET) throw new CheckFailed('the diff is too large to check')

  const docs = await readDocs($, root, head)
  if (docs.length === 0) return { status: 'ok' }

  // 実装を読む判定なので、作業中のセッションと同じモデルで見る
  const model = await $.session.model()
  const changed = (await git($, ['diff', '--name-only', `${base}...${head}`], root)) ?? ''
  const selected = await selectDocs($, model, docs, diff, changed, signal)
  const verdict = await judge($, model, selected, diff, signal)

  if (verdict.status === 'ok') {
    // 記録できなくても判定結果は変えない(次回また判定するだけ)
    try {
      await $.store.set(cacheKey, head)
    } catch {}
  }
  return verdict
}

// git を cwd で実行し、成功したら stdout を返す
async function git($: EngineInterface, args: string[], cwd: string): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', ...args], { cwd })
    if (r.exitCode !== 0 || r.isStdoutTruncated) return undefined
    return args[0] === 'diff' || args[0] === 'show' ? r.stdout : r.stdout.trim()
  } catch {
    return undefined
  }
}

// コマンド内の cd を順にたどり、gh pr create が実行される場所を求める
async function resolveCwd($: EngineInterface, cds: string[]): Promise<string> {
  let cwd = await $.session.cwd()
  for (const dir of cds) {
    let target = dir
    if (target === '' || target === '~' || target.startsWith('~/')) {
      const home = await $.env.get('HOME')
      if (home === undefined) throw new CheckFailed('could not resolve ~ in cd')
      target = home + target.slice(1)
    }
    cwd = target.startsWith('/') ? target : `${cwd}/${target}`
  }
  return cwd
}

// PR の head のコミット。--head があれば push 済みの origin/<branch> を優先し、なければ HEAD
async function resolveHead($: EngineInterface, root: string, flag: string | undefined): Promise<string | undefined> {
  if (flag === undefined) return git($, ['rev-parse', 'HEAD'], root)
  // fork の `owner:branch` はブランチ名だけを使う
  const branch = flag.includes(':') ? flag.slice(flag.indexOf(':') + 1) : flag
  return firstCommit($, root, [`origin/${branch}`, branch])
}

// --base の指定があれば origin/<base> を優先し、なければ origin の既定ブランチを使う
async function resolveBase($: EngineInterface, root: string, flag: string | undefined): Promise<string | undefined> {
  const candidates = flag !== undefined ? [`origin/${flag}`, flag] : []
  if (flag === undefined) {
    const remoteHead = await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root)
    if (remoteHead !== undefined) candidates.push(remoteHead)
    candidates.push('origin/main', 'main')
  }
  for (const ref of candidates) {
    if ((await git($, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root)) !== undefined) return ref
  }
  return undefined
}

// 候補のうち最初に解決できた ref のコミット
async function firstCommit($: EngineInterface, root: string, refs: string[]): Promise<string | undefined> {
  for (const ref of refs) {
    const sha = await git($, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root)
    if (sha !== undefined) return sha
  }
  return undefined
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

// 予算に収まればすべて渡す。収まらなければ、差分に関係しそうなドキュメントをモデルに選ばせる
async function selectDocs($: EngineInterface, model: string, docs: Doc[], diff: string, changed: string, signal: AbortSignal): Promise<Doc[]> {
  const total = diff.length + docs.reduce((n, d) => n + d.text.length, 0)
  if (total <= PROMPT_BUDGET) return docs

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
  if (!r.isAnswered) throw new CheckFailed(`model call failed (${r.reason})`)

  const wanted = parseJson(r.text)
  if (!Array.isArray(wanted)) throw new CheckFailed('could not read the model reply')
  const names = new Set(wanted.map(p => normalizePath(String(p))))
  const picked = docs.filter(d => names.has(d.path))

  // 予算に入るものだけを渡す。入らない大きなものは飛ばし、後ろのものは続けて入れる
  const out: Doc[] = []
  let used = diff.length
  for (const d of picked) {
    if (used + d.text.length > PROMPT_BUDGET) continue
    out.push(d)
    used += d.text.length
  }
  // 1 件も渡せないなら、ドキュメントなしで「ずれなし」と判定してしまうので、判定できない扱いにする
  if (out.length === 0) throw new CheckFailed('no documents could be selected for the check')
  return out
}

async function judge($: EngineInterface, model: string, docs: Doc[], diff: string, signal: AbortSignal): Promise<Verdict> {
  const r = await $.model.complete(
    {
      model,
      system: JUDGE_SYSTEM,
      prompt: judgePrompt(docs, diff),
      maxTokens: MAX_TOKENS,
      timeoutMs: JUDGE_TIMEOUT_MS,
    },
    { signal },
  )
  if (!r.isAnswered) throw new CheckFailed(`model call failed (${r.reason})`)

  const v = parseJson(r.text) as { status?: unknown; findings?: unknown } | undefined
  if (v?.status === 'ok') return { status: 'ok' }
  if (v?.status === 'drift' && Array.isArray(v.findings) && v.findings.length > 0) {
    const findings = v.findings.map(f => ({
      doc: String(f?.doc ?? ''),
      issue: String(f?.issue ?? ''),
      fix: String(f?.fix ?? ''),
    }))
    return { status: 'drift', findings }
  }
  throw new CheckFailed('could not read the model reply')
}

// 判定できなかったとき、続けるかをユーザーに聞く。答えられない(-p 実行・閉じた)ときは中止
async function confirmAfterFailure($: EngineInterface, reason: string): Promise<boolean> {
  try {
    const answer = await $.ui.ask(
      `docs-sync: 実装とドキュメントの差異を確認できませんでした(${reason})。このまま PR を作成しますか?`,
      { header: 'docs-sync', options: [ASK_CONTINUE, ASK_CANCEL] },
    )
    return answer === ASK_CONTINUE
  } catch {
    return false
  }
}

// コマンドが gh pr create を実行するなら、その内容を返す。引用符やヒアドキュメントの中の文字列には反応しない
export function parsePrCreate(command: string): PrCreate | undefined {
  const cds: string[] = []
  for (const segment of splitCommand(command)) {
    // 先頭の `NAME=value` は環境変数の指定なので飛ばす
    const start = segment.findIndex(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
    const words = start < 0 ? [] : segment.slice(start)
    if (words[0] === 'cd') {
      if (words[1] !== '-') cds.push(words[1] ?? '')
      continue
    }
    if (words[0] !== 'gh' || words[1] !== 'pr' || words[2] !== 'create') continue
    const args = words.slice(3)
    if (args.includes('--help') || args.includes('-h')) return undefined
    return { cds, base: flagValue(args, '--base', '-B'), head: flagValue(args, '--head', '-H') }
  }
  return undefined
}

// `--name value` / `--name=value` / `-x value` / `-xvalue` の値を返す
function flagValue(args: string[], long: string, short: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === long || a === short) return args[i + 1]
    if (a.startsWith(`${long}=`)) return a.slice(long.length + 1)
    if (a.startsWith(short) && a.length > short.length && !a.startsWith('--')) return a.slice(short.length)
  }
  return undefined
}

// シェルのコマンドを、&& ; | ( ) 改行で区切られた単語の列に分ける。
// 引用符は外して 1 つの単語にし、ヒアドキュメントの本文とコメントは読み飛ばす
export function splitCommand(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  const heredocs: { delim: string; strip: boolean }[] = []

  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
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
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) {
          word += command[j + 1]
          j += 2
        } else {
          word += command[j]
          j += 1
        }
      }
      inWord = true
      i = j + 1
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
      i += 1
      // 改行のあとはヒアドキュメントの本文。終わりの行まで読み飛ばす
      for (const h of heredocs) {
        while (i < command.length) {
          const eol = command.indexOf('\n', i)
          const lineEnd = eol < 0 ? command.length : eol
          const line = command.slice(i, lineEnd)
          i = lineEnd + 1
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
        }
      }
      heredocs.length = 0
    } else if (c === '<' && command.startsWith('<<', i) && !command.startsWith('<<<', i)) {
      endWord()
      i += 2
      const strip = command[i] === '-'
      if (strip) i += 1
      while (command[i] === ' ' || command[i] === '\t') i += 1
      let delim = ''
      while (i < command.length && !/[\s;&|()<>]/.test(command[i]!)) {
        if (command[i] !== '"' && command[i] !== "'") delim += command[i]
        i += 1
      }
      heredocs.push({ delim, strip })
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

export function driftDeny(findings: Finding[]): string {
  const lines = findings.map(f => `- ${f.doc}: ${f.issue}${f.fix ? ` (suggested fix: ${f.fix})` : ''}`)
  return [
    'docs-sync: PR creation was blocked because the documentation does not match the implementation on this branch.',
    '',
    'Findings:',
    ...lines,
    '',
    'What to do:',
    '1. Update the documentation to match the implementation.',
    '2. If the project treats its docs as the spec (e.g. CLAUDE.md says so) and the implementation deviates from that spec, do not edit either side yet: ask the user which one to change.',
    '3. If you think a finding is wrong, explain why to the user and ask how to proceed. Do not try to get around this check.',
    '4. Commit the fixes, push them, and run gh pr create again. docs-sync checks the new commit.',
  ].join('\n')
}

export function failureDeny(reason: string): string {
  return [
    `docs-sync: PR creation was blocked because the documentation check could not run (${reason}).`,
    'Tell the user what happened and ask how to proceed. Do not try to get around this check.',
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

function judgePrompt(docs: Doc[], diff: string): string {
  const docBlocks = docs.map(d => `<document path="${d.path}">\n${d.text}\n</document>`).join('\n\n')
  return `<diff>\n${diff}\n</diff>\n\n<documents>\n${docBlocks}\n</documents>`
}

function selectPrompt(docs: Doc[], changed: string): string {
  const list = docs.map(d => `- ${d.path} (${firstHeading(d.text)})`).join('\n')
  return `<changed-files>\n${changed}\n</changed-files>\n\n<documents>\n${list}\n</documents>`
}

function firstHeading(text: string): string {
  return /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? 'no heading'
}

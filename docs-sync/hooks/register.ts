import type { EngineInterface, Register } from 'claude-code'

// PR 作成とみなすコマンド。`git push && gh pr create ...` のような連結も拾う
const PR_CREATE = /(^|[\s;&|(])gh\s+pr\s+create(\s|$)/
// 判定の上限。モデルは作業中のセッションと同じものを使う
const MAX_TOKENS = 4096
const JUDGE_TIMEOUT_MS = 5 * 60 * 1000
// 1 回の判定に渡すテキストの上限(文字数)。超えたら関係するドキュメントを先に選ばせる
const PROMPT_BUDGET = 300_000
// 判定の対象にするドキュメント
const DOC_PATHSPECS = ['*.md', '*.mdx']

const ASK_CONTINUE = 'このまま PR を作成する'
const ASK_CANCEL = '中止する'

type Finding = { doc: string; issue: string; fix: string }
type Verdict = { status: 'ok' } | { status: 'drift'; findings: Finding[] }
type Doc = { path: string; text: string }

// 判定できなかったことを表す。ユーザーに続けるか聞く
class CheckFailed extends Error {}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!PR_CREATE.test(e.command)) return next(e)

    let verdict: Verdict
    try {
      verdict = await check($, e.command, next.signal)
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

// ブランチの差分とドキュメントを比べ、結果を返す。判定できなければ CheckFailed を投げる
async function check($: EngineInterface, command: string, signal: AbortSignal): Promise<Verdict> {
  const root = await git($, ['rev-parse', '--show-toplevel'], await $.session.cwd())
  if (root === undefined) throw new CheckFailed('not inside a git repository')

  const head = await git($, ['rev-parse', 'HEAD'], root)
  if (head === undefined) throw new CheckFailed('could not resolve HEAD')

  const base = await resolveBase($, root, parseBaseFlag(command))
  if (base === undefined) throw new CheckFailed('could not resolve the base branch; pass --base')

  // 同じコミット・同じ base で一度通ったものは判定し直さない
  const cacheKey = `pass:${root}:${base}:${head}`
  if ((await $.store.get(cacheKey)) === true) return { status: 'ok' }

  const diff = await git($, ['diff', '--no-color', `${base}...HEAD`], root)
  if (diff === undefined) throw new CheckFailed(`git diff ${base}...HEAD failed`)
  if (diff.trim() === '') return { status: 'ok' }
  if (diff.length > PROMPT_BUDGET) throw new CheckFailed('the diff is too large to check')

  const docs = await readDocs($, root)
  if (docs.length === 0) return { status: 'ok' }

  // 実装を読む判定なので、作業中のセッションと同じモデルで見る
  const model = await $.session.model()
  const changed = (await git($, ['diff', '--name-only', `${base}...HEAD`], root)) ?? ''
  const selected = await selectDocs($, model, docs, diff, changed, signal)
  const verdict = await judge($, model, selected, diff, signal)

  if (verdict.status === 'ok') await $.store.set(cacheKey, true)
  return verdict
}

// git を root で実行し、成功したら stdout を返す
async function git($: EngineInterface, args: string[], cwd: string): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', ...args], { cwd })
    if (r.exitCode !== 0 || r.isStdoutTruncated) return undefined
    return args[0] === 'diff' || args[0] === 'show' ? r.stdout : r.stdout.trim()
  } catch {
    return undefined
  }
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

// HEAD 時点のドキュメントを読む。PR に入るのはコミット済みの内容なので、作業ツリーではなく HEAD から読む
async function readDocs($: EngineInterface, root: string): Promise<Doc[]> {
  const list = await git($, ['ls-files', '--', ...DOC_PATHSPECS], root)
  if (list === undefined) throw new CheckFailed('git ls-files failed')
  const paths = list.split('\n').filter(p => p !== '')
  const docs: Doc[] = []
  for (const path of paths) {
    const text = await git($, ['show', `HEAD:${path}`], root)
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
  const picked = docs.filter(d => wanted.includes(d.path))

  // 選ばれたものでも予算を超えるなら、先頭から入る分だけにする
  const out: Doc[] = []
  let used = diff.length
  for (const d of picked) {
    if (used + d.text.length > PROMPT_BUDGET) break
    out.push(d)
    used += d.text.length
  }
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

// --base / -B の値を取り出す
export function parseBaseFlag(command: string): string | undefined {
  const m = /(?:--base(?:=|\s+)|-B\s+)(["']?)([^\s"']+)\1/.exec(command)
  return m?.[2]
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

Reply with a JSON array of document paths only, no prose. Include project instruction files (such as CLAUDE.md or AGENTS.md) and any document that describes the changed files, their behavior, or lists the components they belong to.`

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

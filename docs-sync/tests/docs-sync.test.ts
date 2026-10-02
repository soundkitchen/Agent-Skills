import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { parseBaseFlag, parseJson } from '../hooks/register.ts'

const ROOT = '/repo'
const HEAD = 'abc123'
const SESSION_MODEL = 'claude-opus-5-5'

type Model = (prompt: string) => { text: string } | { reason: 'empty-reply' }

// git と model を差し替え、Bash の実行は「走った」ことだけを記録する
function world(on: On, opts: { diff?: string; docs?: Record<string, string>; model: Model }) {
  const docs = opts.docs ?? { 'README.md': '# Tool\n\nRun `tool --fast`.\n' }
  const calls = { model: 0, models: [] as string[], ran: [] as string[] }

  mock.store(on)
  on('session.cwd', async () => ({ value: ROOT }))
  on('session.model', async () => ({ value: SESSION_MODEL }))

  on('process.run', async ($, e) => {
    const [cmd, ...args] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const fail = { value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd !== 'git') return fail
    const sub = args.join(' ')
    if (sub === 'rev-parse --show-toplevel') return ok(`${ROOT}\n`)
    if (sub === 'rev-parse HEAD') return ok(`${HEAD}\n`)
    if (sub === 'symbolic-ref --short refs/remotes/origin/HEAD') return ok('origin/main\n')
    if (sub.startsWith('rev-parse --verify --quiet origin/main')) return ok('deadbeef\n')
    if (sub.startsWith('rev-parse --verify --quiet')) return fail
    if (sub === 'diff --no-color origin/main...HEAD') return ok(opts.diff ?? '+ renamed --fast to --quick\n')
    if (sub === 'diff --name-only origin/main...HEAD') return ok('src/cli.ts\n')
    if (sub.startsWith('ls-files')) return ok(Object.keys(docs).join('\n') + '\n')
    if (args[0] === 'show') {
      const path = args[1]!.replace(/^HEAD:/, '')
      return path in docs ? ok(docs[path]!) : fail
    }
    return fail
  })

  on('model.complete', async ($, e) => {
    calls.model += 1
    calls.models.push(e.model)
    const r = opts.model(e.prompt)
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return 'text' in r
      ? { value: { isAnswered: true, text: r.text, usage } }
      : { value: { isAnswered: false, reason: r.reason, usage } }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    calls.ran.push(e.command)
    return { result: { stdout: 'ran', stderr: '' } }
  })

  return calls
}

const OK: Model = () => ({ text: '{"status":"ok"}' })
const DRIFT: Model = () => ({
  text: '```json\n{"status":"drift","findings":[{"doc":"README.md","issue":"says --fast but the CLI now takes --quick","fix":"rename --fast to --quick"}]}\n```',
})

describe('docs-sync', () => {
  test('passes commands other than gh pr create without checking', async ($, on) => {
    const calls = world(on, { model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr view' })
    expect(r.deny).toBe(undefined)
    expect(calls.ran).toEqual(['gh pr view'])
    expect(calls.model).toBe(0)
  })

  test('lets gh pr create run when the docs match, and remembers the commit', async ($, on) => {
    const calls = world(on, { model: OK })
    await $.tool.call({ tool: 'Bash', command: 'git push && gh pr create --fill' })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran.length).toBe(2)
    expect(calls.model).toBe(1)
    expect(calls.models).toEqual([SESSION_MODEL])
  })

  test('blocks gh pr create with the findings when the docs drift', async ($, on) => {
    const calls = world(on, { model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(r.deny).toContain('README.md: says --fast but the CLI now takes --quick')
    expect(r.deny).toContain('ask the user which one to change')
    expect(calls.ran).toEqual([])
  })

  test('checks again after a blocked attempt', async ($, on) => {
    const calls = world(on, { model: DRIFT })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.model).toBe(2)
  })

  test('passes without a model call when the branch has no diff', async ($, on) => {
    const calls = world(on, { diff: '', model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran.length).toBe(1)
    expect(calls.model).toBe(0)
  })

  test('blocks when the check fails and nobody can answer the question', async ($, on) => {
    const calls = world(on, { model: () => ({ reason: 'empty-reply' }) })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(r.deny).toContain('could not run')
    expect(calls.ran).toEqual([])
  })

  test('runs gh pr create when the check fails and the user chooses to continue', async ($, on) => {
    const calls = world(on, { model: () => ({ text: 'not json' }) })
    on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
      const question = e.questions[0]!.question
      return { result: { questions: e.questions, answers: { [question]: 'このまま PR を作成する' } } }
    })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran).toEqual(['gh pr create --fill'])
  })

  test('blocks when the check fails and the user cancels', async ($, on) => {
    const calls = world(on, { model: () => ({ text: 'not json' }) })
    on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
      const question = e.questions[0]!.question
      return { result: { questions: e.questions, answers: { [question]: '中止する' } } }
    })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(r.deny).toBeTruthy()
    expect(calls.ran).toEqual([])
  })
})

describe('parseBaseFlag', () => {
  test('reads --base and -B in their forms', async () => {
    expect(parseBaseFlag('gh pr create --base develop --fill')).toBe('develop')
    expect(parseBaseFlag('gh pr create --base=release/1.0')).toBe('release/1.0')
    expect(parseBaseFlag("gh pr create -B 'main'")).toBe('main')
    expect(parseBaseFlag('gh pr create --fill')).toBe(undefined)
  })
})

describe('parseJson', () => {
  test('reads JSON with or without a code fence', async () => {
    expect(parseJson('{"status":"ok"}')).toEqual({ status: 'ok' })
    expect(parseJson('Here:\n```json\n["a.md"]\n```')).toEqual(['a.md'])
    expect(parseJson('no json here')).toBe(undefined)
  })
})

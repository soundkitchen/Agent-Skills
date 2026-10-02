import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { parseJson, parsePrCreate, splitCommand } from '../hooks/register.ts'

const ROOT = '/repo'
const HEAD = 'abc123'
const FEATURE_HEAD = 'f00d42'
const SESSION_MODEL = 'claude-opus-5-5'

type Model = (prompt: string) => { text: string } | { reason: 'empty-reply' }

// git と model を差し替え、Bash の実行は「走った」ことだけを記録する
function world(on: On, opts: { diff?: string; docs?: Record<string, string>; model: Model }) {
  const docs = opts.docs ?? { 'README.md': '# Tool\n\nRun `tool --fast`.\n' }
  const calls = { model: 0, models: [] as string[], ran: [] as string[], git: [] as string[], cwds: [] as string[] }

  mock.store(on)
  on('session.cwd', async () => ({ value: ROOT }))
  on('session.model', async () => ({ value: SESSION_MODEL }))

  on('process.run', async ($, e) => {
    const [cmd, ...args] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const fail = { value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd !== 'git') return fail
    const sub = args.join(' ')
    calls.git.push(sub)
    if (sub === 'rev-parse --show-toplevel') {
      calls.cwds.push(e.init?.cwd ?? '')
      return ok(`${e.init?.cwd?.endsWith('/other') ? '/other' : ROOT}\n`)
    }
    if (sub === 'rev-parse HEAD') return ok(`${HEAD}\n`)
    if (sub === 'symbolic-ref --short refs/remotes/origin/HEAD') return ok('origin/main\n')
    if (sub === 'rev-parse --verify --quiet origin/main^{commit}') return ok('deadbeef\n')
    if (sub === 'rev-parse --verify --quiet origin/feature/x^{commit}') return ok(`${FEATURE_HEAD}\n`)
    if (sub.startsWith('rev-parse --verify --quiet')) return fail
    if (/^diff --no-color origin\/main\.\.\.\w+$/.test(sub)) return ok(opts.diff ?? '+ renamed --fast to --quick\n')
    if (/^diff --name-only origin\/main\.\.\.\w+$/.test(sub)) return ok('src/cli.ts\n')
    if (sub.startsWith('ls-tree -r --name-only')) return ok([...Object.keys(docs), 'src/cli.ts'].join('\n') + '\n')
    if (args[0] === 'show') {
      const path = args[1]!.replace(/^\w+:/, '')
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

  test('ignores gh pr create inside quotes, such as a review comment body', async ($, on) => {
    const calls = world(on, { model: DRIFT })
    const command = 'gh api repos/o/r/pulls/5/reviews -f body="docs-sync blocks gh pr create --base main"'
    await $.tool.call({ tool: 'Bash', command })
    expect(calls.ran).toEqual([command])
    expect(calls.git).toEqual([])
  })

  test('ignores gh pr create inside a heredoc, such as a commit message', async ($, on) => {
    const calls = world(on, { model: DRIFT })
    const command = "git commit -F - <<'EOF'\nfix: handle\ngh pr create --base main\nEOF"
    await $.tool.call({ tool: 'Bash', command })
    expect(calls.ran).toEqual([command])
    expect(calls.git).toEqual([])
  })

  test('does not check gh pr create --help', async ($, on) => {
    const calls = world(on, { model: DRIFT })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --help' })
    expect(calls.ran.length).toBe(1)
    expect(calls.git).toEqual([])
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

  test('does not take git checkout -B as the base branch', async ($, on) => {
    const calls = world(on, { model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'git checkout -B fix/foo && git push -u origin fix/foo && gh pr create --fill' })
    expect(r.deny).toContain('README.md')
    expect(calls.git).toContain(`diff --no-color origin/main...${HEAD}`)
  })

  test('checks the repository that a cd in the command moves to', async ($, on) => {
    const calls = world(on, { model: OK })
    await $.tool.call({ tool: 'Bash', command: 'cd ../other && gh pr create --fill' })
    expect(calls.cwds).toEqual([`${ROOT}/../other`])
  })

  test('checks the branch given with --head instead of HEAD', async ($, on) => {
    const calls = world(on, { model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --head feature/x --fill' })
    expect(calls.git).toContain(`diff --no-color origin/main...${FEATURE_HEAD}`)
  })

  test('passes without a model call when the branch has no diff', async ($, on) => {
    const calls = world(on, { diff: '', model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran.length).toBe(1)
    expect(calls.model).toBe(0)
  })

  test('does not pass when no document is selected for a large repository', async ($, on) => {
    const calls = world(on, {
      docs: { 'README.md': '# Big\n' + 'x'.repeat(310_000) },
      model: prompt => (prompt.includes('<changed-files>') ? { text: '[]' } : { text: '{"status":"ok"}' }),
    })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(r.deny).toContain('no documents could be selected')
    expect(calls.ran).toEqual([])
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

describe('parsePrCreate', () => {
  test('reads --base and --head only from the gh pr create part', async () => {
    expect(parsePrCreate('gh pr create --base develop --fill')).toEqual({ cds: [], base: 'develop', head: undefined })
    expect(parsePrCreate('gh pr create --base=release/1.0 -H feat')).toEqual({ cds: [], base: 'release/1.0', head: 'feat' })
    expect(parsePrCreate("gh pr create -B 'main'")).toEqual({ cds: [], base: 'main', head: undefined })
    expect(parsePrCreate('git checkout -B x && gh pr create --body "use --base y"')).toEqual({ cds: [], base: undefined, head: undefined })
    expect(parsePrCreate('cd a && cd b; GH_HOST=x gh pr create')).toEqual({ cds: ['a', 'b'], base: undefined, head: undefined })
  })

  test('reads flags after a $(cat <<EOF ...) body that holds a double quote', async () => {
    const command = `gh pr create --title "t" --body "$(cat <<'EOF'\n画面は 27" 以上を想定 (例)\nEOF\n)" --base develop`
    expect(parsePrCreate(command)).toEqual({ cds: [], base: 'develop', head: undefined })
    const unquoted = `gh pr create --body $(cat <<'EOF'\n27" --base wrong\nEOF\n) -B develop`
    expect(parsePrCreate(unquoted)).toEqual({ cds: [], base: 'develop', head: undefined })
    expect(parsePrCreate('gh pr create --body "`date` \\"x\\"" --base develop')).toEqual({ cds: [], base: 'develop', head: undefined })
  })

  test('finds gh pr create run inside $(...) or backticks', async () => {
    expect(parsePrCreate('PR_URL=$(gh pr create --fill --base develop) && echo "$PR_URL"')).toEqual({ cds: [], base: 'develop', head: undefined })
    expect(parsePrCreate('echo "created: $(gh pr create --fill)"')).toEqual({ cds: [], base: undefined, head: undefined })
    expect(parsePrCreate('url=`gh pr create --fill -B develop`')).toEqual({ cds: [], base: 'develop', head: undefined })
    expect(parsePrCreate('gh pr view "$(gh pr create --fill)" --web')).toEqual({ cds: [], base: undefined, head: undefined })
  })

  test('does not find gh pr create in a heredoc body inside $(...)', async () => {
    expect(parsePrCreate(`echo --body "$(cat <<'EOF'\ngh pr create --base x\nEOF\n)"`)).toBe(undefined)
    expect(parsePrCreate(`gh pr view --body "$(cat <<'EOF'\ngh pr create --base x\nEOF\n)"`)).toBe(undefined)
  })

  test('finds gh pr create behind env, command, time, nohup and exec', async () => {
    for (const prefix of ['env GH_HOST=x', 'env -i -u FOO --', 'command', 'time -p', 'nohup', 'exec', 'A=1 env B=2 time']) {
      expect(parsePrCreate(`${prefix} gh pr create --fill`)).toEqual({ cds: [], base: undefined, head: undefined })
    }
  })

  test('does not read the values of other flags as --base or --head', async () => {
    expect(parsePrCreate('gh pr create --title "-Hotfix" --fill')).toEqual({ cds: [], base: undefined, head: undefined })
    expect(parsePrCreate('gh pr create -b "-Bump deps" -t -h')).toEqual({ cds: [], base: undefined, head: undefined })
    expect(parsePrCreate('gh pr create -dBmain -Hfeat')).toEqual({ cds: [], base: 'main', head: 'feat' })
    expect(parsePrCreate('gh pr create -B=main --head=feat')).toEqual({ cds: [], base: 'main', head: 'feat' })
  })

  test('returns nothing when gh pr create is not run', async () => {
    expect(parsePrCreate('echo "gh pr create"')).toBe(undefined)
    expect(parsePrCreate('gh pr create --help')).toBe(undefined)
    expect(parsePrCreate('gh pr view 5')).toBe(undefined)
  })
})

describe('splitCommand', () => {
  test('splits on operators and keeps quoted text as one word', async () => {
    expect(splitCommand(`a "b c" 'd' && e | f; g\nh # i`)).toEqual([['a', 'b c', 'd'], ['e'], ['f'], ['g'], ['h']])
  })

  test('skips heredoc bodies', async () => {
    expect(splitCommand('cat <<-EOF > x\n\tgh pr create\n\tEOF\nnext')).toEqual([['cat', '>', 'x'], ['next']])
  })
})

describe('parseJson', () => {
  test('reads JSON with or without a code fence', async () => {
    expect(parseJson('{"status":"ok"}')).toEqual({ status: 'ok' })
    expect(parseJson('Here:\n```json\n["a.md"]\n```')).toEqual(['a.md'])
    expect(parseJson('no json here')).toBe(undefined)
  })
})

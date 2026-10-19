import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { joinDir, parseJson, parsePrCreate, parsePush, repoOf, splitCommand } from '../hooks/register.ts'

// 区切りごとの単語だけを取り出す(置換の中は含めない)
const wordsOf = (command: string) => splitCommand(command).map(s => s.words)

const ROOT = '/repo'
const HEAD = 'abc123'
const FEATURE_HEAD = 'f00d42'
const SESSION_MODEL = 'claude-opus-5-5'

type Model = (prompt: string) => { text: string } | { reason: 'empty-reply' }
// PR の head のリポジトリは、owner を省略すると o/r。PR を出した先のリポジトリは o/r
type Pr = { number: number; state: string; baseRefName: string; headRefName: string; owner?: string }
// fork の構成。origin が自分の fork(me/r)、upstream が元のリポジトリ(o/r)
const FORK_REMOTES = { origin: 'git@github.com:me/r.git', upstream: 'https://github.com/o/r.git' }
const OPEN_PR: Pr = { number: 5, state: 'OPEN', baseRefName: 'main', headRefName: 'fix/foo' }

// git・gh と model を差し替え、Bash の実行は「走った」ことだけを記録する。
// 今のブランチは fix/foo(upstream は origin/fix/foo)。remote は、remotes を省略すると origin(o/r)と fork(me/r)。
// prs は GitHub にある PR で、gh pr list --state open は開いているものだけを返す。
// gh repo view は、-R の指定がなければ o/r を返す(既定のブランチは defaultBranch、省略すると main)。ghRepoFails なら失敗する。
// unfetched なら upstream/main はまだ fetch していない。partial は partial clone の remote の名前
// files はファイルごとの差分(差分全体はそれをつなげたもの)。binary はバイナリ、generated は linguist-generated のファイル。
// truncated なら、差分全体の出力が 4 MiB を超えて切れる。unreadable はファイルごとの差分を取れないファイル
function world(
  on: On,
  opts: {
    cwd?: string
    diff?: string
    docs?: Record<string, string>
    prs?: Pr[]
    remotes?: Record<string, string>
    defaultBranch?: string
    ghRepoFails?: boolean
    unfetched?: boolean
    partial?: string
    files?: Record<string, string>
    binary?: string[]
    generated?: string[]
    truncated?: boolean
    unreadable?: string[]
    model: Model
  },
) {
  const remotes = opts.remotes ?? { origin: 'git@github.com:o/r.git', fork: 'https://github.com/me/r.git' }
  const docs = opts.docs ?? { 'README.md': '# Tool\n\nRun `tool --fast`.\n' }
  const calls = { model: 0, models: [] as string[], ran: [] as string[], git: [] as string[], gh: [] as string[], cwds: [] as string[] }

  mock.store(on)
  on('session.cwd', async () => ({ value: opts.cwd ?? ROOT }))
  on('session.model', async () => ({ value: SESSION_MODEL }))

  on('process.run', async ($, e) => {
    const [cmd, ...args] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const fail = { value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'gh') {
      calls.gh.push(args.join(' '))
      if (args[0] === 'repo' && args[1] === 'view') {
        if (opts.ghRepoFails === true) return fail
        const repo = args[2]!.startsWith('--') ? 'o/r' : args[2]!
        return ok(JSON.stringify({ nameWithOwner: repo, defaultBranchRef: { name: opts.defaultBranch ?? 'main' } }))
      }
      if (args[0] !== 'pr' || args[1] !== 'list') return fail
      const open = (opts.prs ?? []).filter(pr => pr.state === 'OPEN').map(pr => ({
        number: pr.number,
        url: `https://github.com/o/r/pull/${pr.number}`,
        baseRefName: pr.baseRefName,
        headRefName: pr.headRefName,
        headRepository: { name: 'r' },
        headRepositoryOwner: { login: pr.owner ?? 'o' },
      }))
      return ok(JSON.stringify(open))
    }
    if (cmd !== 'git') return fail
    const sub = args.join(' ')
    calls.git.push(sub)
    if (sub === 'rev-parse --show-toplevel') {
      calls.cwds.push(e.init?.cwd ?? '')
      // 展開されていない変数を含む場所は、リポジトリとして見つからない
      if (e.init?.cwd?.includes('$') === true) return fail
      return ok(`${e.init?.cwd?.endsWith('/other') ? '/other' : ROOT}\n`)
    }
    if (sub === 'rev-parse HEAD') return ok(`${HEAD}\n`)
    if (sub === 'symbolic-ref --short --quiet HEAD') return ok('fix/foo\n')
    if (sub === 'config branch.fix/foo.remote') return ok('origin\n')
    if (sub === 'config branch.fix/foo.merge') return ok('refs/heads/fix/foo\n')
    // partial clone の remote は、fetch の行末に [blob:none] が付く
    if (sub === 'remote -v') {
      return ok(Object.entries(remotes).map(([n, u]) => `${n}\t${u} (fetch)${opts.partial === n ? ' [blob:none]' : ''}\n${n}\t${u} (push)\n`).join(''))
    }
    const url = /^remote get-url --push (\S+)$/.exec(sub)
    if (url !== null) return url[1]! in remotes ? ok(`${remotes[url[1]!]}\n`) : fail
    if (sub === 'rev-parse --verify --quiet HEAD^{commit}') return ok(`${HEAD}\n`)
    if (sub === 'rev-parse --verify --quiet fix/foo^{commit}') return ok(`${HEAD}\n`)
    if (sub === 'symbolic-ref --short refs/remotes/origin/HEAD' && 'origin' in remotes) return ok('origin/main\n')
    if (sub === 'rev-parse --verify --quiet origin/main^{commit}') return ok('deadbeef\n')
    if (sub === 'rev-parse --verify --quiet upstream/main^{commit}' && 'upstream' in remotes && opts.unfetched !== true) return ok('cafe00\n')
    if (sub === 'rev-parse --verify --quiet origin/feature/x^{commit}') return ok(`${FEATURE_HEAD}\n`)
    if (sub.startsWith('rev-parse --verify --quiet')) return fail
    if (/^diff --no-color (origin|upstream)\/main\.\.\.\w+$/.test(sub)) {
      if (opts.truncated === true) return { value: { ...ok('+ cut').value, isStdoutTruncated: true } }
      return ok(opts.diff ?? (opts.files !== undefined ? Object.values(opts.files).join('') : '+ renamed --fast to --quick\n'))
    }
    if (/^diff --numstat -z (--no-renames )?\S+$/.test(sub)) {
      return ok(Object.keys(opts.files ?? {}).map(f => `${opts.binary?.includes(f) === true ? '-\t-' : '1\t0'}\t${f}\0`).join(''))
    }
    const one = /^diff --no-color --no-renames \S+ -- :\(literal\)(.+)$/.exec(sub)
    if (one !== null) return opts.unreadable?.includes(one[1]!) === true ? fail : ok(opts.files?.[one[1]!] ?? '')
    if (args[0] === 'check-attr') {
      const paths = (e.init?.stdin ?? '').split('\0').filter(f => f !== '')
      const generated = (f: string) => (opts.generated?.includes(f) === true ? 'set' : 'unspecified')
      return ok(paths.flatMap(f => [f, 'linguist-generated', generated(f), f, 'linguist-vendored', 'unspecified']).join('\0') + '\0')
    }
    if (/^diff --name-only (origin|upstream)\/main\.\.\.\w+$/.test(sub)) return ok('src/cli.ts\n')
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

  test('tells Claude that the check ran and found no mismatch', async ($, on) => {
    world(on, { model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(r.deny).toBe(undefined)
    expect(r.context?.length).toBe(1)
    expect(r.context?.[0]).toContain('docs-sync: the documentation check ran')
    expect(r.context?.[0]).toContain('against 1 of 1 documents and found no mismatch')
  })

  test('tells Claude when the commit already passed and was not checked again', async ($, on) => {
    world(on, { model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(r.context?.[0]).toContain(`commit ${HEAD} already passed the check against origin/main`)
  })

  test('does not add a note to commands other than gh pr create', async ($, on) => {
    world(on, { model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr view' })
    expect(r.context).toBe(undefined)
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

  test('does not take -B of another command as the base branch', async ($, on) => {
    const calls = world(on, { model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'git diff -B --stat && git push -u origin fix/foo && gh pr create --fill' })
    expect(r.deny).toContain('README.md')
    expect(calls.git).toContain(`diff --no-color origin/main...${HEAD}`)
  })

  test('checks the repository that a cd in the command moves to', async ($, on) => {
    const calls = world(on, { model: OK })
    await $.tool.call({ tool: 'Bash', command: 'cd ../other && gh pr create --fill' })
    expect(calls.cwds).toEqual([`${ROOT}/../other`])
  })

  test('treats a Windows drive path after cd as absolute', async ($, on) => {
    const calls = world(on, { cwd: 'D:\\works\\hogehoge', model: OK })
    await $.tool.call({ tool: 'Bash', command: 'cd D:/works/hogehoge && gh pr create --base main --fill' })
    expect(calls.cwds).toEqual(['D:/works/hogehoge'])
    expect(calls.ran).toHaveLength(1)
  })

  test('follows a chain of cd on Windows, decided by the session cwd', async ($, on) => {
    const calls = world(on, { cwd: 'D:\\works\\a', model: OK })
    await $.tool.call({ tool: 'Bash', command: 'cd /usr/local && cd D:/repo && cd sub && gh pr create --fill' })
    expect(calls.cwds).toEqual(['D:/repo/sub'])
  })

  test('turns a Git Bash /d/... path after cd into a drive path', async ($, on) => {
    const calls = world(on, { cwd: 'C:\\Users\\me', model: OK })
    await $.tool.call({ tool: 'Bash', command: 'cd /d/works/repo && gh pr create --fill' })
    expect(calls.cwds).toEqual(['D:/works/repo'])
  })

  test('resolves cd ~ on Windows with HOME', async ($, on) => {
    const calls = world(on, { cwd: 'D:\\works\\a', model: OK })
    mock.env(on, { HOME: 'C:\\Users\\me' })
    await $.tool.call({ tool: 'Bash', command: 'cd ~/repo && gh pr create --fill' })
    expect(calls.cwds).toEqual(['C:/Users/me/repo'])
  })

  test('takes the base from the remote of the repository the PR goes to, such as upstream in a fork', async ($, on) => {
    const calls = world(on, { remotes: FORK_REMOTES, model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.git).toContain(`diff --no-color upstream/main...${HEAD}`)
  })

  test('passes -R to gh repo view to find the repository the PR goes to', async ($, on) => {
    const calls = world(on, { remotes: FORK_REMOTES, model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create -R o/r --base main --fill' })
    expect(calls.gh).toEqual(['repo view o/r --json nameWithOwner,defaultBranchRef'])
    expect(calls.git).toContain(`diff --no-color upstream/main...${HEAD}`)
  })

  test('uses origin when -R points to the repository origin points to', async ($, on) => {
    const calls = world(on, { remotes: FORK_REMOTES, model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create -R me/r --fill' })
    expect(calls.gh).toEqual(['repo view me/r --json nameWithOwner,defaultBranchRef'])
    expect(calls.git).toContain(`diff --no-color origin/main...${HEAD}`)
  })

  test('falls back to origin when gh repo view fails', async ($, on) => {
    const calls = world(on, { remotes: FORK_REMOTES, ghRepoFails: true, model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.git).toContain(`diff --no-color origin/main...${HEAD}`)
  })

  test('falls back to origin/<base> when the upstream base is not fetched yet', async ($, on) => {
    const calls = world(on, { remotes: FORK_REMOTES, unfetched: true, model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.git).toContain(`diff --no-color origin/main...${HEAD}`)
  })

  test('does not ask gh for the repository when there is only one remote', async ($, on) => {
    const calls = world(on, { remotes: { origin: 'git@github.com:o/r.git' }, model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.gh).toEqual([])
    expect(calls.git).toContain(`diff --no-color origin/main...${HEAD}`)
  })

  test('uses the only remote even when it is not named origin', async ($, on) => {
    const calls = world(on, { remotes: { upstream: 'https://github.com/o/r.git' }, model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.gh).toEqual([])
    expect(calls.git).toContain(`diff --no-color upstream/main...${HEAD}`)
  })

  test('counts a partial clone remote, whose line in git remote -v has [blob:none]', async ($, on) => {
    const remotes = { upstream: 'https://github.com/o/r.git', fork: 'git@github.com:me/r.git' }
    const calls = world(on, { remotes, partial: 'upstream', model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.gh).toEqual(['repo view --json nameWithOwner,defaultBranchRef'])
    expect(calls.git).toContain(`diff --no-color upstream/main...${HEAD}`)
  })

  test('asks gh when the other remote has a URL that is not a repository', async ($, on) => {
    const calls = world(on, { remotes: { origin: 'git@github.com:o/r.git', local: 'mirror' }, model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.gh.length).toBe(1)
  })

  test('names the branch and the remote when the default base cannot be resolved', async ($, on) => {
    world(on, { remotes: FORK_REMOTES, defaultBranch: 'develop', model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(r.deny).toContain('could not resolve the base branch develop (tried upstream/develop, origin/develop and develop)')
  })

  test('checks the branch given with --head instead of HEAD', async ($, on) => {
    const calls = world(on, { model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --head feature/x --fill' })
    expect(calls.git).toContain(`diff --no-color origin/main...${FEATURE_HEAD}`)
  })

  test('passes without a model call when the branch has no diff', async ($, on) => {
    const calls = world(on, { diff: '', model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran.length).toBe(1)
    expect(calls.model).toBe(0)
    expect(r.context?.[0]).toContain('there is no diff between origin/main')
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
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran).toEqual(['gh pr create --fill'])
    expect(r.context?.[0]).toContain('could not run')
    expect(r.context?.[0]).toContain('the user chose to go ahead anyway')
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

// ファイル 1 つ分の差分
const section = (name: string, body: string) => `diff --git a/${name} b/${name}\n${body}`
// 1 つ 100,000 文字ほどの差分。2 つで 1 回の判定に入る
const big = (name: string, size = 100_000) => section(name, `+ ${name} ${'x'.repeat(size)}\n`)
// 判定のプロンプトに含まれる、差分を分けたときの何回目か
const partOf = (prompt: string) => /<part index="(\d+)"/.exec(prompt)?.[1]

describe('docs-sync on a large diff', () => {
  test('splits a diff that is too large into parts and checks every part', async ($, on) => {
    const prompts: string[] = []
    const calls = world(on, {
      files: { 'src/a.ts': big('a'), 'src/b.ts': big('b'), 'src/c.ts': big('c'), 'src/d.ts': big('d') },
      model: prompt => (prompts.push(prompt), { text: '{"status":"ok"}' }),
    })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran).toEqual(['gh pr create --fill'])
    expect(prompts.map(partOf)).toEqual(['1', '2'])
    expect(prompts[0]).toContain('<changed-files>')
    expect(r.context?.[0]).toContain('in 2 parts')
    // 差分全体を取れているので、ファイルごとに git diff を実行し直さない
    expect(calls.git.some(g => g.includes(':(literal)'))).toBe(false)
  })

  test('splits a diff just under the budget instead of leaving no room for the documents', async ($, on) => {
    const prompts: string[] = []
    const calls = world(on, {
      files: { 'src/a.ts': big('a', 140_000), 'src/b.ts': big('b', 140_000) },
      docs: { 'README.md': '# Tool\n' + 'd'.repeat(30_000) },
      model: prompt => (prompts.push(prompt), { text: '{"status":"ok"}' }),
    })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran).toEqual(['gh pr create --fill'])
    expect(prompts.map(partOf)).toEqual(['1', '2'])
    expect(r.context?.[0]).toContain('against 1 of 1 documents')
  })

  test('leaves out lock files, generated files and binaries', async ($, on) => {
    const prompts: string[] = []
    const calls = world(on, {
      files: {
        'package-lock.json': big('lock'),
        'dist/app.js': big('dist'),
        'logo.png': big('png'),
        'pnpm-lock.yaml': big('pnpm'),
        'src/cli.ts': section('src/cli.ts', '+ renamed --fast to --quick\n'),
      },
      binary: ['logo.png'],
      generated: ['dist/app.js'],
      model: prompt => (prompts.push(prompt), { text: '{"status":"ok"}' }),
    })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran).toEqual(['gh pr create --fill'])
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('renamed --fast to --quick')
    expect(prompts[0]).not.toContain('xxxxxxxxxx')
    // 外した後は 1 回で済むので、分けて判定しているとは伝えない
    expect(prompts[0]).not.toContain('<part')
    expect(r.context?.[0]).toContain('leaving out 4 files')
  })

  test('keeps checking the other parts after a drift and reports all findings together', async ($, on) => {
    const calls = world(on, {
      files: { 'src/a.ts': big('a'), 'src/b.ts': big('b'), 'src/c.ts': big('c') },
      model: prompt => ({
        text: JSON.stringify({ status: 'drift', findings: [{ doc: 'README.md', issue: `mismatch in part ${partOf(prompt)}`, fix: 'update it' }] }),
      }),
    })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran).toEqual([])
    expect(calls.model).toBe(2)
    expect(r.deny).toContain('mismatch in part 1')
    expect(r.deny).toContain('mismatch in part 2')
  })

  test('splits the diff by file when the whole diff is cut at 4 MiB', async ($, on) => {
    const calls = world(on, { files: { 'src/cli.ts': '+ renamed --fast to --quick\n' }, truncated: true, model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran).toEqual(['gh pr create --fill'])
    expect(r.context?.[0]).toContain('found no mismatch')
  })

  test('asks the user about the files it could not check, and remembers the choice for the commit', async ($, on) => {
    const questions: string[] = []
    const calls = world(on, { files: { 'src/a.ts': big('a'), 'src/huge.ts': big('huge', 310_000), 'src/b.ts': big('b') }, model: OK })
    on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
      const question = e.questions[0]!.question
      questions.push(question)
      return { result: { questions: e.questions, answers: { [question]: 'このまま PR を作成する' } } }
    })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran).toEqual(['gh pr create --fill'])
    expect(calls.model).toBe(1)
    expect(questions[0]).toContain('src/huge.ts')
    expect(r.context?.[0]).toContain('the user chose to go ahead anyway')

    // 同じコミットでもう一度実行しても、判定も質問もしない
    const again = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran.length).toBe(2)
    expect(calls.model).toBe(1)
    expect(questions.length).toBe(1)
    expect(again.context?.[0]).toContain('already chose to go ahead')
  })

  test('checks at most 5 parts and tells Claude what to offer when nobody can answer', async ($, on) => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/f${String(i).padStart(2, '0')}.ts`, big(`f${i}`)]))
    const calls = world(on, { files, model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran).toEqual([])
    expect(calls.model).toBe(5)
    expect(r.deny).toContain('only 5 are checked')
    expect(r.deny).toContain('This does not mean that the documentation is out of date')
    expect(r.deny).toContain('Split the branch into smaller pull requests')
    expect(r.deny).toContain('run gh pr create themselves')
  })

  test('reports the drift it found together with the files it could not check', async ($, on) => {
    const calls = world(on, { files: { 'src/a.ts': big('a'), 'src/b.ts': big('b'), 'src/huge.ts': big('huge', 310_000) }, model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran).toEqual([])
    expect(r.deny).toContain('says --fast but the CLI now takes --quick')
    expect(r.deny).toContain('these changed files were not checked: src/huge.ts')
  })

  test('checks the other parts when one part fails', async ($, on) => {
    const calls = world(on, {
      files: { 'src/a.ts': big('a'), 'src/b.ts': big('b'), 'src/c.ts': big('c') },
      model: prompt => (partOf(prompt) === '1' ? { reason: 'empty-reply' } : { text: '{"status":"ok"}' }),
    })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran).toEqual([])
    expect(calls.model).toBe(2)
    expect(r.deny).toContain('a part failed: model call failed (empty-reply)')
    expect(r.deny).toContain(`Run gh pr create again`)
  })

  test('tells Claude to run again, not that the file is too large, when git diff fails for a file', async ($, on) => {
    const calls = world(on, {
      files: { 'src/a.ts': section('src/a.ts', '+ a\n'), 'src/b.ts': section('src/b.ts', '+ b\n') },
      truncated: true,
      unreadable: ['src/b.ts'],
      model: OK,
    })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran).toEqual([])
    expect(r.deny).toContain('git diff failed for 1')
    expect(r.deny).not.toContain('too large to check on their own')
    expect(r.deny).toContain('Run gh pr create again')
  })

  test('does not remember the choice to go ahead after a failure that may be temporary', async ($, on) => {
    const questions: string[] = []
    const calls = world(on, { model: () => ({ reason: 'empty-reply' }) })
    on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
      const question = e.questions[0]!.question
      questions.push(question)
      return { result: { questions: e.questions, answers: { [question]: 'このまま PR を作成する' } } }
    })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    expect(calls.ran.length).toBe(2)
    expect(calls.model).toBe(2)
    expect(questions.length).toBe(2)
  })
})

describe('docs-sync on git push', () => {
  test('blocks a push to a branch with an open PR when the docs drift', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'git push' })
    expect(r.deny).toContain('docs-sync: the push was blocked')
    expect(r.deny).toContain('README.md: says --fast but the CLI now takes --quick')
    expect(r.deny).toContain('Commit the fixes and push again')
    expect(calls.gh).toEqual(['pr list --state open --limit 1000 --json number,url,baseRefName,headRefName,headRepository,headRepositoryOwner'])
    expect(calls.git).toContain(`diff --no-color origin/main...${HEAD}`)
    expect(calls.ran).toEqual([])
  })

  test('lets the push run and tells Claude when the docs match', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
    expect(calls.ran).toEqual(['git push origin HEAD'])
    expect(r.context?.[0]).toContain('docs-sync: the documentation check ran before this git push')
    expect(r.context?.[0]).toContain('for PR #5 (fix/foo)')
  })

  test('does not check a push to a branch without an open PR', async ($, on) => {
    const calls = world(on, { prs: [{ ...OPEN_PR, state: 'MERGED' }, { ...OPEN_PR, number: 6, headRefName: 'other' }], model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'git push -u origin fix/foo' })
    expect(calls.ran).toEqual(['git push -u origin fix/foo'])
    expect(calls.model).toBe(0)
    expect(r.context).toBe(undefined)
  })

  test('does not check a push to another remote than the repository the PR comes from', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: DRIFT })
    await $.tool.call({ tool: 'Bash', command: 'git push fork' })
    expect(calls.ran).toEqual(['git push fork'])
    expect(calls.model).toBe(0)
  })

  test('checks a push to a fork when the PR comes from that fork', async ($, on) => {
    const calls = world(on, { prs: [{ ...OPEN_PR, owner: 'me' }], model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'git push fork' })
    expect(r.deny).toContain('the push was blocked')
    expect(calls.ran).toEqual([])
  })

  test('checks a push to a fork against the base in the repository the PR goes to', async ($, on) => {
    const calls = world(on, { remotes: FORK_REMOTES, prs: [{ ...OPEN_PR, owner: 'me' }], model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'git push origin fix/foo' })
    expect(r.deny).toContain('the push was blocked')
    expect(calls.git).toContain(`diff --no-color upstream/main...${HEAD}`)
  })

  test('does not check the push again for a commit that passed with gh pr create', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: OK })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    await $.tool.call({ tool: 'Bash', command: 'git push' })
    expect(calls.model).toBe(1)
    expect(calls.ran.length).toBe(2)
  })

  test('checks a push in the same command as gh pr create only once, as gh pr create', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'git push -u origin fix/foo && gh pr create --fill' })
    expect(calls.gh).toEqual(['repo view --json nameWithOwner,defaultBranchRef'])
    expect(calls.model).toBe(1)
    expect(r.context?.[0]).toContain('before this gh pr create')
  })

  test('does not ask the user when the push runs outside a repository it can find', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'cd "$DIR" && git push' })
    expect(r.deny).toBe(undefined)
    expect(calls.ran.length).toBe(1)
    expect(calls.gh).toEqual([])
  })

  test('does not check a branch deletion or a dry run', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: DRIFT })
    for (const command of ['git push origin --delete fix/foo', 'git push origin :fix/foo', 'git push -n']) {
      await $.tool.call({ tool: 'Bash', command })
    }
    expect(calls.ran.length).toBe(3)
    expect(calls.model).toBe(0)
  })

  test('asks Claude to split the command when it commits before pushing to a branch with an open PR', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m fix && git push' })
    expect(r.deny).toContain('the push was blocked because this command runs git add before git push')
    expect(r.deny).toContain('run git push as a separate command')
    expect(calls.model).toBe(0)
    expect(calls.ran).toEqual([])
  })

  test('asks Claude to split the command when the push target depends on a branch the command may change', async ($, on) => {
    const calls = world(on, { prs: [], model: OK })
    for (const command of ['git checkout feature/x && git push', 'gh pr checkout 12 && git push origin', 'git commit -m x && git push origin HEAD']) {
      const r = await $.tool.call({ tool: 'Bash', command })
      expect(r.deny).toContain('the push was blocked because this command runs')
    }
    expect(calls.gh).toEqual([])
    expect(calls.ran).toEqual([])
  })

  test('lets a commit and a push in one command run when the branch has no open PR', async ($, on) => {
    const calls = world(on, { prs: [], model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m fix && git push -u origin fix/foo' })
    expect(r.deny).toBe(undefined)
    expect(calls.ran.length).toBe(1)
  })

  test('asks Claude to split the command when it commits before gh pr create', async ($, on) => {
    const calls = world(on, { model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m fix && git push -u origin fix/foo && gh pr create --fill' })
    expect(r.deny).toContain('PR creation was blocked because this command runs git commit before gh pr create')
    expect(calls.git).toEqual([])
    expect(calls.ran).toEqual([])
  })

  test('does not count git commands that run after the push', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'git push && git checkout main' })
    expect(r.deny).toBe(undefined)
    expect(calls.model).toBe(1)
  })

  test('checks a push whose output is redirected', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'git push 2>&1 | tail -1' })
    expect(r.deny).toContain('the push was blocked')
    expect(calls.ran).toEqual([])
  })

  test('checks every push in the command, not only the first one', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'git push -u origin new && git push origin fix/foo' })
    expect(r.deny).toContain('the push was blocked')
    expect(calls.gh.length).toBe(1)
    expect(calls.ran).toEqual([])
  })

  test('asks Claude to split the command when a later push comes after an amend', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: OK })
    const r = await $.tool.call({ tool: 'Bash', command: 'git push origin fix/foo; git commit --amend --no-edit; git push -f origin fix/foo' })
    expect(r.deny).toContain('runs git commit before git push')
    expect(calls.ran).toEqual([])
  })

  test('checks a push that comes after a push it does not check', async ($, on) => {
    const calls = world(on, { prs: [OPEN_PR], model: DRIFT })
    const r = await $.tool.call({ tool: 'Bash', command: 'git push origin --delete old && git push origin fix/foo' })
    expect(r.deny).toContain('the push was blocked')
    expect(calls.ran).toEqual([])
  })
})

describe('parsePrCreate', () => {
  test('reads --base and --head only from the gh pr create part', async () => {
    expect(parsePrCreate('gh pr create --base develop --fill')).toEqual({ cds: [], base: 'develop', head: undefined })
    expect(parsePrCreate('gh pr create --base=release/1.0 -H feat')).toEqual({ cds: [], base: 'release/1.0', head: 'feat' })
    expect(parsePrCreate("gh pr create -B 'main'")).toEqual({ cds: [], base: 'main', head: undefined })
    expect(parsePrCreate('git checkout -B x && gh pr create --body "use --base y"')).toEqual({ cds: [], base: undefined, head: undefined, mover: 'git checkout' })
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

  test('does not let a cd inside $(...) or backticks move the outer gh pr create', async () => {
    expect(parsePrCreate('OTHER=$(cd ../other-repo && git rev-parse HEAD) && gh pr create --fill')).toEqual({ cds: [], base: undefined, head: undefined })
    expect(parsePrCreate('gh pr create --fill --body "$(cd ../notes && cat pr.md)"')).toEqual({ cds: [], base: undefined, head: undefined })
    expect(parsePrCreate('x=`cd ../a`; cd b && gh pr create')).toEqual({ cds: ['b'], base: undefined, head: undefined })
  })

  test('applies outer and inner cd to gh pr create run inside $(...)', async () => {
    expect(parsePrCreate('cd a && url=$(cd b && gh pr create --fill)')).toEqual({ cds: ['a', 'b'], base: undefined, head: undefined })
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

describe('parsePush', () => {
  test('reads the refspecs after the remote', async () => {
    expect(parsePush('git push')).toEqual([{ cds: [], refs: [] }])
    expect(parsePush('git push -u origin fix/foo')).toEqual([{ cds: [], remote: 'origin', refs: [{ src: 'fix/foo' }] }])
    expect(parsePush('git push origin HEAD:fix/foo +a:b')).toEqual([{ cds: [], remote: 'origin', refs: [{ src: 'HEAD', dst: 'fix/foo' }, { src: '+a', dst: 'b' }] }])
    expect(parsePush('git push -o ci.skip origin x')).toEqual([{ cds: [], remote: 'origin', refs: [{ src: 'x' }] }])
    expect(parsePush('git push --repo=fork')).toEqual([{ cds: [], remote: 'fork', refs: [] }])
    expect(parsePush('git push --tags origin main')).toEqual([{ cds: [], remote: 'origin', refs: [{ src: 'main' }] }])
  })

  test('does not take redirections as the remote or refspecs', async () => {
    expect(parsePush('git push 2>&1 | tail -3')).toEqual([{ cds: [], refs: [] }])
    expect(parsePush('git push -q origin fix/foo >/dev/null 2>&1')).toEqual([{ cds: [], remote: 'origin', refs: [{ src: 'fix/foo' }] }])
  })

  test('applies cd and the git options that change the place', async () => {
    expect(parsePush('cd a && git -C b -c x=y push')).toEqual([{ cds: ['a', 'b'], refs: [] }])
    expect(parsePush('git --work-tree=/other --namespace n push')).toEqual([{ cds: [], refs: [] }])
    expect(parsePush('git --git-dir .git push')).toEqual([{ cds: [], refs: [] }])
    expect(parsePush('git --git-dir=../repo/.git push')).toEqual([{ cds: ['../repo'], refs: [] }])
    expect(parsePush('git --git-dir=/srv/bare.git push')).toEqual([])
  })

  test('returns nothing for pushes that are not checked', async () => {
    for (const command of ['git push --delete origin x', 'git push -d origin x', 'git push --dry-run', 'git push -n', 'git push --tags', 'git push --all', 'git push --mirror', 'git push -h']) {
      expect(parsePush(command)).toEqual([])
    }
  })

  test('records the first git command that is not read-only before each push', async () => {
    expect(parsePush('git commit -m "x" && git -C . push')[0]?.mover).toBe('git commit')
    expect(parsePush('git fetch && git status && git diff && git push')[0]?.mover).toBe(undefined)
    expect(parsePush('git push && git commit -m x')[0]?.mover).toBe(undefined)
    expect(parsePush('echo "$(git commit -am wip)" && git push')[0]?.mover).toBe('git commit')
    expect(parsePush('git branch -f feature abc && git push origin feature')[0]?.mover).toBe('git branch')
    expect(parsePush('gh pr checkout 3 && git push')[0]?.mover).toBe('gh pr checkout')
  })

  test('returns every push in the command, each with the mover before it', async () => {
    expect(parsePush('git push origin a; git commit --amend; git push -f origin a')).toEqual([
      { cds: [], remote: 'origin', refs: [{ src: 'a' }] },
      { cds: [], remote: 'origin', refs: [{ src: 'a' }], mover: 'git commit' },
    ])
    expect(parsePush('git push origin --delete old && git push origin x')).toEqual([{ cds: [], remote: 'origin', refs: [{ src: 'x' }] }])
  })

  test('ignores git push inside quotes and other git commands', async () => {
    expect(parsePush('git commit -m "then git push"')).toEqual([])
    expect(parsePush('git pull')).toEqual([])
  })
})

describe('repoOf', () => {
  test('reads owner/name from SSH and HTTPS remote URLs', async () => {
    expect(repoOf('git@github.com:Owner/Repo.git')).toBe('owner/repo')
    expect(repoOf('https://github.com/owner/repo')).toBe('owner/repo')
    expect(repoOf('ssh://git@github.com/owner/repo.git/')).toBe('owner/repo')
    expect(repoOf('repo')).toBe(undefined)
  })
})

describe('splitCommand', () => {
  test('splits on operators and keeps quoted text as one word', async () => {
    expect(wordsOf(`a "b c" 'd' && e | f; g\nh # i`)).toEqual([['a', 'b c', 'd'], ['e'], ['f'], ['g'], ['h']])
  })

  test('skips heredoc bodies', async () => {
    expect(wordsOf('cat <<-EOF > x\n\tgh pr create\n\tEOF\nnext')).toEqual([['cat'], ['next']])
  })

  test('drops redirections and their targets', async () => {
    expect(wordsOf('git push 2>&1 | tail -1')).toEqual([['git', 'push'], ['tail', '-1']])
    expect(wordsOf('git push origin x > /tmp/log 2>> err &> all < in')).toEqual([['git', 'push', 'origin', 'x']])
    expect(wordsOf('echo a>b c')).toEqual([['echo', 'a', 'c']])
    expect(wordsOf('git push origin >& log; echo x >&2; echo y >&-')).toEqual([['git', 'push', 'origin'], ['echo', 'x'], ['echo', 'y']])
  })
})

describe('joinDir', () => {
  test('joins a relative path and keeps a POSIX absolute path', async () => {
    expect(joinDir('/repo', '../other', false)).toBe('/repo/../other')
    expect(joinDir('/repo', '/d/works', false)).toBe('/d/works')
    expect(joinDir('/repo', 'D:', false)).toBe('/repo/D:')
  })

  test('treats drive paths as absolute on Windows, with / as the separator', async () => {
    expect(joinDir('D:\\works\\a', 'E:/b', true)).toBe('E:/b')
    expect(joinDir('D:\\works\\a', 'E:\\b', true)).toBe('E:/b')
    expect(joinDir('D:\\works\\a', 'E:', true)).toBe('E:/')
    expect(joinDir('D:\\works\\a', 'E:b', true)).toBe('E:b')
    expect(joinDir('D:\\works\\a', 'sub', true)).toBe('D:/works/a/sub')
    expect(joinDir('D:\\', 'sub', true)).toBe('D:/sub')
  })

  test('turns Git Bash /d/... and Cygwin /cygdrive/d/... into drive paths on Windows', async () => {
    expect(joinDir('C:\\Users\\me', '/d/works/a', true)).toBe('D:/works/a')
    expect(joinDir('C:\\Users\\me', '/d', true)).toBe('D:/')
    expect(joinDir('C:\\Users\\me', '/cygdrive/d/works/a', true)).toBe('D:/works/a')
    expect(joinDir('C:\\Users\\me', '/usr/bin', true)).toBe('/usr/bin')
  })
})

describe('parseJson', () => {
  test('reads JSON with or without a code fence', async () => {
    expect(parseJson('{"status":"ok"}')).toEqual({ status: 'ok' })
    expect(parseJson('Here:\n```json\n["a.md"]\n```')).toEqual(['a.md'])
    expect(parseJson('no json here')).toBe(undefined)
  })
})

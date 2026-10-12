import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { duration, fromPull, fromRuns, newestOfEach, overall, summary, time } from '../hooks/checks'
import { branchOf, gitDirOf, startsChecks } from '../hooks/shell'
import type { CiSnapshot } from '../types'

const PULL = JSON.stringify({
  number: 42, title: 'Fix sticky header jump', url: 'https://github.com/o/r/pull/42',
  isDraft: true, state: 'OPEN', reviewDecision: '', mergeStateStatus: 'CLEAN',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'Test', workflowName: 'Test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x/1', startedAt: '2026-10-12T11:20:37Z', completedAt: '2026-10-12T11:35:24Z' },
    { __typename: 'CheckRun', name: 'Analyze (actions)', workflowName: 'CodeQL', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'https://x/2', startedAt: '2026-10-12T11:20:38Z' },
    { __typename: 'CheckRun', name: 'Deploy', workflowName: 'Deploy', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'StatusContext', context: 'netlify/deploy-preview', state: 'SUCCESS', targetUrl: 'https://x/3' },
  ],
})

describe('checks', () => {
  test('reads a PR rollup', () => {
    const { pull, checks } = fromPull(PULL)
    expect(pull.number).toBe(42)
    expect(checks.map(check => [check.name, check.state])).toEqual([
      ['Test', 'failure'],
      ['CodeQL / Analyze (actions)', 'pending'],
      ['Deploy', 'skipped'],
      ['netlify/deploy-preview', 'success'],
    ])
    expect(overall(checks)).toBe('failure')
    expect(summary(checks)).toBe('1 failed, 3/4 done')
  })

  test('keeps the newest run of each workflow', () => {
    const checks = fromRuns(JSON.stringify([
      { workflowName: 'FE Build', status: 'in_progress', conclusion: '', url: 'u1', createdAt: '2026-10-12T11:55:49Z' },
      { workflowName: 'FE Build', status: 'completed', conclusion: 'failure', url: 'u0' },
      { workflowName: 'CodeQL', status: 'completed', conclusion: 'success', url: 'u2' },
    ]))
    expect(checks.map(check => [check.name, check.state])).toEqual([['FE Build', 'pending'], ['CodeQL', 'success']])
    expect(overall(checks)).toBe('pending')
  })

  test("reads Go's zero time as unknown", () => {
    expect(time('0001-01-01T00:00:00Z')).toBeUndefined()
    expect(time('')).toBeUndefined()
    const { checks } = fromPull(JSON.stringify({
      number: 1, title: 't', url: 'u', isDraft: false, state: 'OPEN',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'Build', status: 'QUEUED', startedAt: '0001-01-01T00:00:00Z', completedAt: '0001-01-01T00:00:00Z' }],
    }))
    expect(duration(checks[0]?.startedAt, checks[0]?.completedAt, Date.parse('2026-10-12T12:00:00Z'))).toBe('')
  })

  test('a settled status shows no ever-growing duration', () => {
    const { checks } = fromPull(JSON.stringify({
      number: 1, title: 't', url: 'u', isDraft: false, state: 'OPEN',
      statusCheckRollup: [
        { __typename: 'StatusContext', context: 'deploy/settled', state: 'SUCCESS', startedAt: '2026-10-12T11:00:00Z' },
        { __typename: 'StatusContext', context: 'deploy/running', state: 'PENDING', startedAt: '2026-10-12T13:58:00Z' },
      ],
    }))
    const now = Date.parse('2026-10-12T14:00:00Z')
    expect(duration(checks[0]?.startedAt, checks[0]?.completedAt, now)).toBe('')
    expect(duration(checks[1]?.startedAt, checks[1]?.completedAt, now)).toBe('2m00s')
  })

  test('keeps the newest of a re-run check, whatever the order gh lists them in', () => {
    const failed = { name: 'Test', state: 'failure' as const, url: 'old', startedAt: '2026-10-12T10:00:00Z', completedAt: '2026-10-12T10:10:00Z' }
    const passed = { name: 'Test', state: 'success' as const, url: 'new', startedAt: '2026-10-12T11:00:00Z', completedAt: '2026-10-12T11:10:00Z' }
    expect(newestOfEach([failed, passed]).map(check => check.url)).toEqual(['new'])
    expect(newestOfEach([passed, failed]).map(check => check.url)).toEqual(['new'])
  })

  test('of two same-named checks from one push, the failing one stands', () => {
    const push = { name: 'Test', state: 'success' as const, url: 'push', startedAt: '2026-10-12T11:00:00Z', completedAt: undefined }
    const pull = { name: 'Test', state: 'failure' as const, url: 'pull', startedAt: '2026-10-12T11:00:20Z', completedAt: undefined }
    expect(newestOfEach([push, pull]).map(check => check.url)).toEqual(['pull'])
    expect(newestOfEach([pull, push]).map(check => check.url)).toEqual(['pull'])
  })

  test('formats durations', () => {
    expect(duration('2026-10-12T11:20:37Z', '2026-10-12T11:35:24Z', 0)).toBe('14m47s')
    expect(duration(undefined, undefined, 0)).toBe('')
  })
})

describe('shell', () => {
  test('tells the commands that start new checks', () => {
    expect(startsChecks('git push origin main')).toBe(true)
    expect(startsChecks('cd repo && git -C . push --force-with-lease')).toBe(true)
    expect(startsChecks('timeout 60 gh pr create --draft --title x')).toBe(true)
    expect(startsChecks('gh run rerun 123 --failed')).toBe(true)
    // Quoted text, heredoc bodies and other git commands are no push.
    expect(startsChecks('git commit -m "fix docs on git push"')).toBe(false)
    expect(startsChecks("cat <<'EOF' > notes.md\nthen git push and gh pr create\nEOF")).toBe(false)
    expect(startsChecks('git pull --rebase')).toBe(false)
    expect(startsChecks('gh pr view --json number')).toBe(false)
  })

  test('reads the branch from HEAD, and a worktree git dir', () => {
    expect(branchOf('ref: refs/heads/feature/menu\n')).toBe('feature/menu')
    expect(branchOf('3f2c1d0e9a\n')).toBeUndefined()
    expect(gitDirOf('gitdir: /repo/.git/worktrees/x\n', '/wt')).toBe('/repo/.git/worktrees/x')
    expect(gitDirOf('gitdir: ../repo/.git/worktrees/x\n', '/wt')).toBe('/wt/../repo/.git/worktrees/x')
  })
})

const SNAPSHOT: CiSnapshot = {
  branch: 'sticky-header-fix',
  ...fromPull(PULL),
  overall: 'failure',
  fetchedAt: Date.parse('2026-10-12T11:40:00Z'),
  error: undefined,
}

describe('pane', () => {
  test('draws the PR and its checks, failures first, on every surface that docks a pane', async ($, on) => {
    on('state.get', ($, e) => ({ value: { value: e.key === 'head' ? { cwd: '/repo', branch: SNAPSHOT.branch } : SNAPSHOT, version: 1 } }) as never)
    on('clock.now', () => ({ value: SNAPSHOT.fetchedAt }))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'ci-watch', surface, component: 'Pane', requestId: 'ci-watch', props: {} as never })
      expect(await ui.find({ text: /Fix sticky header/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'fix' })).toBeDefined()
      const rows = await ui.findAll({ type: 'Text', text: /^[✗●○✓]/ })
      expect(rows[0]?.text).toMatch(/^✗ Test/)
      await ui.unmount()
    }
  })
})

const PANE = { plugin: 'ci-watch', component: 'Pane', requestId: 'ci-watch', props: {} as never } as const
const run = (stdout: string, exitCode = 0, stderr = '') =>
  ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

// A checkout at /repo on `world.branch`; `gh` plays the gh CLI.
type World = { branch: string }

function machine(on: On, world: World, gh: (argv: readonly string[]) => ReturnType<typeof run> | Promise<ReturnType<typeof run>> | 'missing') {
  const seen = { argv: [] as string[][], status: [] as (string | undefined)[] }
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/repo/.git' }) as never)
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }) as never)
  on('fs.read', () => ({ value: `ref: refs/heads/${world.branch}\n` }) as never)
  on('clock.now', () => ({ value: Date.parse('2026-10-12T11:40:00Z') }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', ($, e) => { seen.status.push(e.text); return { value: undefined } })
  on('process.run', ($, e) => {
    seen.argv.push([...e.argv])
    const answer = gh(e.argv)
    if (answer === 'missing') throw new Error('spawn gh ENOENT')
    return answer
  })
  return seen
}

const pullOf = (title: string) => run(JSON.stringify({ ...JSON.parse(PULL), title }))

async function openPane($: Engine) {
  await $.command.run({ command: 'ci', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  return ui
}

describe('pane, after a branch switch', () => {
  test("never draws the previous branch's checks", async ($, on) => {
    on('state.get', ($, e) => ({ value: { value: e.key === 'head' ? { cwd: '/repo', branch: 'other' } : SNAPSHOT, version: 1 } }) as never)
    on('clock.now', () => ({ value: SNAPSHOT.fetchedAt }))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ text: /Reading CI/ })).toBeDefined()
    expect(await ui.find({ text: /Fix sticky header/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('reading', () => {
  test("asks gh for this checkout's PR, not a PR by branch name", async ($, on) => {
    const seen = machine(on, { branch: 'main' }, () => pullOf('Mine'))
    const ui = await openPane($)
    expect(await ui.find({ text: /Mine/ })).toBeDefined()
    const view = seen.argv.find(argv => argv[1] === 'pr')
    expect(view?.slice(0, 4)).toEqual(['gh', 'pr', 'view', '--json'])
    await ui.unmount()
  })

  test('a missing gh is said in the pane, not read forever', async ($, on) => {
    machine(on, { branch: 'main' }, () => 'missing')
    const ui = await openPane($)
    expect(await ui.find({ text: /gh: could not run gh/ })).toBeDefined()
    await ui.unmount()
  })

  test('a branch switch during a read shows the new branch, never the old one', async ($, on) => {
    const world: World = { branch: 'a' }
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => { release = resolve })
    machine(on, world, async () => {
      if (world.branch === 'a') {
        await held
        return pullOf('Branch A')
      }
      return pullOf('Branch B')
    })
    await $.command.run({ command: 'ci', args: '' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    world.branch = 'b'
    release()
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: /Branch B/ })).toBeDefined()
    expect(await ui.find({ text: /Branch A/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a failing gh is told in the status line, not as checks still running', async ($, on) => {
    let isFailing = false
    const seen = machine(on, { branch: 'main' }, () => isFailing ? run('', 1, 'HTTP 403: API rate limit exceeded') : pullOf('Mine'))
    const ui = await openPane($)
    isFailing = true
    await ui.press({ key: 'refresh' })
    expect(seen.status.at(-1)).toMatch(/^CI PR #42 ⚠ gh: HTTP 403: API rate limit exceeded/)
    await ui.unmount()
  })
})

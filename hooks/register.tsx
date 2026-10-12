import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CiCheck, CiHead, CiSnapshot } from '../types'
import { duration, fromPull, fromRuns, ICON, overall, summary } from './checks'
import { branchOf, gitDirOf, startsChecks } from './shell'

// Watches the checks of the current branch's PR (or its workflow runs when
// it has none) through the gh CLI: a status line while they run, a
// notification when they settle, and a pane on /ci.

const PANE = 'ci-watch'
// Everything the pane draws from is state, so every change redraws it.
const snapshot = atom({ plugin: 'ci-watch', key: 'snapshot' } as const, null)
const head = atom({ plugin: 'ci-watch', key: 'head' } as const, null)

// Polling: fast while checks run or right after a push, slow otherwise.
const TICK_MS = 10_000
const FAST_MS = 20_000
const SLOW_MS = 120_000
const AFTER_PUSH_MS = 10 * 60_000

// Pacing only; what is known lives in state. A reload restarts it from
// session.start.
let nextAt = 0
let fastUntil = 0
// The read in flight, which a refresh waits for before reading again.
let reading: Promise<void> | undefined
// Bumped when the branch (or the checkout) changes: a read started for the
// previous one writes nothing.
let generation = 0
// The HEAD file of the checkout at `headFor`, found once per directory.
let headFor: string | undefined
let headPath: string | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'ci', description: "Show the current branch's CI checks in a pane" })
    nextAt = 0
    $.clock.every(TICK_MS, () => background(tick($)))
    background(tick($))
    return started
  })

  // The pane opens at once (it says it is reading); the read runs behind it.
  on('command.run', { command: 'ci' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'CI' })
    background(refresh($))
    return { text: opened.isPlaced ? 'CI pane opened.' : 'CI pane waits for a wider terminal.' }
  })

  // A push (or a PR created or readied) that ran starts new checks: look
  // sooner. Claude gets its result now; the read runs behind it.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && startsChecks(e.command)) {
      fastUntil = (await $.clock.now()) + AFTER_PUSH_MS
      background(refresh($))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const stored = await read($, snapshot)
    const checkout = await read($, head)
    const now = await $.clock.now()
    const refreshButton = <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($)} />

    if (checkout !== null && checkout.branch === undefined) {
      return (
        <Box flexDirection="column">
          <Text dimColor wrap="wrap">Not on a branch: detached HEAD, or no git repository here.</Text>
          <Box marginTop={1}>{refreshButton}</Box>
        </Box>
      )
    }
    // A snapshot of another branch (before the first read after a switch) is not shown.
    const current = stored !== null && stored.branch === checkout?.branch ? stored : null
    if (current === null) return <Box gap={1}><Text dimColor>Reading CI…</Text>{refreshButton}</Box>

    const room = Math.max(3, (e.viewport?.rows ?? 24) - 8)
    const failed = current.checks.filter(check => check.state === 'failure')

    return (
      <Box flexDirection="column">
        {current.pull === null
          ? <Text>⎇ {current.branch} <Text dimColor>(no PR, latest runs)</Text></Text>
          : (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                <Link href={current.pull.url} label={`#${current.pull.number}`} /> {current.pull.title}
              </Text>
              <Text dimColor wrap="truncate-end">
                {[
                  current.pull.isDraft ? 'draft' : current.pull.state.toLowerCase(),
                  review(current.pull.reviewDecision),
                  current.pull.mergeStateStatus === '' ? '' : `merge ${current.pull.mergeStateStatus.toLowerCase()}`,
                ].filter(Boolean).join(' · ')}
              </Text>
            </Box>
          )}
        <Text> </Text>
        {current.checks.length === 0 && <Text dimColor>No checks.</Text>}
        {sorted(current.checks).slice(0, room).map(check => (
          <Text key={check.name} wrap="truncate-end">
            <Text color={color(check.state)}>{ICON[check.state]}</Text>{' '}
            {check.url === undefined ? check.name : <Link href={check.url} label={check.name} />}
            <Text dimColor> {duration(check.startedAt, check.completedAt, now)}</Text>
          </Text>
        ))}
        {current.checks.length > room && <Text dimColor>… {current.checks.length - room} more</Text>}
        <Text> </Text>
        {current.error !== undefined && <Text color="warning" wrap="truncate-end">gh: {current.error}</Text>}
        <Box gap={1}>
          {refreshButton}
          {failed.length > 0 && (
            <Button
              key="fix"
              label="Ask Claude to fix"
              hotkey="f"
              variant="primary"
              onPress={() => $.prompt.fill({ text: fixPrompt(current, failed) })}
            />
          )}
        </Box>
      </Box>
    )
  })
}

// An explicit refresh: reads now, or once the read in flight is done (it
// may predate what asked).
async function refresh($: EngineInterface) {
  while (reading !== undefined) await reading
  nextAt = 0
  await tick($)
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const cwd = await $.session.cwd()
  const branch = await currentBranch($, cwd)
  const known = await read($, head)
  if (known === null || known.cwd !== cwd || known.branch !== branch) {
    generation += 1
    nextAt = 0
    const moved: CiHead = { cwd, branch }
    await update($, head, () => moved)
    if (branch === undefined) $.ui.status(undefined)
  }
  if (branch === undefined || reading !== undefined || now < nextAt) return

  const started = generation
  reading = (async () => {
    const previous = await read($, snapshot)
    const sameBranch = previous?.branch === branch ? previous : null
    let fresh: CiSnapshot
    try {
      fresh = await fetchSnapshot($, branch, sameBranch, now)
    } catch (error) {
      fresh = stale(sameBranch, branch, now, message(error))
    }
    if (started !== generation) return
    await update($, snapshot, () => fresh)
    announce($, sameBranch, fresh)
    // A failing gh backs off, whatever the checks last said.
    const isFast = fresh.error === undefined && (fresh.overall === 'pending' || now < fastUntil)
    nextAt = now + (isFast ? FAST_MS : SLOW_MS)
  })()
  try {
    await reading
  } finally {
    reading = undefined
  }
  // The branch moved while it read: read for the new one now.
  if (started !== generation) await tick($)
}

// The branch, from the checkout's HEAD file (no git process every tick):
// the `.git` directory, or the git dir a worktree's `.git` file names.
async function currentBranch($: EngineInterface, cwd: string): Promise<string | undefined> {
  try {
    if (headFor !== cwd) {
      headFor = cwd
      headPath = await findHead($, cwd)
    }
    return headPath === undefined ? undefined : branchOf(await $.fs.read(headPath))
  } catch {
    headFor = undefined
    return undefined
  }
}

async function findHead($: EngineInterface, cwd: string): Promise<string | undefined> {
  for (let directory = cwd; ; directory = directory.slice(0, directory.lastIndexOf('/')) || '/') {
    const dotGit = `${directory === '/' ? '' : directory}/.git`
    if (await $.fs.exists(dotGit)) {
      const { kind } = await $.fs.stat(dotGit)
      if (kind === 'dir') return `${dotGit}/HEAD`
      const gitDir = gitDirOf(await $.fs.read(dotGit), directory)
      return gitDir === undefined ? undefined : `${gitDir}/HEAD`
    }
    if (directory === '/') return undefined
  }
}

async function fetchSnapshot($: EngineInterface, branch: string, previous: CiSnapshot | null, now: number): Promise<CiSnapshot> {
  // No branch argument: gh then finds the PR this checkout pushes to, never
  // a fork's PR from a branch of the same name, nor PR #123 for a branch "123".
  const pr = await $.process.run(
    ['gh', 'pr', 'view', '--json', 'number,title,url,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup'],
    { timeoutMs: 30_000 },
  )
  if (pr.exitCode === 0) {
    const { pull, checks } = fromPull(pr.stdout)
    return { branch, pull, checks, overall: overall(checks), fetchedAt: now, error: undefined }
  }
  if (!/no pull requests found/i.test(pr.stderr)) return stale(previous, branch, now, pr.stderr)

  const runs = await $.process.run(
    ['gh', 'run', 'list', '--branch', branch, '--limit', '20', '--json', 'name,workflowName,status,conclusion,url,createdAt,updatedAt'],
    { timeoutMs: 30_000 },
  )
  if (runs.exitCode !== 0) return stale(previous, branch, now, runs.stderr)
  const checks = fromRuns(runs.stdout)
  return { branch, pull: null, checks, overall: overall(checks), fetchedAt: now, error: undefined }
}

// A failed read keeps what was known, says why, and settles nothing.
function stale(previous: CiSnapshot | null, branch: string, now: number, stderr: string): CiSnapshot {
  const error = stderr.trim().split('\n')[0]?.slice(0, 200) || 'gh failed'
  return previous === null
    ? { branch, pull: null, checks: [], overall: 'none', fetchedAt: now, error }
    : { ...previous, error }
}

function announce($: EngineInterface, previous: CiSnapshot | null, fresh: CiSnapshot) {
  const label = fresh.pull === null ? fresh.branch : `PR #${fresh.pull.number}`

  $.ui.status(fresh.error !== undefined
    ? `CI ${label} ⚠ gh: ${fresh.error.slice(0, 80)}`
    : fresh.overall === 'none' || fresh.overall === 'success' || fresh.overall === 'skipped'
      ? undefined
      : `CI ${label} ${ICON[fresh.overall]} ${summary(fresh.checks)}`)

  // Only a run that was seen pending and has now settled is news.
  if (previous?.overall !== 'pending' || fresh.overall === 'pending' || fresh.error !== undefined) return
  const text = fresh.overall === 'success'
    ? `CI passed on ${label}`
    : fresh.overall === 'failure'
      ? `CI failed on ${label}: ${fresh.checks.filter(check => check.state === 'failure').map(check => check.name).join(', ')}`
      : `CI ${fresh.overall} on ${label}`
  $.ui.toast(text, { timeoutMs: 10_000 })
  void $.ui.notify(text, { title: 'CI' }).catch(() => undefined)
}

function fixPrompt(current: CiSnapshot, failed: readonly CiCheck[]): string {
  const where = current.pull === null ? `branch ${current.branch}` : `PR #${current.pull.number} (${current.pull.url})`
  const list = failed.map(check => `- ${check.name}${check.url === undefined ? '' : `: ${check.url}`}`).join('\n')
  return `CI failed on ${where}:\n${list}\n\nRead the failed logs (gh run view <run-id> --log-failed), find the cause and fix it.`
}

function sorted(checks: readonly CiCheck[]): CiCheck[] {
  const rank = { failure: 0, pending: 1, cancelled: 2, success: 3, skipped: 4 } as const
  return [...checks].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))
}

function color(state: CiCheck['state']): string {
  return state === 'success' ? 'success' : state === 'failure' ? 'error' : state === 'pending' ? 'warning' : 'inactive'
}

function review(decision: string): string {
  switch (decision) {
    case 'APPROVED': return 'approved'
    case 'CHANGES_REQUESTED': return 'changes requested'
    case 'REVIEW_REQUIRED': return 'review required'
    default: return ''
  }
}

// Work nobody awaits: it records its own failures; what is left (the module
// unloading under it) is dropped, never left unhandled.
function background(work: Promise<unknown>) {
  work.catch(() => undefined)
}

// Why gh could not run at all (missing, timed out): its own failures come
// back as stderr instead.
function message(error: unknown): string {
  return `could not run gh: ${error instanceof Error ? error.message : String(error)}`
}

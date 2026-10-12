import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CiCheck, CiSnapshot } from '../types'
import { duration, fromPull, fromRuns, ICON, overall, summary } from './checks'

// Watches the checks of the current branch's PR (or its workflow runs when
// it has none) through the gh CLI: a status line while they run, a
// notification when they settle, and a pane on /ci.

const PANE = 'ci-watch'
const snapshot = atom({ plugin: 'ci-watch', key: 'snapshot' } as const, null)

// Polling: fast while checks run or right after a push, slow otherwise.
const TICK_MS = 10_000
const FAST_MS = 20_000
const SLOW_MS = 120_000
const AFTER_PUSH_MS = 10 * 60_000

// The module's own pacing; a reload restarts it from session.start.
let nextAt = 0
let fastUntil = 0
let isFetching = false
let lastBranch: string | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'ci', description: "Show the current branch's CI checks in a pane" })
    nextAt = 0
    $.clock.every(TICK_MS, () => void tick($))
    void tick($)
    return started
  })

  on('command.run', { command: 'ci' }, async $ => {
    nextAt = 0
    void tick($)
    const opened = await $.ui.open({ id: PANE, title: 'CI' })
    return { text: opened.isPlaced ? 'CI pane opened.' : 'CI pane waits for a wider terminal.' }
  })

  // A push (or a PR created or readied) starts new checks: look sooner.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgit\s+push\b|\bgh\s+pr\s+(?:create|ready|merge)\b|\bgh\s+run\s+rerun\b/.test(e.command)) {
      fastUntil = (await $.clock.now()) + AFTER_PUSH_MS
      nextAt = 0
      void tick($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const current = await read($, snapshot)
    const now = await $.clock.now()

    if (current === null) return <Text dimColor>Reading CI…</Text>

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
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => { nextAt = 0; void tick($) }} />
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

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const branch = await currentBranch($)
  if (branch !== lastBranch) {
    lastBranch = branch
    nextAt = 0
  }
  if (isFetching || now < nextAt || branch === undefined) return

  isFetching = true
  try {
    const previous = await read($, snapshot)
    const fresh = await fetchSnapshot($, branch, previous?.branch === branch ? previous : null, now)
    await update($, snapshot, () => fresh)
    announce($, previous?.branch === branch ? previous : null, fresh)
    const isFast = fresh.overall === 'pending' || now < fastUntil
    nextAt = now + (isFast ? FAST_MS : SLOW_MS)
  } catch {
    nextAt = now + SLOW_MS
  } finally {
    isFetching = false
  }
}

async function currentBranch($: EngineInterface): Promise<string | undefined> {
  const { exitCode, stdout } = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 5000 })
  const branch = stdout.trim()
  return exitCode === 0 && branch !== '' ? branch : undefined
}

async function fetchSnapshot($: EngineInterface, branch: string, previous: CiSnapshot | null, now: number): Promise<CiSnapshot> {
  const pr = await $.process.run(
    ['gh', 'pr', 'view', branch, '--json', 'number,title,url,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup'],
    { timeoutMs: 30_000 },
  )
  if (pr.exitCode === 0) {
    const { pull, checks } = fromPull(pr.stdout)
    return { branch, pull, checks, overall: overall(checks), fetchedAt: now, error: undefined }
  }
  if (!/no pull requests found/i.test(pr.stderr)) return stale(previous, branch, now, pr.stderr)

  const runs = await $.process.run(
    ['gh', 'run', 'list', '--branch', branch, '--limit', '10', '--json', 'name,workflowName,status,conclusion,url,createdAt,updatedAt'],
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

  $.ui.status(fresh.overall === 'none' || fresh.overall === 'success' || fresh.overall === 'skipped'
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

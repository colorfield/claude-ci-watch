import type { CiCheck, CiPull, CiState } from '../types'

// Turns gh's JSON into one list of checks and one overall state. Pure.

type RollupEntry = {
  __typename?: string
  name?: string
  context?: string
  status?: string | null
  conclusion?: string | null
  state?: string | null
  detailsUrl?: string
  targetUrl?: string
  startedAt?: string
  completedAt?: string
  workflowName?: string
}

type RunEntry = {
  name?: string
  workflowName?: string
  status?: string
  conclusion?: string
  url?: string
  createdAt?: string
  updatedAt?: string
}

export function fromPull(json: string): { pull: CiPull; checks: CiCheck[] } {
  const data = JSON.parse(json) as CiPull & { statusCheckRollup?: RollupEntry[] }
  const pull: CiPull = {
    number: data.number,
    title: data.title,
    url: data.url,
    isDraft: data.isDraft,
    state: data.state,
    reviewDecision: data.reviewDecision ?? '',
    mergeStateStatus: data.mergeStateStatus ?? '',
  }
  return { pull, checks: newestOfEach((data.statusCheckRollup ?? []).map(fromRollup)) }
}

export function fromRuns(json: string): CiCheck[] {
  const runs = JSON.parse(json) as RunEntry[]
  return newestOfEach(runs.map(run => ({
    name: run.workflowName ?? run.name ?? 'run',
    state: run.status === 'completed' ? conclusionState(run.conclusion) : 'pending',
    url: run.url,
    startedAt: time(run.createdAt),
    completedAt: run.status === 'completed' ? time(run.updatedAt) : undefined,
  })))
}

function fromRollup(entry: RollupEntry): CiCheck {
  if (entry.__typename === 'StatusContext') {
    const state = (entry.state ?? '').toUpperCase()
    const isPending = state === 'PENDING' || state === 'EXPECTED'
    return {
      name: entry.context ?? 'status',
      state: state === 'SUCCESS' ? 'success' : isPending ? 'pending' : 'failure',
      url: entry.targetUrl || undefined,
      // A status says when it was posted, never when it finished: a settled
      // one shows no duration rather than one that keeps growing.
      startedAt: isPending ? time(entry.startedAt) : undefined,
      completedAt: undefined,
    }
  }
  const isDone = (entry.status ?? '').toUpperCase() === 'COMPLETED'
  return {
    name: entry.workflowName && entry.name !== entry.workflowName ? `${entry.workflowName} / ${entry.name}` : entry.name ?? 'check',
    state: isDone ? conclusionState(entry.conclusion) : 'pending',
    url: entry.detailsUrl || undefined,
    startedAt: time(entry.startedAt),
    completedAt: isDone ? time(entry.completedAt) : undefined,
  }
}

function conclusionState(conclusion: string | null | undefined): CiState {
  switch ((conclusion ?? '').toUpperCase()) {
    case 'SUCCESS':
    case 'NEUTRAL':
      return 'success'
    case 'SKIPPED':
      return 'skipped'
    case 'CANCELLED':
    case 'STALE':
      return 'cancelled'
    default:
      return 'failure'
  }
}

// gh's timestamps, with Go's zero time ("0001-01-01T00:00:00Z", a run not
// started yet) and blanks read as unknown.
export function time(value: string | null | undefined): string | undefined {
  return value && !value.startsWith('0001-') && !Number.isNaN(Date.parse(value)) ? value : undefined
}

// Checks sharing a name started within this of each other belong to one wave
// (one push seen as push and pull_request): the worst of them stands.
// Further apart, the later is a re-run and replaces the earlier.
const SAME_WAVE_MS = 60_000

const SEVERITY: Record<CiState, number> = { failure: 4, pending: 3, cancelled: 2, success: 1, skipped: 0 }

// One check per name, whatever order gh lists them in.
export function newestOfEach(checks: readonly CiCheck[]): CiCheck[] {
  const kept = new Map<string, CiCheck>()
  for (const check of checks) {
    const held = kept.get(check.name)
    if (held === undefined) {
      kept.set(check.name, check)
      continue
    }
    const gap = startOf(check) - startOf(held)
    const isSameWave = Math.abs(gap) <= SAME_WAVE_MS
    if (isSameWave ? SEVERITY[check.state] > SEVERITY[held.state] : gap > 0) kept.set(check.name, check)
  }
  // In the order gh first listed each name.
  return [...kept.values()]
}

// A check waiting to start is the newest of its name; a settled one that
// says nothing of its start, the oldest.
function startOf(check: CiCheck): number {
  if (check.startedAt !== undefined) return Date.parse(check.startedAt)
  return check.state === 'pending' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
}

export function overall(checks: readonly CiCheck[]): CiState | 'none' {
  if (checks.length === 0) return 'none'
  if (checks.some(check => check.state === 'failure')) return 'failure'
  if (checks.some(check => check.state === 'pending')) return 'pending'
  if (checks.some(check => check.state === 'cancelled')) return 'cancelled'
  if (checks.every(check => check.state === 'skipped')) return 'skipped'
  return 'success'
}

export const ICON: Record<CiState, string> = {
  pending: '●',
  success: '✓',
  failure: '✗',
  skipped: '○',
  cancelled: '⊘',
}

export function summary(checks: readonly CiCheck[]): string {
  const done = checks.filter(check => check.state !== 'pending').length
  const failed = checks.filter(check => check.state === 'failure').length
  return failed > 0 ? `${failed} failed, ${done}/${checks.length} done` : `${done}/${checks.length} done`
}

export function duration(from: string | undefined, to: string | undefined, now: number): string {
  if (from === undefined) return ''
  const start = Date.parse(from)
  const end = to === undefined ? now : Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end)) return ''
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`
}

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
  return { pull, checks: dedupe((data.statusCheckRollup ?? []).map(fromRollup)) }
}

export function fromRuns(json: string): CiCheck[] {
  const runs = JSON.parse(json) as RunEntry[]
  // gh lists newest first: the first run of each workflow is its current one.
  return dedupe(runs.map(run => ({
    name: run.workflowName ?? run.name ?? 'run',
    state: run.status === 'completed' ? conclusionState(run.conclusion) : 'pending',
    url: run.url,
    startedAt: run.createdAt,
    completedAt: run.status === 'completed' ? run.updatedAt : undefined,
  })))
}

function fromRollup(entry: RollupEntry): CiCheck {
  if (entry.__typename === 'StatusContext') {
    const state = (entry.state ?? '').toUpperCase()
    return {
      name: entry.context ?? 'status',
      state: state === 'SUCCESS' ? 'success' : state === 'PENDING' || state === 'EXPECTED' ? 'pending' : 'failure',
      url: entry.targetUrl || undefined,
      startedAt: entry.startedAt,
      completedAt: undefined,
    }
  }
  const isDone = (entry.status ?? '').toUpperCase() === 'COMPLETED'
  return {
    name: entry.workflowName && entry.name !== entry.workflowName ? `${entry.workflowName} / ${entry.name}` : entry.name ?? 'check',
    state: isDone ? conclusionState(entry.conclusion) : 'pending',
    url: entry.detailsUrl || undefined,
    startedAt: entry.startedAt || undefined,
    completedAt: isDone ? entry.completedAt || undefined : undefined,
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

// A re-run lists a check twice; the first listed is the newest.
function dedupe(checks: CiCheck[]): CiCheck[] {
  const seen = new Set<string>()
  return checks.filter(check => !seen.has(check.name) && seen.add(check.name) !== undefined)
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

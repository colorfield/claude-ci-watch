export type CiState = 'pending' | 'success' | 'failure' | 'skipped' | 'cancelled'

export type CiCheck = {
  name: string
  state: CiState
  url: string | undefined
  startedAt: string | undefined
  completedAt: string | undefined
}

export type CiPull = {
  number: number
  title: string
  url: string
  isDraft: boolean
  state: string
  reviewDecision: string
  mergeStateStatus: string
}

export type CiSnapshot = {
  branch: string
  // The branch's PR; null when it has none (the checks are then its runs).
  pull: CiPull | null
  checks: CiCheck[]
  overall: CiState | 'none'
  fetchedAt: number
  // Why the last fetch failed; the checks are then the previous ones.
  error: string | undefined
}

// The branch the session's checkout is on; undefined off a branch (detached
// HEAD) or outside a git repository.
export type CiHead = { cwd: string; branch: string | undefined }

declare module 'claude-code' {
  interface PluginState {
    'ci-watch': { snapshot: CiSnapshot | null; head: CiHead | null }
  }
}

import { describe, expect, test } from 'claude-code/testing'

import { duration, fromPull, fromRuns, overall, summary } from '../hooks/checks'
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

  test('formats durations', () => {
    expect(duration('2026-10-12T11:20:37Z', '2026-10-12T11:35:24Z', 0)).toBe('14m47s')
    expect(duration(undefined, undefined, 0)).toBe('')
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
    on('state.get', () => ({ value: { value: SNAPSHOT, version: 1 } }))
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

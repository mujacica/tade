import { describe, expect, it } from 'vitest'
import { grantOf } from '../src/assets/access.js'
import { stripOf } from '../src/assets/pages/agent.js'

// The agent's page opens on one row of facts: how it stands, what it runs on
// and as whom, its branch, its checks and what it cost. What it looks like is
// a browser's to answer (`scripts/browser-desk.ts`); what each cell says, and
// which of the two dashes it draws, is a rule and is held here.

const SPEND = {
  usd: 1.25,
  usdExact: 1.25,
  usdEstimated: 0,
  usdListed: 0,
  usdOnPlan: 0,
  tokens: 15_000,
  tokensUnpriced: 0,
  tokensOnPlanUnrated: 0,
  hasCost: true,
}

function task(over: Record<string, unknown> = {}) {
  return {
    id: 'sentry/away-projection',
    project: 'sentry',
    name: 'away-projection',
    state: 'working',
    mark: 'working',
    reason: '4 files touched',
    stalled: false,
    harness: 'claude-code',
    model: 'claude-opus-5',
    account: { words: 'work@example.invalid', more: false },
    branch: 'tade/away-projection',
    ahead: 2,
    behind: 0,
    dirty: 7,
    workspace: 'worktree',
    shared: false,
    agents: 1,
    lanes: 2,
    spend: SPEND,
    checks: { state: 'unknown', failed: [], missing: ['tests'], overridden: false },
    ...over,
  }
}

const everything = {
  you: { reads: [grantOf('tasks.account'), grantOf('tasks.spend')] },
}
const nothing = { you: { reads: [] } }

const cell = (cells: ReturnType<typeof stripOf>, label: string) =>
  cells.find((one) => one.label === label)

describe('the agent’s row of facts', () => {
  it('says how it stands, what it runs on, as whom, where, its checks and its cost', () => {
    const cells = stripOf(task(), everything)
    expect(cells.map((one) => one.label)).toEqual([
      'State',
      'Harness',
      'Account',
      'Branch',
      'Checks',
      'Spend',
    ])
    expect(cell(cells, 'Harness')).toMatchObject({ value: 'claude-code', under: 'claude-opus-5' })
    expect(cell(cells, 'Account')?.value).toBe('work@example.invalid')
    expect(cell(cells, 'Branch')).toMatchObject({
      value: 'tade/away-projection',
      under: '2 ahead · 7 changed · worktree',
    })
    expect(cell(cells, 'Checks')).toMatchObject({ value: 'not run here', tone: 't-quiet' })
    expect(cell(cells, 'Spend')).toMatchObject({ value: '$1.25', under: '15k tokens' })
  })

  it('draws the state in the window’s own mark, and says when it has gone quiet', () => {
    const cells = stripOf(task({ stalled: true }), everything)
    expect(cell(cells, 'State')).toMatchObject({ tone: 't-working', under: 'stalled' })
  })

  it('keeps a cell for what nobody wrote down, rather than leaving it out', () => {
    const cells = stripOf(task({ harness: null, model: null, branch: null }), everything)
    expect(cell(cells, 'Harness')).toMatchObject({ value: null, under: null })
    expect(cell(cells, 'Branch')?.value).toBeNull()
  })

  it('says not granted where that is why, and never draws it as nothing recorded', () => {
    const withheld = stripOf(task({ account: null, spend: null }), nothing)
    expect(cell(withheld, 'Account')?.value).toBe('not granted')
    expect(cell(withheld, 'Spend')).toMatchObject({ value: '—', under: 'not granted' })
    const unrecorded = stripOf(task({ spend: null }), everything)
    expect(cell(unrecorded, 'Spend')).toMatchObject({ value: '—', under: 'not recorded' })
  })

  it('names a shared checkout, because uncommitted work there is nobody’s', () => {
    const cells = stripOf(
      task({ shared: true, workspace: 'checkout', ahead: 0, dirty: 0 }),
      everything,
    )
    expect(cell(cells, 'Branch')?.under).toBe('shared checkout')
  })
})

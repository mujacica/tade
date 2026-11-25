import { noHarnessSpend } from '@tade/harnesses-core'
import { describe, expect, it } from 'vitest'
import { planParts } from '../src/workbench.ts'

// What was spent while Tade was closed, as the usage lines it is written down
// in — and, for a harness that tells a plan's turns from the rest (OpenCode),
// with a plan's share on a line of its own, so it is never money of nought.

const missing = { input: 600, output: 100, cacheRead: 300, cacheWrite: 0, tokens: 1_000, usd: 0.5 }

describe('what was spent while Tade was closed', () => {
  it('is one line, as it always was, for a harness that cannot tell a plan’s turns apart', () => {
    expect(planParts(missing, noHarnessSpend(), 0)).toEqual([missing])
  })

  it('puts a plan’s share the journal has not heard of on a line of its own', () => {
    const session = {
      ...noHarnessSpend(),
      tokens: 5_000,
      plan: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 3_000, messages: 4 },
    }
    // The journal already knows 2,600 of the plan's 3,000.
    expect(planParts(missing, session, 2_600)).toEqual([
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 400, usd: 0, plan: true },
      { ...missing, tokens: 600, plan: false },
    ])
    // It knows all of them: what is missing is billed.
    expect(planParts(missing, session, 3_000)).toEqual([{ ...missing, plan: false }])
    // Nothing billed is missing: the plan's line carries every kind.
    const free = { ...missing, usd: 0 }
    expect(planParts(free, session, 0)).toEqual([{ ...free, plan: true }])
  })
})

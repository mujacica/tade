import { ConfigSchema, type LimitsSupport } from '@tade/core'
import type { PlanLimits, WorkerAdapter } from '@tade/harnesses-core'
import { describe, expect, it } from 'vitest'
import { askPlans } from '../src/accounts.ts'

// Asking every sign-in that can be asked how much of its plan is used, before
// the queue lets a start through to find out. Only one that says it can be
// asked without running anything (`anytime`), is on a plan, and has nothing
// true to say yet is asked — and what it answers is what the plan then says.

const HOUR = 3_600_000

/** A harness's adapter as far as a plan goes: what it declares, holds and answers when asked. */
function adapter(
  limits: LimitsSupport,
  usd: 'exact' | 'estimate' | 'none',
  answer: PlanLimits | null = null,
): WorkerAdapter & { asked: number } {
  let held: PlanLimits | null = null
  const one = {
    asked: 0,
    capabilities: { spend: { usd, tokens: true, limits }, why: {} },
    limits: () => held,
    askLimits: async () => {
      one.asked += 1
      if (answer) held = answer
      return answer
    },
    hold: (limits: PlanLimits) => {
      held = limits
    },
  }
  return one as unknown as WorkerAdapter & { asked: number }
}

const seen = (used: number): PlanLimits => ({
  at: Date.now(),
  windows: [{ minutes: 300, used, resetsAt: Date.now() + HOUR }],
})

describe('asking the sign-ins that can be asked for their plan', () => {
  it('asks only one that can be asked, is on a plan, and has said nothing — and goes by its answer', async () => {
    const codex = adapter('anytime', 'none', seen(12))
    const claude = adapter('while-working', 'none')
    const pi = adapter('none', 'exact')
    const acp = adapter('none', 'estimate')
    const harnesses: Record<string, WorkerAdapter & { asked: number }> = {
      codex,
      'claude-code': claude,
      pi,
      acp,
    }
    const sources = await askPlans(
      ConfigSchema.parse({}),
      { adapterFor: (harness) => harnesses[harness] ?? pi },
      2_000,
    )
    expect(codex.asked).toBe(1)
    expect(claude.asked + pi.asked + acp.asked).toBe(0)
    const said = sources.find((one) => one.harness === 'codex')?.said
    expect(said?.windows).toEqual([{ label: '5h', used: 12, resetsAt: expect.any(Number) }])
  })

  it('does not ask one that already has a true figure to say', async () => {
    const codex = adapter('anytime', 'none', seen(50))
    ;(codex as unknown as { hold: (limits: PlanLimits) => void }).hold(seen(30))
    const other = adapter('none', 'exact')
    await askPlans(
      ConfigSchema.parse({}),
      { adapterFor: (harness) => (harness === 'codex' ? codex : other) },
      2_000,
    )
    expect(codex.asked).toBe(0)
  })

  it('does not ask an account paid by key, which has no plan to be asked about', async () => {
    const own = adapter('anytime', 'none', seen(5))
    const paid = adapter('anytime', 'none', seen(5))
    const other = adapter('none', 'exact')
    await askPlans(
      ConfigSchema.parse({ accounts: { paid: { harness: 'codex', kind: 'api-key' } } }),
      {
        adapterFor: (harness, name) => (harness !== 'codex' ? other : name === 'paid' ? paid : own),
      },
      2_000,
    )
    expect(own.asked).toBe(1)
    expect(paid.asked).toBe(0)
  })

  it('asks only the sign-in a start would spend, where one is named', async () => {
    const own = adapter('anytime', 'none', seen(5))
    const work = adapter('anytime', 'none', seen(70))
    const other = adapter('none', 'exact')
    const sources = await askPlans(
      ConfigSchema.parse({ accounts: { work: { harness: 'codex', kind: 'subscription' } } }),
      {
        adapterFor: (harness, name) => (harness !== 'codex' ? other : name === 'work' ? work : own),
      },
      2_000,
      { harness: 'codex', account: 'work' },
    )
    // The other is just as unknown and just as askable, and the start would not run as it.
    expect(work.asked).toBe(1)
    expect(own.asked).toBe(0)
    const said = sources.find((one) => one.harness === 'codex' && one.account === 'work')?.said
    expect(said?.windows).toEqual([{ label: '5h', used: 70, resetsAt: expect.any(Number) }])
  })

  it('says what it heard by how long each window is: a lone one of thirty days is 30d', async () => {
    // The ChatGPT free plan, as Codex's app server answered it live: one window of 43,200 minutes.
    const lone: PlanLimits = {
      at: Date.now(),
      windows: [{ minutes: 43_200, used: 4, resetsAt: Date.now() + 20 * 24 * HOUR }],
    }
    const codex = adapter('anytime', 'none', lone)
    const other = adapter('none', 'exact')
    const sources = await askPlans(
      ConfigSchema.parse({}),
      { adapterFor: (harness) => (harness === 'codex' ? codex : other) },
      2_000,
    )
    const said = sources.find((one) => one.harness === 'codex')?.said
    expect(said?.windows.map((one) => one.label)).toEqual(['30d'])
  })

  it('leaves a sign-in that could not answer as unknown as it was', async () => {
    const codex = adapter('anytime', 'none', null)
    const other = adapter('none', 'exact')
    const sources = await askPlans(
      ConfigSchema.parse({}),
      { adapterFor: (harness) => (harness === 'codex' ? codex : other) },
      2_000,
    )
    expect(codex.asked).toBe(1)
    expect(sources.find((one) => one.harness === 'codex')?.said).toBeNull()
  })
})

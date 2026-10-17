import { describe, expect, it } from 'vitest'
import { BudgetSchema, checkBudget, startBudget } from '../src/budget.ts'
import { ConfigSchema } from '../src/config.ts'
import { noSpend } from '../src/spend.ts'

const spend = (over: Partial<ReturnType<typeof noSpend>> = {}) => ({ ...noSpend(), ...over })

describe('checkBudget', () => {
  it('says nothing when no budget was set', () => {
    expect(checkBudget(spend({ usd: 999 }), undefined)).toEqual({ verdict: 'ok', reason: '' })
    expect(checkBudget(spend({ usd: 999 }), {})).toEqual({ verdict: 'ok', reason: '' })
  })

  it('warns before it stops you', () => {
    // A long run dying at 100% with no warning is how people lose work.
    expect(checkBudget(spend({ usd: 7.9 }), { usd_per_day: 10 }).verdict).toBe('ok')
    expect(checkBudget(spend({ usd: 8 }), { usd_per_day: 10 }).verdict).toBe('warn')
    expect(checkBudget(spend({ usd: 10 }), { usd_per_day: 10 }).verdict).toBe('over')
  })

  it('says what the number actually is', () => {
    const state = checkBudget(spend({ usd: 8.5 }), { usd_per_day: 10 })
    expect(state.reason).toBe('$8.50 of $10.00 today')
  })

  it('polices tokens for providers that report no money', () => {
    const state = checkBudget(spend({ tokens: 1_000_000 }), { tokens_per_day: 1_000_000 })
    expect(state.verdict).toBe('over')
    expect(state.reason).toContain('tokens today')
  })

  it('takes the strictest of the two', () => {
    const state = checkBudget(spend({ usd: 1, tokens: 999 }), {
      usd_per_day: 100,
      tokens_per_day: 1000,
    })
    // Nowhere near the money, but at the token ceiling.
    expect(state.verdict).toBe('warn')
  })

  it('ignores a limit of zero rather than refusing everything', () => {
    expect(checkBudget(spend({ usd: 1 }), { usd_per_day: 0 }).verdict).toBe('ok')
  })
})

describe('the machine’s budget, beside each project’s', () => {
  it('has no amount until somebody writes one', () => {
    // Any figure Tade picked would be wrong for somebody: a cap that stops a
    // wanted day at noon, or one that never caps.
    const config = ConfigSchema.parse({})
    expect(config.budget).toEqual({})
    const at = startBudget({
      project: 'app',
      spent: { project: spend({ usd: 500 }), machine: spend({ usd: 5_000 }) },
      budgets: { project: undefined, machine: config.budget },
    })
    expect(at).toEqual({ verdict: 'ok', said: '' })
  })

  it('refuses the start that would go past it, though every project is inside its own', () => {
    // A schedule that fans out across six projects, each well inside its own
    // budget, is the night this exists for.
    const at = startBudget({
      project: 'app',
      spent: { project: spend({ usd: 3 }), machine: spend({ usd: 20 }) },
      budgets: { project: { usd_per_day: 10 }, machine: { usd_per_day: 20 } },
    })
    expect(at.verdict).toBe('over')
    expect(at.said).toBe(
      'this machine has spent its budget for today, every project together: $20.00 of $20.00 today',
    )
  })

  it('names every budget at the verdict, so nobody raises the wrong number', () => {
    const both = startBudget({
      project: 'app',
      spent: { project: spend({ usd: 10 }), machine: spend({ usd: 25 }) },
      budgets: { project: { usd_per_day: 10 }, machine: { usd_per_day: 20 } },
    })
    expect(both.said).toBe(
      'app has spent its budget for today: $10.00 of $10.00 today; and this machine has spent its budget for today, every project together: $25.00 of $20.00 today',
    )
    // The worse one decides, and only it is said: a warning beside a refusal
    // is not what anybody needs to act on first.
    const worse = startBudget({
      project: 'app',
      spent: { project: spend({ usd: 8 }), machine: spend({ usd: 20 }) },
      budgets: { project: { usd_per_day: 10 }, machine: { usd_per_day: 20 } },
    })
    expect(worse.verdict).toBe('over')
    expect(worse.said).not.toContain('app is near')
  })

  it('warns on the machine before it stops anything', () => {
    const at = startBudget({
      project: 'app',
      spent: { project: spend(), machine: spend({ tokens: 850_000 }) },
      budgets: { project: undefined, machine: { tokens_per_day: 1_000_000 } },
    })
    // The figure is in the runner's own digits (`toLocaleString`), so only its shape is held.
    expect(at.verdict).toBe('warn')
    expect(at.said).toMatch(
      /^this machine is near its budget, every project together: .+ tokens today$/,
    )
  })

  it('takes only a figure that means an amount', () => {
    expect(BudgetSchema.safeParse({ usd_per_day: 0 }).success).toBe(false)
    expect(BudgetSchema.safeParse({ tokens_per_day: 1.5 }).success).toBe(false)
    expect(BudgetSchema.safeParse({ usd: 5 }).success).toBe(false)
    const refused = ConfigSchema.safeParse({ budget: { usd_per_day: -1 } })
    expect(refused.success).toBe(false)
    expect(refused.error?.issues[0]?.path).toEqual(['budget', 'usd_per_day'])
  })
})

import { type Config, ConfigSchema, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { guardBudget } from '../src/budget.ts'

// The check every start goes through: its project's budget and the machine's,
// asked of what the journal says was spent today, refused past either and
// warned near either — and a journal that would not open said, never read as
// nothing spent.

const NOW = new Date(2026, 9, 17, 12).getTime()

/** A dollar billed per token, today, against `task`. */
function spent(task: string, usd: number): TadeEvent {
  return {
    seq: 1,
    ts: new Date(NOW - 60_000).toISOString(),
    type: 'usage',
    urgency: 'trace',
    task,
    lane: null,
    run: null,
    detail: { tokens: 1_000, usd, priced: 'exact' },
  } as TadeEvent
}

function bench(config: unknown, usage: readonly TadeEvent[] | Error) {
  const appended: TadeEvent[] = []
  return {
    appended,
    tade: {
      config: ConfigSchema.parse(config),
      log: {
        read: async () => {
          if (usage instanceof Error) throw usage
          return [...usage]
        },
        append: async (line: Partial<TadeEvent>) => {
          appended.push(line as TadeEvent)
          return line as TadeEvent
        },
      },
    } as never,
  }
}

describe('the budget a start is held to', () => {
  it('refuses a start past the machine’s, though its own project is inside its budget', async () => {
    const { tade } = bench(
      {
        budget: { usd_per_day: 10 },
        projects: { app: { root: '/a', budget: { usd_per_day: 50 } } },
      },
      [spent('app/one', 4), spent('web/two', 7)],
    )
    await expect(guardBudget(tade, 'app/three', NOW)).rejects.toThrow(
      'this machine has spent its budget for today, every project together: $11.00 of $10.00 today',
    )
  })

  it('refuses a start past its project’s, as it always did', async () => {
    const { tade } = bench({ projects: { app: { root: '/a', budget: { usd_per_day: 5 } } } }, [
      spent('app/one', 6),
    ])
    await expect(guardBudget(tade, 'app/two', NOW)).rejects.toThrow(
      'app has spent its budget for today: $6.00 of $5.00 today',
    )
  })

  it('holds the next start to a project’s budget written since the window opened', async () => {
    // Which is why its row in Settings applies now rather than on restart:
    // Settings hands the workbench the config as it is (`Settings.use`), and
    // every start reads its budget out of that.
    const { tade } = bench({ projects: { app: { root: '/a' } } }, [spent('app/one', 6)])
    await guardBudget(tade, 'app/two', NOW)
    ;(tade as { config: Config }).config = ConfigSchema.parse({
      projects: { app: { root: '/a', budget: { usd_per_day: 5.5 } } },
    })
    await expect(guardBudget(tade, 'app/three', NOW)).rejects.toThrow(
      'app has spent its budget for today: $6.00 of $5.50 today',
    )
  })

  it('warns near the machine’s, and lets the start go', async () => {
    const it_ = bench({ budget: { usd_per_day: 10 } }, [spent('app/one', 8.5)])
    await guardBudget(it_.tade, 'app/two', NOW)
    expect(it_.appended).toMatchObject([
      {
        type: 'warning',
        task: 'app/two',
        detail: {
          message: 'this machine is near its budget, every project together: $8.50 of $10.00 today',
        },
      },
    ])
  })

  it('reads nothing where no budget is set anywhere', async () => {
    const it_ = bench({}, new Error('nobody should have asked'))
    await guardBudget(it_.tade, 'app/one', NOW)
    expect(it_.appended).toEqual([])
  })

  it('says a journal that would not open, rather than reading it as nothing spent', async () => {
    const it_ = bench({ budget: { usd_per_day: 10 } }, new Error('EIO'))
    await guardBudget(it_.tade, 'app/one', NOW)
    expect(it_.appended[0]?.detail.message).toBe(
      'could not read the journal (EIO), so no budget was checked before app/one started: what was spent today is unknown, not nought',
    )
  })
})

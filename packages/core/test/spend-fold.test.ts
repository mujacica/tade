import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import { pricesFrom } from '../src/prices.ts'
import { modelIn, modelsSaid, runFactsFrom, type SpendReport, spendFrom } from '../src/spend.ts'
import { UsageFold } from '../src/spend-fold.ts'

// The usage lines a window keeps, merged as they arrive. The whole claim is
// that nothing folded out of the merged list can tell it from the lines it was
// made of, so that is what is tested: the same journal both ways, asked from
// every kind of moment a range can start at.

const QUARTER = 15 * 60_000
const START = Date.parse('2026-10-01T00:00:00Z')
const DAYS = 3

/** A small deterministic generator, so a failure is the same failure on every run. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

/**
 * The agents a journal is written by: each says the same things about itself
 * on every turn, as a real one does, and they differ in every way `spendFrom`
 * reads differently — billed or on a plan, priced by its harness or by a rate,
 * with its tokens broken down or as a total only, a run or none.
 */
const AGENTS: readonly {
  task: string | null
  run: string | null
  detail: Record<string, unknown>
}[] = [
  {
    task: 'shop/refunds',
    run: 'shop/refunds/agent',
    detail: {
      model: 'claude-opus-5',
      priced: 'none',
      harness: 'claude-code',
      provider: 'anthropic',
    },
  },
  {
    task: 'shop/search',
    run: 'shop/search/agent',
    detail: { model: 'gpt-5', priced: 'exact', harness: 'codex' },
  },
  {
    task: 'tade/fold',
    run: 'tade/fold/agent',
    detail: {
      model: 'anthropic/claude-opus-5',
      priced: 'estimate',
      harness: 'pi',
      account: 'work',
    },
  },
  { task: 'tade/old', run: 'tade/old/agent', detail: { model: 'nobody-prices-this' } },
  { task: null, run: null, detail: { model: 'claude-opus-5', by: 'orchestrator', harness: 'pi' } },
  {
    task: 'shop/refunds',
    run: 'shop/refunds/agent',
    detail: { model: 'claude-sonnet-5', priced: 'none', harness: 'claude-code' },
  },
  // Billed through an account, by a harness that prices nothing: a turn that
  // reported a figure is that figure, and one that reported nought is priced
  // at a published rate — so a nought and a figure are never one line.
  {
    task: 'shop/api',
    run: 'shop/api/agent',
    detail: { model: 'claude-opus-5', priced: 'none', harness: 'claude-code', account: 'work' },
  },
]

/** A journal of usage lines, in sequence order: turns spread over days, and a burst around `busy`. */
function journal(seed: number, count: number, busy: number): TadeEvent[] {
  const next = random(seed)
  const pick = <T>(of: readonly T[]): T => of[Math.floor(next() * of.length)] as T
  const at = Array.from({ length: count }, (_, i) =>
    i % 5 === 0
      ? busy + Math.floor((next() - 0.5) * 20 * 60_000)
      : START + Math.floor(next() * DAYS * 86_400_000),
  )
  at.sort((a, b) => a - b)
  return at.map((ms, index) => {
    const agent = pick(AGENTS)
    const n = (most: number) => Math.floor(next() * most)
    const counts: Record<string, unknown> =
      agent.detail.model === 'nobody-prices-this'
        ? { tokens: n(60_000), usd: 0 }
        : {
            // Now and then a turn with no breakdown at all, which a plan's
            // published rate cannot be put on.
            ...(next() < 0.25
              ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
              : {
                  input: 1 + n(1000),
                  output: 1 + n(500),
                  cacheRead: 1 + n(50_000),
                  cacheWrite: agent.detail.harness === 'codex' ? 0 : 1 + n(200),
                }),
            tokens: n(60_000),
            usd:
              agent.task === 'shop/api' || agent.task === 'tade/fold'
                ? pick([0, 1.5])
                : agent.detail.priced === 'none'
                  ? 0
                  : pick([0.0123, 1.5]),
          }
    return {
      seq: index + 1,
      ts: next() < 0.005 ? 'not a time' : new Date(ms).toISOString(),
      type: 'usage',
      urgency: 'routine',
      task: agent.task,
      lane: null,
      run: agent.run,
      detail: { ...agent.detail, ...counts },
    } as TadeEvent
  })
}

/** Every figure, rounded past where adding in another order could move it. */
function rounded(report: SpendReport): unknown {
  return JSON.parse(
    JSON.stringify(report, (_key, value) =>
      typeof value === 'number' ? Math.round(value * 1e9) / 1e9 : value,
    ),
  )
}

/** The last model each task said, the way the Spend page names a row's model. */
function lastModels(events: readonly TadeEvent[], since: number): Map<string | null, string> {
  const models = new Map<string | null, string>()
  for (const event of events) {
    const at = Date.parse(event.ts)
    if (Number.isFinite(at) && at < since) continue
    if (event.task) models.set(event.task, modelIn(event).name)
    else if (event.detail.by === 'orchestrator') models.set(null, modelIn(event).name)
  }
  return models
}

function folded(lines: readonly TadeEvent[], opened: number): UsageFold {
  const fold = new UsageFold(opened)
  for (const line of lines) fold.add(line)
  return fold
}

describe('folding usage as it is written', () => {
  // Not on any quarter hour, as the moment a window opened never is.
  const opened = START + 4 * 86_400_000 + 7 * 60_000 + 13_457
  const lines = journal(7, 12_000, opened)
  const fold = folded(lines, opened)

  it('keeps far fewer lines than it was handed', () => {
    expect(fold.size).toBe(lines.length)
    expect(fold.events.length).toBeLessThan(lines.length / 3)
  })

  it('answers every range the way the lines themselves do', () => {
    const next = random(11)
    // Every quarter hour a range can start on — a midnight in any zone, and a
    // whole number of days before one across a change of clocks — and the
    // window's own moment, and the whole journal.
    const starts = [0, opened, opened + 1, opened - 1]
    for (let i = 0; i < 40; i++) {
      starts.push(START + Math.floor(next() * DAYS * 96) * QUARTER)
    }
    const runs = runFactsFrom([
      {
        seq: 0,
        ts: new Date(START).toISOString(),
        type: 'run_started',
        urgency: 'routine',
        task: 'shop/refunds',
        lane: null,
        run: 'shop/refunds/agent',
        detail: { adapter: 'pi', provider: 'openrouter' },
      } as TadeEvent,
    ])
    const prices = pricesFrom({ 'nobody-prices-this': { input: 1, output: 2 } })
    for (const since of starts) {
      for (const window of [{ since }, { since, runs, prices }]) {
        expect(rounded(spendFrom(fold.events, window)), String(since)).toEqual(
          rounded(spendFrom(lines, window)),
        )
      }
      expect(lastModels(fold.events, since)).toEqual(lastModels(lines, since))
    }
    // The last model each run said, which is what runtime names a run by.
    expect(modelsSaid(fold.events)).toEqual(modelsSaid(lines))
  })

  it('merges a quarter hour of one agent into one line, and keeps the counts', () => {
    const at = Date.parse('2026-10-02T09:00:00Z')
    const turns = Array.from(
      { length: 400 },
      (_, i) =>
        ({
          seq: i + 1,
          ts: new Date(at + i * 2_000).toISOString(),
          type: 'usage',
          urgency: 'routine',
          task: 'shop/refunds',
          lane: null,
          run: 'shop/refunds/agent',
          detail: { model: 'claude-opus-5', input: 10, output: 5, tokens: 15, usd: 0.5 },
        }) as TadeEvent,
    )
    const one = folded(turns, 0)
    expect(one.events).toHaveLength(1)
    expect(one.events[0]?.detail).toMatchObject({ input: 4_000, output: 2_000, tokens: 6_000 })
    expect(one.events[0]?.seq).toBe(400)
    expect(one.events[0]?.ts).toBe(turns.at(-1)?.ts)
  })

  it('lists what arrived out of order in sequence order, with the same answers', () => {
    const shuffled = [...lines].reverse()
    const late = folded(shuffled, opened)
    const seqs = late.events.map((line) => line.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(rounded(spendFrom(late.events, { since: opened }))).toEqual(
      rounded(spendFrom(lines, { since: opened })),
    )
  })

  it('keeps a line with a count below nought on its own, and anything else it is handed out', () => {
    const base = lines[0] as TadeEvent
    const odd = (seq: number) => ({ ...base, seq, detail: { ...base.detail, tokens: -5 } })
    const other = { ...base, seq: 9_003, type: 'run_started' } as TadeEvent
    const fold = folded([base, odd(9_001), odd(9_002), other], 0)
    expect(fold.events.map((line) => line.seq)).toEqual([base.seq, 9_001, 9_002])
    expect(fold.size).toBe(3)
  })
})

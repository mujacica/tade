import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, type TadeEvent } from '@tade/core'
import { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { Live } from '../src/live.ts'

// What a frame costs to say what has been spent today.
//
// `facts()` is read on every frame — four times a second, whether anything is
// happening or not — and it asked `spendToday()`, which folded every usage
// event of the last week. Twenty-four thousand of them on a week-old journal
// was 3% of a core, burned re-deriving a number that only moves when an agent
// spends something; on a window with no agents running, nothing ever does.
//
// `spendFrom` is pure and `usage` only ever grows, so the same events over the
// same day are the same answer, and the fold belongs once per event rather than
// once per frame. Asserted as a ratio against the first fold, never as a rate
// the machine has to hit: a slow machine makes both numbers bigger and this
// still means what it says.

/** How many repeat reads to make the frame's cost out of. */
const REPEATS = 200

/**
 * What the repeats may cost, measured in cold folds.
 *
 * Two hundred folds of the week would be two hundred. Two hundred reads of a
 * memo is somewhere near zero, and three is the slack that leaves for a clock
 * read and a machine under load.
 */
const BUDGET = 3

/** Usage events, spread over today so the day window keeps all of them. */
function usage(home: string, events: number, at: number): void {
  const lines: string[] = []
  for (let seq = 1; seq <= events; seq++) {
    lines.push(
      JSON.stringify({
        seq,
        ts: new Date(at - (events - seq) * 1000).toISOString(),
        type: 'usage',
        urgency: 'routine',
        task: `app/task-${seq % 40}`,
        run: `run-${seq % 40}`,
        detail: {
          input: 100,
          output: 20,
          tokens: 120,
          usd: 0.0001,
          priced: 'exact',
          model: 'claude-opus-5',
          harness: 'pi',
        },
      }),
    )
  }
  writeFileSync(join(home, 'events.jsonl'), `${lines.join('\n')}\n`)
}

const opened: { live: Live; client: Workbench }[] = []

afterEach(async () => {
  for (const one of opened.splice(0)) {
    await one.live.stop().catch(() => {})
    await one.client.close().catch(() => {})
  }
})

/**
 * A `Live` over a home whose journal already holds a week of spending, and the
 * one door events reach it through.
 *
 * The listener is the workbench's own: `Live` registers it on `subscribe`, and
 * an appended event is handed to it exactly like this. Taking it here is what
 * lets a test spend something without driving a harness and a model to do it.
 */
async function liveOver(
  events: number,
  now: () => number,
): Promise<{ live: Live; spend: (event: Partial<TadeEvent>) => void }> {
  const home = mkdtempSync(join(tmpdir(), 'tade-spend-probe-'))
  usage(home, events, now())
  const client = await Workbench.open({ home })
  let heard: ((event: TadeEvent) => void) | null = null
  const watched = new Proxy(client, {
    get(target, key: string | symbol, receiver) {
      if (key !== 'subscribe') return Reflect.get(target, key, receiver)
      return async (fn: (event: TadeEvent) => void) => {
        heard = fn
        return await client.subscribe(fn)
      }
    },
  })
  const live = await Live.start({
    client: watched,
    config: ConfigSchema.parse({ projects: {} }),
    home,
    tadeHome: home,
    // Far longer than the test: what the beat looks at is not what is measured
    // here, and a probe racing a background refresh measures the refresh.
    pollMs: 600_000,
    now,
  })
  opened.push({ live, client })
  let seq = events + 1
  return {
    live,
    spend: (event) =>
      heard?.({
        seq: seq++,
        ts: new Date(now()).toISOString(),
        urgency: 'routine',
        lane: null,
        run: null,
        task: null,
        ...event,
      } as TadeEvent),
  }
}

function millis(fn: () => void): number {
  const at = performance.now()
  fn()
  return performance.now() - at
}

describe('what a frame costs to say what was spent', () => {
  it('folds the week once, not once per frame', async () => {
    // Noon, so today's window holds everything written above it.
    const now = Date.parse('2026-09-20T12:00:00Z')
    const { live } = await liveOver(20_000, () => now)

    const cold = millis(() => {
      live.spendToday()
    })
    const warm = millis(() => {
      for (let i = 0; i < REPEATS; i++) live.spendToday()
    })

    expect(warm).toBeLessThan(cold * BUDGET)
  })

  it('counts what was spent since the last frame', async () => {
    const now = Date.parse('2026-09-20T12:00:00Z')
    const { live, spend } = await liveOver(100, () => now)
    const before = live.spendToday().total.tokens
    expect(before).toBeGreaterThan(0)

    spend({
      type: 'usage',
      task: 'app/task-new',
      detail: { input: 5_000, output: 0, tokens: 5_000, usd: 1, priced: 'exact' },
    })

    expect(live.spendToday().total.tokens).toBe(before + 5_000)
  })

  it('starts the total again when the day does', async () => {
    let now = Date.parse('2026-09-20T12:00:00Z')
    const { live } = await liveOver(100, () => now)
    expect(live.spendToday().total.tokens).toBeGreaterThan(0)

    // A window left open overnight must not go on showing yesterday's total:
    // what is spent today is a different question the moment today changes.
    now += 86_400_000
    expect(live.spendToday().total.tokens).toBe(0)
  })
})

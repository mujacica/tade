import type { Napping } from '@tade/core'
import { AWAY_AFTER_MS } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { type Napped, Waker } from '../../src/wire/sleep.ts'

// A laptop that went to sleep with agents working in it, and the window that
// finds them when it comes back.
//
// The waker is given its own agents and its own clock — never the machine the
// suite runs on, which would make every assertion here a fact about somebody's
// power settings, and which a test may not put to sleep anyway. What is under
// test is the decision and the bookkeeping: who is told, how often, and what
// happens when telling one fails.

const HOUR = 60 * 60_000

/** An agent working on a harness that can pick a cut-off turn back up. */
function working(over: Partial<Napping> = {}): Napping {
  return { task: 'app/refunds', run: 'r_1', turn: 'running', alive: true, continues: true, ...over }
}

/** A window's worth of agents, and everything the waker did to them. */
function bed(agents: Napping[], fails?: (agent: Napping) => string | null) {
  const told: { task: string; slept: number }[] = []
  const said: string[] = []
  const napped: Napped = {
    agents: () => agents,
    continue: async (agent, slept) => {
      const why = fails?.(agent) ?? null
      if (why) throw new Error(why)
      told.push({ task: agent.task, slept })
    },
  }
  return { told, said, waker: new Waker(napped, (one) => said.push(one)) }
}

/** Beat at each of these, letting whatever a wake started finish before the next. */
async function beats(waker: Waker, ...times: readonly number[]): Promise<void> {
  for (const at of times) {
    waker.beats(at)
    // The telling is asynchronous on purpose, so the beat itself never waits
    // on an agent. Nothing here asserts before it has landed.
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('the window, and a machine that went to sleep under it', () => {
  it('tells an agent that was mid-turn to carry on, once it is back', async () => {
    const { told, said, waker } = bed([working()])
    await beats(waker, 1_000, 1_250, 1_250 + 3 * HOUR)
    expect(told).toEqual([{ task: 'app/refunds', slept: 3 * HOUR }])
    expect(said).toEqual(['back after 3h asleep — app/refunds told to carry on where it stopped'])
  })

  it('leaves an agent that was idle at its prompt entirely alone', async () => {
    // It was waiting on a person before the laptop shut, and it is waiting on
    // one now. Nothing was interrupted, so nothing is said either.
    const { told, said, waker } = bed([working({ turn: 'idle' })])
    await beats(waker, 1_000, 1_000 + 3 * HOUR)
    expect(told).toEqual([])
    expect(said).toEqual([])
  })

  it('reads what an agent was doing before the machine went, not after', async () => {
    // The race this exists for: on the wake the harness resumes, finds its
    // request dead and says its turn is over — so by the time anything looks,
    // the interrupted agent reports `idle`. What decides is the beat before.
    const agents = [working()]
    const { told, waker } = bed(agents)
    await beats(waker, 1_000)
    agents[0] = working({ turn: 'idle' })
    await beats(waker, 1_000 + 3 * HOUR)
    expect(told.map((one) => one.task)).toEqual(['app/refunds'])
  })

  it('never tells an agent that started after the machine came back', async () => {
    // It cannot have been interrupted by a sleep it was not there for, and its
    // turn running now is it working, not it stuck.
    const agents: Napping[] = []
    const { told, waker } = bed(agents)
    await beats(waker, 1_000)
    agents.push(working({ task: 'app/search', run: 'r_2' }))
    await beats(waker, 1_000 + 3 * HOUR)
    expect(told).toEqual([])
  })

  it('never tells one whose harness says it cannot pick a cut-off turn back up', async () => {
    const { told, said, waker } = bed([working({ continues: false })])
    await beats(waker, 1_000, 1_000 + 3 * HOUR)
    expect(told).toEqual([])
    expect(said).toEqual([])
  })

  it('never tells one whose lane has gone, which is reopening rather than continuing', async () => {
    const { told, waker } = bed([working({ alive: false })])
    await beats(waker, 1_000, 1_000 + 3 * HOUR)
    expect(told).toEqual([])
  })

  it('tells each interrupted agent once, and says it once, however long it keeps beating', async () => {
    // The loop guard. Four beats a second against a window full of agents is
    // exactly the retry storm, and it would be one turn each every time.
    const { told, said, waker } = bed([
      working({ task: 'app/refunds', run: 'r_1' }),
      working({ task: 'app/search', run: 'r_2', turn: 'idle' }),
      working({ task: 'app/tests', run: 'r_3' }),
    ])
    const woke = 1_000 + 3 * HOUR
    await beats(waker, 1_000, woke, woke + 250, woke + 500, woke + 750, woke + 1_000)
    expect(told.map((one) => one.task)).toEqual(['app/refunds', 'app/tests'])
    expect(said).toEqual(['back after 3h asleep — 2 agents told to carry on where they stopped'])
  })

  it('tells them again after the next sleep, which is a new thing that happened', async () => {
    const { told, waker } = bed([working()])
    const first = 1_000 + 3 * HOUR
    await beats(waker, 1_000, first, first + 250, first + 250 + 3 * HOUR)
    expect(told).toHaveLength(2)
  })

  it('says why an agent could not be told, and does not nudge it again for that wake', async () => {
    // An agent that dies as the machine comes back is a person's to look at,
    // not something to try again four times a second until they do.
    const { told, said, waker } = bed([working()], () => 'no such run: r_1')
    const woke = 1_000 + 3 * HOUR
    await beats(waker, 1_000, woke, woke + 250, woke + 500)
    expect(told).toEqual([])
    expect(said).toEqual([
      'app/refunds was cut off when the machine slept and could not be told to carry on: no such run: r_1',
    ])
  })

  it('says nothing at all about a gap that is only a busy machine', async () => {
    const { told, said, waker } = bed([working()])
    await beats(waker, 1_000, 1_000 + AWAY_AFTER_MS - 1)
    expect(told).toEqual([])
    expect(said).toEqual([])
  })

  it('is silent on the first beat of a window, however long Tade was closed', async () => {
    // Opening a window is not a machine waking. The agents it finds were
    // working before it opened, and every one of them would be nudged.
    const { told, said, waker } = bed([working()])
    await beats(waker, Date.now())
    expect(told).toEqual([])
    expect(said).toEqual([])
  })
})

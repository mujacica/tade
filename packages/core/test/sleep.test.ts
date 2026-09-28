import { describe, expect, it } from 'vitest'
import {
  AWAKE,
  AWAY_AFTER_MS,
  awakeArgs,
  awakeSaid,
  beat,
  CONTINUE,
  couldNotContinue,
  KEEP_AWAKE_MEANS,
  type Napping,
  NO_HOLD_HERE,
  toContinue,
  wokeSaid,
} from '../src/sleep.ts'

// The machine going away under the agents, as a table.
//
// Everything here is a fold over beats and what the agents were doing, so
// none of it reads a clock or knows what a harness is — which is the point:
// the two things this must never get wrong are calling a busy machine a
// sleeping one, and nudging an agent that was never interrupted.

/** An agent that was mid-turn on a harness that can pick one back up. */
function napping(over: Partial<Napping> = {}): Napping {
  return { task: 'app/refunds', run: 'r_1', turn: 'running', alive: true, continues: true, ...over }
}

/** Beats, in order, from a window that has just opened. */
function beats(...times: readonly number[]) {
  let waking = AWAKE
  return times.map((at) => {
    waking = beat(waking, at)
    return waking
  })
}

const HOUR = 60 * 60_000

describe('noticing the machine came back', () => {
  it('is a gap between two beats, and the gap is how long it was away', () => {
    const [, woke] = beats(1_000, 1_000 + HOUR)
    expect(woke?.slept).toBe(HOUR)
    expect(woke?.wakes).toBe(1)
  })

  it('is never the first beat of a window', () => {
    // A window opening is not a machine waking. Every agent it finds is one it
    // is adopting, and nudging all of them on open is the retry storm.
    const [first] = beats(Date.now())
    expect(first?.slept).toBeNull()
    expect(first?.wakes).toBe(0)
  })

  it('is said on the beat that noticed, and on no other', () => {
    // Four beats a second: a wake read twice is an agent told twice.
    const [, woke, after, later] = beats(1_000, 1_000 + HOUR, 1_250 + HOUR, 1_500 + HOUR)
    expect(woke?.slept).toBe(HOUR)
    expect(after?.slept).toBeNull()
    expect(later?.slept).toBeNull()
    expect(later?.wakes).toBe(1)
  })

  it('is not a slow look, and not a clock put back', () => {
    // Well under the threshold: a machine swapping, a look that took its time,
    // an event loop that stalled. None of them is a laptop that went away.
    expect(beats(1_000, 1_000 + AWAY_AFTER_MS - 1)[1]?.slept).toBeNull()
    expect(beats(1_000, 1_000 + AWAY_AFTER_MS)[1]?.slept).toBe(AWAY_AFTER_MS)
    // An NTP correction, or a test driving its own clock backwards.
    expect(beats(HOUR, 1_000)[1]?.slept).toBeNull()
  })

  it('counts each sleep separately, so a laptop that naps twice wakes twice', () => {
    const [, first, , second] = beats(0, HOUR, HOUR + 250, 2 * HOUR)
    expect(first?.wakes).toBe(1)
    expect(second?.wakes).toBe(2)
    expect(second?.slept).toBe(HOUR - 250)
  })
})

describe('who a wake is worth telling', () => {
  const none = new Map<string, number>()

  it('is an agent that was in the middle of a turn', () => {
    expect(toContinue([napping()], none, 1)).toHaveLength(1)
  })

  it('is never one sitting idle at its prompt', () => {
    // It was not doing anything when the machine went, so it has nothing to
    // carry on — and being told to is a turn it did not ask for.
    expect(toContinue([napping({ turn: 'idle' })], none, 1)).toEqual([])
  })

  it('is never one that never said what it was doing', () => {
    // `unknown` is a first-class answer and is not `running`. An agent adopted
    // from a closed window has said nothing, and there are always several.
    expect(toContinue([napping({ turn: 'unknown' })], none, 1)).toEqual([])
  })

  it('is never one whose lane has gone: that is reopening, not continuing', () => {
    expect(toContinue([napping({ alive: false })], none, 1)).toEqual([])
  })

  it('is never one whose harness says it cannot pick a cut-off turn back up', () => {
    // Declared by the harness, not guessed at here. What a person gets instead
    // is the harness's own sentence, and never a nudge that makes it work twice.
    expect(toContinue([napping({ continues: false })], none, 1)).toEqual([])
  })

  it('picks the interrupted ones out of a window full of agents', () => {
    const agents = [
      napping({ task: 'app/refunds', run: 'r_1' }),
      napping({ task: 'app/search', run: 'r_2', turn: 'idle' }),
      napping({ task: 'app/tests', run: 'r_3' }),
      napping({ task: 'app/docs', run: 'r_4', turn: 'unknown' }),
    ]
    expect(toContinue(agents, none, 1).map((one) => one.task)).toEqual(['app/refunds', 'app/tests'])
  })

  it('is once per wake per agent, however many beats go by', () => {
    // The whole of the loop guard: an agent told for this wake is passed over
    // four times a second until the machine sleeps again.
    const told = new Map([['r_1', 1]])
    expect(toContinue([napping()], told, 1)).toEqual([])
    // A second sleep is a genuinely new event, and gets its own continue.
    expect(toContinue([napping()], told, 2)).toHaveLength(1)
  })
})

describe('what is said', () => {
  it('tells the agent the gap was the machine, and not to start over', () => {
    // The nudge, and the whole of it: an agent told its opening instruction
    // again does the work twice.
    expect(CONTINUE).toContain('sleep')
    expect(CONTINUE).toContain('do not start the task over')
  })

  it('names who was put back to work, and how long the machine was gone', () => {
    expect(wokeSaid(3 * HOUR, ['app/refunds'])).toBe(
      'back after 3h asleep — app/refunds told to carry on where it stopped',
    )
    expect(wokeSaid(90 * 60_000, ['app/refunds', 'app/tests'])).toBe(
      'back after 1h 30m asleep — 2 agents told to carry on where they stopped',
    )
  })

  it('says why an agent could not be told, which is a person to fix rather than another nudge', () => {
    expect(couldNotContinue('app/refunds', 'no such run: r_1')).toContain('app/refunds')
    expect(couldNotContinue('app/refunds', 'no such run: r_1')).toContain('no such run: r_1')
  })
})

describe('holding the sleep off in the first place', () => {
  it('asks for the machine and never for the display', () => {
    // The whole of the security argument: the screen dims and locks on its own
    // timer, so a machine held up to work is no more readable by somebody
    // walking past than one that is not.
    const args = awakeArgs(4_242)
    expect(args).not.toContain('-d')
    expect(args).not.toContain('-u')
  })

  it('asks for both assertions, because one of them does nothing on battery', () => {
    // `-s` is valid only on AC power, so it alone is a hold that quietly stops
    // holding the moment somebody unplugs — a button saying it is holding and
    // not. `-i` is what covers that, and neither touches the display.
    const args = awakeArgs(4_242)
    expect(args).toContain('-s')
    expect(args).toContain('-i')
  })

  it('waits on Tade’s own process, so nothing outlives the window', () => {
    // Tied to a pid and not to a clock: a timeout would have to be renewed by
    // something on a timer, and a renewal nobody watched failing is a machine
    // that never sleeps again. This way a crash releases it too.
    expect(awakeArgs(4_242)).toEqual(['-s', '-i', '-w', '4242'])
  })

  it('says both halves of the answer wherever either is described', () => {
    // The two features are one answer: the hold prevents the sleep, and the
    // wake picks up whatever slept anyway. Said together, or somebody reads
    // them as two things to choose between.
    expect(KEEP_AWAKE_MEANS).toContain('agents keep running while Tade is open')
    expect(KEEP_AWAKE_MEANS).toContain('picked up when the machine wakes')
    expect(NO_HOLD_HERE).toContain('caffeinate')
    expect(NO_HOLD_HERE).toContain('carry on when it wakes')
  })

  it('says what the press changed, in the terms it changed them', () => {
    expect(awakeSaid(true)).toContain('stays awake while Tade is open')
    // And what it does not change, which is the question somebody turning it
    // on is actually asking.
    expect(awakeSaid(true)).toContain('screen still locks')
    expect(awakeSaid(false)).toContain('told to carry on when the machine wakes')
  })
})

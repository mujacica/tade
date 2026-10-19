import { LaneClosedError, LaneNotFoundError } from '@tade/drivers-core'
import type { TurnIn } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { knownKeys, Lanes, MOST_PER_DEVICE, WATCH_MS } from '../../src/wire/web-lanes.ts'

// What the away view holds of agents' screens, and when it reads one.
//
// The promise is about cost, so it is held as a **count of reads** rather than
// a sentence: with nobody looking, a hundred beats start none; with somebody
// looking, one beat starts one; and when they stop asking, it stops.

const tick = () => new Promise<void>((done) => setImmediate(done))

/** The deadline a test's reads are held to, so a late one is late in milliseconds. */
const SOON = 20

/** Past the deadline, by the thing being waited for and not by a guess at the machine. */
const pastDeadline = () => new Promise((done) => setTimeout(done, SOON * 3))

/** A driver that answers what it is told to, and counts every read. */
function driver(answer: (lane: string) => Promise<string> = () => Promise.resolve('$ ok')) {
  const asked: { lane: string; lines: number }[] = []
  let now = 1_000_000
  const lanes = new Lanes({
    capture: (lane, lines) => {
      asked.push({ lane, lines })
      return answer(lane)
    },
    now: () => now,
    deadline: SOON,
  })
  return {
    lanes,
    asked,
    at: () => now,
    pass: (ms: number) => {
      now += ms
    },
  }
}

describe('with nobody looking', () => {
  it('reads nothing over a hundred beats', () => {
    const one = driver()
    for (let n = 0; n < 100; n += 1) {
      one.lanes.beat(one.at())
      one.pass(2_000)
    }
    expect(one.asked).toEqual([])
    expect(one.lanes.started).toBe(0)
  })
})

describe('with somebody looking', () => {
  it('reads the agent’s own lane on the beat, and never on the ask', async () => {
    const one = driver()
    one.lanes.watch('dev', 'app/migration', one.at())
    // The ask itself starts nothing: a handler answers out of what is held.
    expect(one.asked).toEqual([])
    expect(one.lanes.heldFor('app/migration')).toBeNull()
    one.lanes.beat(one.at())
    await tick()
    expect(one.asked).toHaveLength(1)
    expect(one.asked[0]?.lane).toBe('app/migration/agent')
    // A screen's rows and one more — never the scrollback.
    expect(one.asked[0]?.lines).toBeLessThanOrEqual(41)
    expect(one.lanes.heldFor('app/migration')).toMatchObject({ kind: 'read', text: '$ ok' })
  })

  it('reads one lane once a beat, however many devices are looking at it', async () => {
    const one = driver()
    one.lanes.watch('a', 'app/migration', one.at())
    one.lanes.watch('b', 'app/migration', one.at())
    one.lanes.beat(one.at())
    await tick()
    expect(one.asked).toHaveLength(1)
  })

  it('stops reading a beat after the last ask runs out, and keeps nothing', async () => {
    const one = driver()
    one.lanes.watch('dev', 'app/migration', one.at())
    one.lanes.beat(one.at())
    await tick()
    one.pass(WATCH_MS)
    one.lanes.beat(one.at())
    await tick()
    expect(one.asked).toHaveLength(1)
    expect(one.lanes.watched).toBe(0)
    // What nobody is looking at is not kept, so a page that opens it again is
    // told `not read yet` — which is true — rather than shown an old screen.
    expect(one.lanes.heldFor('app/migration')).toBeNull()
  })

  it('goes on reading while the page goes on asking', async () => {
    const one = driver()
    for (let n = 0; n < 5; n += 1) {
      one.lanes.watch('dev', 'app/migration', one.at())
      one.lanes.beat(one.at())
      await tick()
      one.pass(2_000)
    }
    expect(one.asked).toHaveLength(5)
  })

  it('lets go of a device that is no longer one, at once', async () => {
    const one = driver()
    one.lanes.watch('dev', 'app/migration', one.at())
    one.lanes.forget('dev')
    one.lanes.beat(one.at())
    await tick()
    expect(one.asked).toEqual([])
  })

  it('reads at most a few agents for one device, the newest asks', async () => {
    const one = driver()
    for (let n = 0; n < MOST_PER_DEVICE + 3; n += 1) {
      one.lanes.watch('dev', `app/task-${n}`, one.at())
      one.pass(1)
    }
    expect(one.lanes.watched).toBe(MOST_PER_DEVICE)
    one.lanes.beat(one.at())
    await tick()
    expect(one.asked.map((read) => read.lane)).not.toContain('app/task-0/agent')
    expect(one.asked).toHaveLength(MOST_PER_DEVICE)
  })
})

describe('when the driver does not answer as asked', () => {
  it('says there is no agent where the driver says the lane is not there', async () => {
    for (const gone of [new LaneNotFoundError('app/migration/agent'), new LaneClosedError('x')]) {
      const one = driver(() => Promise.reject(gone))
      one.lanes.watch('dev', 'app/migration', one.at())
      one.lanes.beat(one.at())
      await tick()
      expect(one.lanes.heldFor('app/migration')).toEqual({ kind: 'none', why: 'no agent' })
    }
  })

  it('never says there is no agent because the reading failed', async () => {
    // **The other answer.** A driver that threw for any other reason has not
    // said the agent is gone, and a page that drew *no agent is running*
    // over one that is would be telling somebody their work stopped.
    let failing = false
    const one = driver(() =>
      failing ? Promise.reject(new Error('the emulator thread died')) : Promise.resolve('$ ok'),
    )
    one.lanes.watch('dev', 'app/migration', one.at())
    one.lanes.beat(one.at())
    await tick()
    failing = true
    one.lanes.beat(one.at())
    await tick()
    // The last screen stays, with the moment it was read.
    expect(one.lanes.heldFor('app/migration')).toMatchObject({ kind: 'read', text: '$ ok' })
    const fresh = driver(() => Promise.reject(new Error('the emulator thread died')))
    fresh.lanes.watch('dev', 'app/migration', fresh.at())
    fresh.lanes.beat(fresh.at())
    await tick()
    expect(fresh.lanes.heldFor('app/migration')).toEqual({ kind: 'none', why: 'could not read' })
  })

  it('keeps the last screen it had when a read is late, and starts no second one', async () => {
    let late = false
    const one = driver(() =>
      late ? new Promise<string>(() => {}) : Promise.resolve('the last good screen'),
    )
    one.lanes.watch('dev', 'app/migration', one.at())
    one.lanes.beat(one.at())
    await tick()
    late = true
    one.lanes.watch('dev', 'app/migration', one.at())
    one.lanes.beat(one.at())
    // A beat while that read is still out starts nothing more.
    one.lanes.beat(one.at())
    expect(one.asked).toHaveLength(2)
    await pastDeadline()
    expect(one.lanes.heldFor('app/migration')).toMatchObject({ text: 'the last good screen' })
  })

  it('says it could not read a lane nothing was ever read of', async () => {
    const one = driver(() => new Promise<string>(() => {}))
    one.lanes.watch('dev', 'app/migration', one.at())
    one.lanes.beat(one.at())
    await pastDeadline()
    expect(one.lanes.heldFor('app/migration')).toEqual({ kind: 'none', why: 'could not read' })
  })
})

describe('the keys a screen is scrubbed of', () => {
  it('knows every key the window holds, and every variable named like one', () => {
    const known = knownKeys(
      [{ value: 'written-in-the-config-1', variables: ['JEV_KEY'] }],
      { push_key: 'the-notification-signing-key' },
      {
        JEV_KEY: 'from-the-shell-variable-2',
        ANTHROPIC_API_KEY: 'sk-ant-the-agents-inherit-it',
        GITHUB_TOKEN: 'ghp_from_the_environment',
        HOME: '/Users/testperson',
        SHORT_TOKEN: 'abc',
      },
    )
    expect(known).toContain('written-in-the-config-1')
    expect(known).toContain('from-the-shell-variable-2')
    expect(known).toContain('the-notification-signing-key')
    expect(known).toContain('sk-ant-the-agents-inherit-it')
    expect(known).toContain('ghp_from_the_environment')
    // Not every variable: only the ones named like a credential.
    expect(known).not.toContain('/Users/testperson')
    // And nothing so short it would only be taking words off a screen.
    expect(known).not.toContain('abc')
  })
})

describe('its conversation', () => {
  /** A record that answers what it is told to, and counts every read. */
  function recorded(answer: () => Promise<{ turns: TurnIn[]; before: string | null }>) {
    let reads = 0
    let now = 1_000_000
    const troubles: string[] = []
    const lanes = new Lanes({
      capture: () => Promise.resolve('$ ok'),
      history: () => {
        reads += 1
        return answer()
      },
      trouble: (task, err) => troubles.push(`${task}: ${(err as Error).message}`),
      now: () => now,
      deadline: SOON,
    })
    return {
      lanes,
      troubles,
      reads: () => reads,
      at: () => now,
      pass: (ms: number) => {
        now += ms
      },
    }
  }
  const said = (text: string): TurnIn => ({ kind: 'reply', text, at: 1 })

  it('is read on the beat while somebody looks, and not at all while nobody does', async () => {
    const one = recorded(() => Promise.resolve({ turns: [said('hello')], before: null }))
    for (let n = 0; n < 10; n += 1) one.lanes.beat(one.at())
    expect(one.reads()).toBe(0)
    one.lanes.watch('dev', 'app/migration', one.at())
    expect(one.lanes.talkFor('app/migration')).toBeUndefined()
    one.lanes.beat(one.at())
    await tick()
    expect(one.reads()).toBe(1)
    expect(one.lanes.talkFor('app/migration')).toMatchObject({ kind: 'read', before: null })
  })

  it('moves its revision only when the turns moved', async () => {
    let turns = [said('hello')]
    const one = recorded(() => Promise.resolve({ turns, before: null }))
    one.lanes.watch('dev', 'app/migration', one.at())
    one.lanes.beat(one.at())
    await tick()
    const first = one.lanes.talkFor('app/migration')
    one.lanes.beat(one.at())
    await tick()
    expect(one.lanes.talkFor('app/migration')).toBe(first)
    turns = [said('hello'), said('again')]
    one.lanes.beat(one.at())
    await tick()
    const second = one.lanes.talkFor('app/migration')
    expect(second?.kind === 'read' && first?.kind === 'read' && second.rev !== first.rev).toBe(true)
  })

  it('says it could not be read, and keeps the last one known when a read fails after it', async () => {
    let fail = true
    const one = recorded(() =>
      fail
        ? Promise.reject(new Error('EACCES'))
        : Promise.resolve({ turns: [said('hi')], before: null }),
    )
    one.lanes.watch('dev', 'app/migration', one.at())
    one.lanes.beat(one.at())
    await tick()
    expect(one.lanes.talkFor('app/migration')).toEqual({ kind: 'none', why: 'could not read' })
    // Said once, not once a beat.
    one.lanes.beat(one.at())
    await tick()
    expect(one.troubles).toEqual(['app/migration: EACCES'])
    fail = false
    one.lanes.beat(one.at())
    await tick()
    const known = one.lanes.talkFor('app/migration')
    expect(known?.kind).toBe('read')
    fail = true
    one.lanes.beat(one.at())
    await tick()
    expect(one.lanes.talkFor('app/migration')).toBe(known)
    expect(one.troubles).toHaveLength(2)
  })

  it('keeps nothing once nobody is looking', async () => {
    const one = recorded(() => Promise.resolve({ turns: [said('hi')], before: null }))
    one.lanes.watch('dev', 'app/migration', one.at())
    one.lanes.beat(one.at())
    await tick()
    one.pass(WATCH_MS + 1)
    one.lanes.beat(one.at())
    expect(one.lanes.talkFor('app/migration')).toBeUndefined()
  })
})

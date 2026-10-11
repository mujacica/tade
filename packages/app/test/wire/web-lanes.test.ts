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
  it('says there is no agent where the lane is not there', async () => {
    const one = driver(() => Promise.reject(new Error('no such lane')))
    one.lanes.watch('dev', 'app/migration', one.at())
    one.lanes.beat(one.at())
    await tick()
    expect(one.lanes.heldFor('app/migration')).toEqual({ kind: 'none', why: 'no agent' })
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

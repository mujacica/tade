import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ECHO_OWED_MS, LOOK_FLOOR_MS, LOOK_SOON_MS, SLOW_LOOK_MS } from '../../src/pace.ts'
import { Looks } from '../../src/wire/looks.ts'

// When the window looks at the lanes, on a clock the test holds.
//
// The rules are a handful of waits, and each is the other's failure: a look
// asked for too early finds nothing and spends the floor the echo then waits
// behind; a look not held to the floor while a lane streams takes the machine.
// So every wait is asserted from both sides — the look that has not happened a
// millisecond before, and the one that has at the moment it is owed.

/** Looks over a clock this test moves, each look recorded as when it started, and held open on demand. */
function looking() {
  const started: number[] = []
  let owed = 0
  let slow: number[] = []
  let hold: Promise<void> | null = null
  const looks = new Looks({
    look: async () => {
      started.push(Date.now())
      if (hold) await hold
    },
    stopped: () => false,
    owe: () => {
      owed++
    },
    slow: (at) => {
      slow = [...slow, at]
    },
  })
  return {
    looks,
    started,
    owed: () => owed,
    slow: () => slow,
    /** Keep the next looks open until the returned function is called. */
    holdOpen: () => {
      let release = () => {}
      hold = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        hold = null
        release()
      }
    },
  }
}

/** Move the clock, and let whatever it set off run to its end. */
async function after(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('when the window looks at the lanes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('looks at a lane that printed at once, from quiet', async () => {
    const { looks, started } = looking()
    looks.printed()
    await after(0)
    expect(started).toEqual([1_000_000])
  })

  it('holds a lane streaming to the floor', async () => {
    const { looks, started } = looking()
    await looks.tick()
    await after(5)
    looks.printed()
    await after(LOOK_FLOOR_MS - 5 - 1)
    expect(started, 'looked before the floor allowed').toHaveLength(1)
    await after(1)
    expect(started).toHaveLength(2)
  })

  it('looks soon, not at once, when something was done rather than printed', async () => {
    const { looks, started } = looking()
    await after(LOOK_FLOOR_MS)
    looks.soonTick()
    await after(LOOK_SOON_MS - 1)
    expect(started).toHaveLength(0)
    await after(1)
    expect(started).toHaveLength(1)
  })

  it('looks at the sooner of two asks, once', async () => {
    const { looks, started } = looking()
    await after(LOOK_FLOOR_MS)
    looks.soonTick()
    looks.printed()
    await after(0)
    expect(started).toHaveLength(1)
    await after(LOOK_FLOOR_MS)
    expect(started, 'the later ask looked as well').toHaveLength(1)
  })

  it('never holds a key’s echo to the floor, and owes its frame', async () => {
    const { looks, started, owed } = looking()
    await looks.tick()
    await after(2)
    looks.typed()
    expect(owed(), 'the key’s own frame is owed').toBe(1)
    await after(1)
    looks.printed()
    await after(0)
    expect(started).toHaveLength(2)
    // And the look that reads it owes the frame again, however long the echo took.
    expect(owed()).toBe(2)
  })

  it('pays one look per key: what the lane prints after its echo is held to the floor', async () => {
    const { looks, started } = looking()
    looks.typed()
    looks.printed()
    await after(0)
    expect(started).toHaveLength(1)
    await after(3)
    looks.printed()
    await after(LOOK_FLOOR_MS - 3 - 1)
    expect(started, 'a second look for one key').toHaveLength(1)
    await after(1)
    expect(started).toHaveLength(2)
  })

  it('owes nothing to a print that came long after the key', async () => {
    const { looks, started } = looking()
    looks.typed()
    await after(ECHO_OWED_MS)
    // Just looked, so an ordinary print now waits out the floor.
    await looks.tick()
    looks.printed()
    await after(0)
    expect(started).toHaveLength(1)
    await after(LOOK_FLOOR_MS)
    expect(started).toHaveLength(2)
  })

  it('looks again straight after a look a key’s echo arrived during', async () => {
    const { looks, started, holdOpen } = looking()
    const release = holdOpen()
    void looks.tick()
    expect(started).toHaveLength(1)
    // The echo comes in while that look is reading: it may have read the
    // cursor before it and the text after it, so it is read again at once.
    looks.typed()
    looks.printed()
    await after(0)
    expect(started, 'two looks at once').toHaveLength(1)
    release()
    await after(0)
    expect(started).toHaveLength(2)
  })

  it('says a look slower than the time between two', async () => {
    const { looks, slow, holdOpen } = looking()
    const release = holdOpen()
    const look = looks.tick()
    await after(SLOW_LOOK_MS + 1)
    release()
    await look
    expect(slow()).toEqual([1_000_000])
  })

  it('looks at nothing once it is stopped', async () => {
    const { looks, started } = looking()
    looks.soonTick()
    looks.stop()
    await after(LOOK_FLOOR_MS)
    expect(started).toHaveLength(0)
  })
})

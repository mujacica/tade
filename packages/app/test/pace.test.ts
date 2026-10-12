import { describe, expect, it } from 'vitest'
import {
  EASY_FRAMES,
  ECHO_OWED_MS,
  FRAME_MS,
  intervalOf,
  LOOK_FLOOR_MS,
  LOOK_SOON_MS,
  lookWait,
  NEWS_MS,
  newsWait,
  type Pace,
  paced,
  printedWait,
  RENDER_CEILING_MS,
  RENDER_FLOOR_MS,
  renderWait,
  UNHURRIED,
  WRITE_SHARE,
} from '../src/pace.ts'

// How long the window waits before looking again. Two halves, and each is the
// other's failure: wait too long and a keystroke is not on screen when you
// look for it; wait no time at all and the loop takes the machine.

describe('waiting before the next look', () => {
  it('waits only the short wait when the last look was a while ago', () => {
    // What typing goes through: nothing has happened for a moment, so the
    // whole of the short wait is left to run and no more.
    expect(lookWait(LOOK_FLOOR_MS)).toBe(LOOK_SOON_MS)
    expect(lookWait(1_000)).toBe(LOOK_SOON_MS)
  })

  it('waits out the floor when a lane has just been looked at', () => {
    // What a printing agent goes through: asked again immediately, it waits
    // for the floor rather than going round again now.
    expect(lookWait(0)).toBe(LOOK_FLOOR_MS)
    expect(lookWait(10)).toBe(LOOK_FLOOR_MS - 10)
  })

  it('never waits longer than the floor, or less than the short wait', () => {
    for (let since = -50; since <= 500; since++) {
      const wait = lookWait(since)
      expect(wait).toBeGreaterThanOrEqual(LOOK_SOON_MS)
      expect(wait).toBeLessThanOrEqual(LOOK_FLOOR_MS)
    }
  })

  it('looks at a lane that printed at once from quiet, and no sooner than the floor while it streams', () => {
    // Reading waits for what it printed to be parsed, so the short wait buys
    // nothing here — and a look inside it is one the next print waits behind.
    expect(printedWait(LOOK_FLOOR_MS, false)).toBe(0)
    expect(printedWait(1_000, false)).toBe(0)
    expect(printedWait(0, false)).toBe(LOOK_FLOOR_MS)
    expect(printedWait(10, false)).toBe(LOOK_FLOOR_MS - 10)
    expect(printedWait(-5, false)).toBe(LOOK_FLOOR_MS)
  })

  it('never holds a key’s echo to the floor', () => {
    for (let since = -10; since <= 100; since++) expect(printedWait(since, true)).toBe(0)
    // Owed for longer than a program at a prompt takes, and for less than the
    // beat: past it, a print is the ordinary kind.
    expect(ECHO_OWED_MS).toBeLessThan(FRAME_MS)
    expect(ECHO_OWED_MS).toBeGreaterThan(LOOK_FLOOR_MS)
  })

  it('looks oftener than the beat, and not so often nobody could read it', () => {
    // The floor is a ceiling on the rate: both directions here, so a number
    // changed on its own has to be argued with in both.
    expect(LOOK_FLOOR_MS).toBeLessThan(FRAME_MS)
    expect(1_000 / LOOK_FLOOR_MS).toBeLessThan(35)
    expect(1_000 / LOOK_FLOOR_MS).toBeGreaterThan(1_000 / FRAME_MS)
  })
})

// How long the terminal is given between two frames. The same two halves as
// the look, from the other side: pace too fast and the window spends its
// thread waiting for a starved terminal to accept frames nobody can see yet;
// pace too slow, or never come back down, and a machine that was busy for a
// minute leaves the window sluggish for the rest of the day.

/** Where the ratchet stands after each of these writes, in turn. */
function after(writes: readonly number[], from: Pace = UNHURRIED): Pace {
  return writes.reduce(paced, from)
}

describe('pacing frames to the terminal', () => {
  it('adds nothing for a terminal that keeps up', () => {
    // The ordinary case, and the promise: the window it had before this.
    expect(after(Array(500).fill(0.3))).toEqual(UNHURRIED)
    expect(intervalOf(UNHURRIED)).toBe(RENDER_FLOOR_MS)
    for (let since = -10; since < 100; since++) expect(renderWait(UNHURRIED, since)).toBe(0)
  })

  it('steps up at once when a frame takes more than its share to be accepted', () => {
    const share = RENDER_FLOOR_MS * WRITE_SHARE
    expect(after([share])).toEqual(UNHURRIED)
    expect(intervalOf(after([share + 0.1]))).toBe(RENDER_FLOOR_MS * 2)
    // A terminal taking forty milliseconds a frame: up until forty is inside
    // half the interval, and no further.
    const slow = after(Array(20).fill(40))
    expect(intervalOf(slow) * WRITE_SHARE).toBeGreaterThanOrEqual(40)
    expect((intervalOf(slow) / 2) * WRITE_SHARE).toBeLessThan(40)
  })

  it('never goes past the beat, however slow the terminal is', () => {
    const stuck = after(Array(50).fill(5_000))
    expect(intervalOf(stuck)).toBe(RENDER_CEILING_MS)
    expect(RENDER_CEILING_MS).toBe(FRAME_MS)
    // And one more slow frame at the ceiling is still the ceiling.
    expect(intervalOf(paced(stuck, 5_000))).toBe(RENDER_CEILING_MS)
  })

  it('comes back down a step at a time, and only after a run of easy frames', () => {
    const slow = after(Array(20).fill(5_000))
    const top = intervalOf(slow)
    // One quick frame is not a recovered terminal.
    expect(intervalOf(after(Array(EASY_FRAMES - 1).fill(0.1), slow))).toBe(top)
    const stepped = after(Array(EASY_FRAMES).fill(0.1), slow)
    expect(intervalOf(stepped)).toBeLessThan(top)
    expect(intervalOf(stepped)).toBeGreaterThan(RENDER_FLOOR_MS)
    // All the way back, given enough of them.
    expect(after(Array(EASY_FRAMES * 10).fill(0.1), slow)).toEqual(UNHURRIED)
  })

  it('starts the count again on a frame that only just kept up', () => {
    const slow = after(Array(20).fill(5_000))
    const nearly = [...Array(EASY_FRAMES - 1).fill(0.1), intervalOf(slow) * WRITE_SHARE * 0.9]
    expect(intervalOf(after([...nearly, ...Array(EASY_FRAMES - 1).fill(0.1)], slow))).toBe(
      intervalOf(slow),
    )
  })

  it('does not hunt: a terminal that settles at a pace stays at it', () => {
    // Whatever a terminal takes, once the ratchet has moved for it, the same
    // write again moves it nowhere — a ratchet that stepped down on a write it
    // had just stepped up for would draw at two rates in turn for ever.
    for (const took of [3, 9, 17, 25, 40, 70, 100, 200]) {
      const settled = after(Array(30).fill(took))
      expect(after(Array(200).fill(took), settled), `${took}ms`).toEqual(settled)
    }
  })

  it('holds a frame only for what is left of the interval', () => {
    const slow = after(Array(20).fill(40))
    const interval = intervalOf(slow)
    expect(renderWait(slow, 0)).toBe(interval)
    expect(renderWait(slow, interval / 4)).toBe(interval * 0.75)
    expect(renderWait(slow, interval)).toBe(0)
    expect(renderWait(slow, interval * 9)).toBe(0)
    // A clock that went backwards is no reason to wait longer than the interval.
    expect(renderWait(slow, -500)).toBe(interval)
  })
})

// What an event is worth: news, drawn with the next frame anything asks for and
// on its own no oftener than the spinner turns.
describe('waiting before a frame for news', () => {
  it('draws news at once when the window has been still for longer than that', () => {
    expect(newsWait(NEWS_MS)).toBe(0)
    expect(newsWait(60_000)).toBe(0)
    expect(newsWait(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('waits out what is left of the interval just after a frame', () => {
    expect(newsWait(0)).toBe(NEWS_MS)
    expect(newsWait(NEWS_MS / 4)).toBe(NEWS_MS * 0.75)
  })

  it('reads a clock that went backwards as no time at all, never as longer', () => {
    expect(newsWait(-500)).toBe(NEWS_MS)
  })

  it('draws news no oftener than the spinner, and oftener than the beat', () => {
    expect(NEWS_MS).toBeGreaterThan(RENDER_FLOOR_MS)
    expect(NEWS_MS).toBeLessThan(FRAME_MS)
  })
})

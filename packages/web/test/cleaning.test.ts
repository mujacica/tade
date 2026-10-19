import { describe, expect, it } from 'vitest'
import { cleanAway, cleanDeadline, OFF_THREAD_FROM } from '../src/cleaning.ts'
import { cleanText } from '../src/screen.ts'
import { HELD_KEY } from './fixtures.ts'

// One call's whole answer, cleaned off the window's thread when it is long.

const BROKEN = new URL('./fixtures/broken-cleaner.ts', import.meta.url)

/** An answer of `size` characters, with a path, a held key and a shaped one on every line. */
function answerOf(size: number): string {
  const line = `ok /Users/someone/src/x.ts ${HELD_KEY} ANTHROPIC_API_KEY=abcdefgh12345678\n`
  return line.repeat(Math.ceil(size / line.length))
}

/** Whether the event loop got a turn between asking for `cleaning` and its answer. */
async function turned<T>(cleaning: () => Promise<T>): Promise<{ out: T; turned: boolean }> {
  let turn = false
  const out = cleaning()
  setImmediate(() => {
    turn = true
  })
  return { out: await out, turned: turn }
}

describe("cleaning one call's whole answer", () => {
  it('cleans a long one on a thread of its own, to exactly what cleaning it here makes', async () => {
    const text = answerOf(2_000_000)
    const got = await turned(() => cleanAway(text, [HELD_KEY]))
    // The thread that draws the window was free while it was cleaned.
    expect(got.turned).toBe(true)
    expect(got.out).toEqual(cleanText(text, [HELD_KEY]))
    expect(got.out.text).not.toContain(HELD_KEY)
    expect(got.out.text).not.toContain('/Users/someone')
    expect(got.out.text).not.toContain('abcdefgh12345678')
  })

  it('cleans a short one where it is asked, without starting anything', async () => {
    const text = answerOf(OFF_THREAD_FROM / 2)
    // Told to clean on a thread that only ever throws, and never reaching it.
    const got = await turned(() => cleanAway(text, [HELD_KEY], { entry: BROKEN }))
    expect(got.turned).toBe(false)
    expect(got.out).toEqual(cleanText(text, [HELD_KEY]))
  })

  it('throws where the thread died, ended without a word or stopped answering, and says which', async () => {
    const text = answerOf(OFF_THREAD_FROM)
    await expect(cleanAway(text, ['throw'], { entry: BROKEN })).rejects.toThrow(
      /cleaning a 0\.1 MB answer failed: the cleaner fell over/,
    )
    await expect(cleanAway(text, ['exit'], { entry: BROKEN })).rejects.toThrow(
      /ended with nothing said \(exit 0\)/,
    )
    await expect(cleanAway(text, ['quiet'], { entry: BROKEN, ms: 500 })).rejects.toThrow(
      /took longer than 0\.5s/,
    )
  })

  it('gives a thread ten seconds and a second a megabyte', () => {
    expect(cleanDeadline(0)).toBe(10_000)
    expect(cleanDeadline(5_000_000)).toBe(15_000)
  })
})

import { describe, expect, it } from 'vitest'
import { cleanAway, cleanDeadline, OFF_THREAD_FROM, turnsAway } from '../src/cleaning.ts'
import { NOWHERE, type TurnIn, turnsOf } from '../src/conversation.ts'
import { cleanText } from '../src/screen.ts'
import { HELD_KEY } from './fixtures.ts'

// One call's whole answer, cleaned off the window's thread when it is long.

const BROKEN = new URL('./fixtures/broken-cleaner.ts', import.meta.url)
const MARKING = new URL('./fixtures/marking-cleaner.ts', import.meta.url)

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

describe("an agent's long turns, cleaned before they are asked for", () => {
  /** A call handed a whole file, and a short reply beside it, as the window holds them. */
  function turnsOfSize(size: number): TurnIn[] {
    return [
      {
        kind: 'tool',
        id: 'toolu_1',
        tool: 'Write',
        input: { file_path: '/Users/someone/src/x.ts', content: answerOf(size) },
        ok: true,
        result: 'ok',
        at: 1,
      },
      { kind: 'reply', text: `written, ${HELD_KEY}`, at: 2 },
    ]
  }
  /** The same turns as other objects, which nothing was made for. */
  const copied = (turns: TurnIn[]): TurnIn[] => structuredClone(turns)

  it('cleans a long one on a thread of its own, to exactly what cleaning it here makes', async () => {
    const turns = turnsOfSize(2_000_000)
    const got = await turned(() => turnsAway(turns, [HELD_KEY], NOWHERE))
    expect(got.turned).toBe(true)
    const rows = turnsOf(turns, [HELD_KEY])
    expect(rows).toEqual(turnsOf(copied(turns), [HELD_KEY]))
    const input = rows.turns[0]?.call?.input?.words ?? ''
    expect(input.length).toBeGreaterThan(500_000)
    expect(input).not.toContain(HELD_KEY)
    expect(input).not.toContain('abcdefgh12345678')
    expect(rows.turns[1]?.text?.words).not.toContain(HELD_KEY)
  })

  it('is what the ask sends, with the keys and places it was made with, and is made again with others', async () => {
    const turns = turnsOfSize(OFF_THREAD_FROM)
    await turnsAway(turns, [HELD_KEY], NOWHERE, { entry: MARKING })
    const asked = turnsOf(turns, [HELD_KEY])
    // The long turn was not cleaned again here; the short one was, here.
    expect(asked.turns[0]?.text?.words).toBe('made on the thread')
    expect(asked.turns[0]?.id).toBe('c:toolu_1')
    expect(asked.turns[1]?.text?.words).not.toContain(HELD_KEY)
    expect(asked.taken).toBe(7 + 1)
    // A key added since is a turn cleaned again, here, of that key too.
    const later = turnsOf(turns, [HELD_KEY, 'another-key-0123456789'])
    expect(later).toEqual(turnsOf(copied(turns), [HELD_KEY, 'another-key-0123456789']))
    // And so is one whose task now works somewhere else.
    const elsewhere = turnsOf(turns, [HELD_KEY], { work: '/Users/someone', tade: null, home: null })
    expect(elsewhere.turns[0]?.kind).toBe('tool')
  })

  it('starts nothing for a conversation of short turns', async () => {
    const turns = turnsOfSize(OFF_THREAD_FROM / 2)
    // Told to clean on a thread that only ever throws, and never reaching it.
    await expect(turnsAway(turns, [HELD_KEY], NOWHERE, { entry: BROKEN })).resolves.toBeUndefined()
    expect(turnsOf(turns, [HELD_KEY])).toEqual(turnsOf(copied(turns), [HELD_KEY]))
  })

  it('throws where the thread could not, says which, and keeps nothing made', async () => {
    const turns = turnsOfSize(OFF_THREAD_FROM)
    await expect(turnsAway(turns, ['throw'], NOWHERE, { entry: BROKEN })).rejects.toThrow(
      /cleaning 0\.\d MB of a conversation failed: the cleaner fell over/,
    )
    expect(turnsOf(turns, ['throw'])).toEqual(turnsOf(copied(turns), ['throw']))
  })
})

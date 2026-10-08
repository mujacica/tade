import { describe, expect, it } from 'vitest'
// The browser's own copy of the rule. A `.js` asset with no DOM in it, so a
// test can import it: `boot.js` cannot be imported, because importing it runs
// the page.
import { BACKOFF_MS, backoffAt, connectionOf, STALE_AFTER_MS, saidOf } from '../src/assets/live.js'
import {
  BACKOFF_MS as BACKOFF,
  backoffAt as backoffHere,
  type Connection,
  connectionOf as connectionHere,
  STALE_AFTER_MS as STALE,
} from '../src/stream.ts'

// The one rule that is written twice, held to agreeing.
//
// A browser cannot import a `.ts` file and this repository has no build step,
// so "stale, unreachable or closed" exists in `src/stream.ts` for everything
// that reasons about it here and in `src/assets/live.js` for the page. The
// alternative is a bundler for one function. What makes two copies safe is
// this file: the same table through both, asserted equal — the pattern
// `reading.ts`'s `inScope` already uses against `appliesTo`.

const NOW = Date.parse('2026-10-08T14:30:00.000Z')

const seen = (over: Partial<Parameters<typeof connectionHere>[0]> = {}) => ({
  open: true,
  lastAt: NOW,
  ended: null,
  ...over,
})

describe('what the page concludes about the connection', () => {
  const table: { said: string; seen: ReturnType<typeof seen>; now: number; want: Connection }[] = [
    {
      said: 'open, and something arrived just now',
      seen: seen(),
      now: NOW,
      want: { kind: 'live', sinceAt: NOW },
    },
    {
      said: 'open, and a keep-alive is still inside its window',
      seen: seen(),
      now: NOW + STALE,
      want: { kind: 'live', sinceAt: NOW },
    },
    {
      said: 'open, and nothing has arrived for longer than that',
      seen: seen(),
      now: NOW + STALE + 1,
      want: { kind: 'stale', sinceAt: NOW },
    },
    {
      said: 'not open: unreachable, said with when anything was last known',
      seen: seen({ open: false }),
      now: NOW + 60_000,
      want: { kind: 'unreachable', sinceAt: NOW },
    },
    {
      said: 'told why, which no timeout can improve on',
      seen: seen({ open: false, ended: 'Tade is closing' }),
      now: NOW + 600_000,
      want: { kind: 'closed', why: 'Tade is closing' },
    },
    {
      said: 'told why while the stream still looked open',
      seen: seen({ ended: 'this device was signed out at the machine' }),
      now: NOW,
      want: { kind: 'closed', why: 'this device was signed out at the machine' },
    },
  ]

  for (const row of table) {
    it(`agrees in both copies: ${row.said}`, () => {
      expect(connectionHere(row.seen, row.now)).toEqual(row.want)
      expect(connectionOf(row.seen, row.now)).toEqual(row.want)
    })
  }

  it('holds the same slack in both copies', () => {
    expect(STALE_AFTER_MS).toBe(STALE)
  })
})

describe('how long it waits before trying again', () => {
  it('climbs and then stops climbing, in both copies', () => {
    for (const tries of [-1, 0, 1, 2, 3, 4, 5, 40]) {
      expect(backoffAt(tries), String(tries)).toBe(backoffHere(tries))
    }
    expect(backoffAt(0)).toBe(1_000)
    // A ceiling, not a curve: a phone in a pocket with a dead tunnel must not
    // ask every second for an hour.
    expect(backoffAt(40)).toBe(15_000)
    expect([...BACKOFF_MS]).toEqual([...BACKOFF])
  })
})

describe('what it says, and what it never says', () => {
  it('shows the server’s own time, and the age only in the parenthesis', () => {
    const at = '2026-10-08T14:29:40.000Z'
    expect(saidOf({ kind: 'live', sinceAt: NOW }, at, NOW)).toBe(`● live · as of ${at}`)
    expect(saidOf({ kind: 'stale', sinceAt: NOW }, at, NOW + 34_000)).toContain('(34s)')
  })

  it('never says nothing is running when it could not ask', () => {
    const said = saidOf({ kind: 'unreachable', sinceAt: NOW }, '11:07', NOW + 60_000)
    expect(said).toContain('unreachable since 11:07')
    expect(said).toContain('may be asleep')
    // The rule, as a string check over the one line the page draws: nothing
    // about this state is nought, empty, or stopped.
    for (const word of ['nothing is running', 'no agents', '0 working', 'stopped']) {
      expect(said.toLowerCase()).not.toContain(word)
    }
  })

  it('says Tade’s own sentence when it was told why', () => {
    expect(saidOf({ kind: 'closed', why: 'Tade is closing' }, '11:07', NOW)).toBe(
      '⏸ Tade is closing',
    )
  })
})

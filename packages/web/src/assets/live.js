// What the page concludes about the connection, and the words it says about it.
//
// **Nothing here touches the DOM**, so it is importable by a test as well as by
// the page. `src/stream.ts` has the same rule in TypeScript — a browser cannot
// import that file — and `test/client.test.ts` asserts the two agree over a
// table, so the copy cannot drift. Written out twice deliberately, because the
// alternative is a build step for one function.
//
// **The rule that keeps the page honest.** When the stream drops, every row
// keeps its last state and the page gains one line: no row changes, no count
// changes, nothing becomes nought. *Unreachable is never stopped* — a sleeping
// laptop runs nothing, and a page that drew `0 working` because it could not
// ask would be lying about somebody's morning.

/** How long after the last frame a stream stops counting as live. 15s + slack. */
export const STALE_AFTER_MS = 20_000

/** 1, 2, 4, 8, 15 and then every 15 seconds. */
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000]

export function backoffAt(tries) {
  const at = Math.min(Math.max(0, tries), BACKOFF_MS.length - 1)
  return BACKOFF_MS[at] ?? 15_000
}

/**
 * The four states, told apart by what happened rather than by how long ago.
 *
 * `closed` first and whatever else is true: a server that said why is the one
 * answer no timeout can improve on.
 */
export function connectionOf(seen, now) {
  if (seen.ended !== null && seen.ended !== undefined) {
    return { kind: 'closed', why: seen.ended }
  }
  if (!seen.open) return { kind: 'unreachable', sinceAt: seen.lastAt }
  if (now - seen.lastAt > STALE_AFTER_MS) return { kind: 'stale', sinceAt: seen.lastAt }
  return { kind: 'live', sinceAt: seen.lastAt }
}

/**
 * How many failed reopens are a tunnel that blinked, rather than a machine that
 * has gone.
 *
 * Derived from the backoff curve rather than chosen: once the wait has climbed
 * to its ceiling, the page has spent the whole of 1+2+4+8 seconds getting
 * nowhere, and calling that *reconnecting* for the next hour would be a page
 * that never admits it cannot reach anything.
 */
export const GIVEN_UP_AFTER = BACKOFF_MS.length

/**
 * What the page says it is, which is the connection plus how the retries are
 * going.
 *
 * `connectionOf` is deliberately not asked to know this: what it is for is what
 * the *stream* did, and a closed stream is one state however many times it has
 * been reopened. Whether that is worth a bar at the top of somebody's phone is
 * the page's question, and the answer is how many tries have failed.
 */
export function standingOf(connection, tries = 0) {
  if (connection.kind !== 'unreachable') return connection.kind
  return tries >= GIVEN_UP_AFTER ? 'unreachable' : 'reconnecting'
}

/**
 * The line the page says about it: the glyph apart from the words, so the glyph
 * can be coloured and the words cannot be.
 *
 * `at` is the **server's** own time, out of the snapshot, and the device's clock
 * is read only for the parenthesis — a phone with a wrong clock then shows an
 * odd age rather than a wrong time.
 *
 * Every sentence here is one somebody wrote, and two of them are load-bearing:
 * *unreachable* says **since when**, because that is the last moment anything
 * was known to be true, and it names the two ordinary reasons — a laptop
 * asleep, Tade closed — so that a page nobody can reach never reads as a
 * morning where nothing ran.
 */
export function partsOf(standing, connection, at, now, tight = false) {
  const age = Math.max(0, Math.round((now - (connection.sinceAt ?? now)) / 1000))
  // At 360px the end of this line is what gets cut off, and the clock is the
  // half that matters: `as of` is grammar, the time is the fact.
  const of = tight ? '' : 'as of '
  switch (standing) {
    case 'live':
      return { glyph: '●', words: `live · ${of}${at}` }
    case 'stale':
      return { glyph: '●', words: `live · ${of}${at} (${age}s)` }
    case 'reconnecting':
      return { glyph: '◴', words: `reconnecting · ${of}${at}` }
    case 'closed':
      return { glyph: '⏸', words: connection.why }
    default:
      return {
        glyph: '○',
        words: `unreachable since ${at} — the machine may be asleep, or Tade may be closed`,
      }
  }
}

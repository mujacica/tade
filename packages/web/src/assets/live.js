// What the page concludes about the connection, and the words it says about it.
//
// **Nothing here touches the DOM**, so it is importable by a test as well as by
// `boot.js`. `src/stream.ts` has the same rule in TypeScript — a browser cannot
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
 * The one line the page says about it.
 *
 * `at` is the **server's** own time, out of the snapshot, and the clock is
 * read only for the parenthesis — a phone with a wrong clock then shows an odd
 * age rather than a wrong time.
 */
export function saidOf(connection, at, now) {
  const age = Math.max(0, Math.round((now - connection.sinceAt) / 1000))
  switch (connection.kind) {
    case 'live':
      return `● live · as of ${at}`
    case 'stale':
      return `● live · as of ${at} (${age}s)`
    case 'unreachable':
      // Said with *since when*, because that is the last moment anything was
      // known to be true — and never as "nothing is running".
      return `○ unreachable since ${at} — the machine may be asleep, or Tade may be closed`
    default:
      return `⏸ ${connection.why}`
  }
}

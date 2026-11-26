import { plain } from './outcome.ts'

// How a run's output is kept: its end, because that is where a command says
// how it went — and the lines that named a failure, wherever they were.
//
// The end alone was not enough. A red suite prints one block per failure,
// code frame and all, and ten of them are more than the room there is: a run
// of ten failures in five files was recorded with the last four and three of
// the files, and the other six could not be named by anybody, nor run again
// on their own when a red batch was narrowed (`narrowingCommand` reads the
// files out of this). So the line that heads each failure — `FAIL`, as vitest
// and jest both print it — is kept when the output above the end is cut, at
// the front, under a line of Tade's own that says it was cut.

/**
 * A line that names a failure: the `FAIL` that heads one, as vitest and jest
 * print it, and vitest's listing as each file finishes — `❯ file (8 tests | 1
 * failed)` and the `× test` under it. A run stopped before its summary (timed
 * out, killed) only ever printed the listing, so without these the one name
 * there was is the first thing cut.
 */
const NAMES_FAILURE = /^\s*(?:FAIL\s+\S|[×✗]\s+\S|❯\s+\S.*\(\d+ tests?\b.*\b\d+ failed\))/

/** Of the room, how much the names may take when there are any. */
const NAMES_SHARE = 4

/** How long one kept name may be: its file and test, never a page of it. */
const NAME_CHARS = 200

export interface KeptTail {
  /** More of what the command printed. */
  add(chunk: string): void
  /** What is kept: at most the room it was made with. */
  text(): string
}

/**
 * Keep what a command prints within `room` characters: the end, and, once
 * anything above the end is cut, the failures it named. Holds a few times the
 * room while it runs rather than everything, because a suite prints megabytes.
 */
export function keepTail(room: number): KeptTail {
  // Only ever cut just after a newline, so it always starts at the start of a
  // line and a name is read whole.
  let held = ''
  const names: string[] = []
  return {
    add(chunk) {
      held += chunk
      if (held.length <= room * 4) return
      const at = lineAfter(held, held.length - room * 2)
      names.push(...namedIn(held.slice(0, at), names))
      held = held.slice(at)
    },
    text() {
      if (names.length === 0 && held.length <= room) return held
      // What is cut to make room for the names is read for them too, so
      // whether a failure is named does not depend on how the output arrived.
      const at = lineAfter(held, held.length - (room - Math.floor(room / NAMES_SHARE)))
      const all = [...names, ...namedIn(held.slice(0, at), names)]
      if (all.length === 0) return held.slice(-room)
      return `${said(all, Math.floor(room / NAMES_SHARE) - 1)}\n${held.slice(at)}`
    },
  }
}

/** Where a cut at `from` goes so no line is split: just after the next newline. */
function lineAfter(text: string, from: number): number {
  if (from <= 0) return 0
  const newline = text.indexOf('\n', from - 1)
  return newline === -1 ? from : newline + 1
}

/** The failures `text` names that `already` does not. */
function namedIn(text: string, already: readonly string[]): string[] {
  const out: string[] = []
  for (const line of plain(text).split('\n')) {
    if (!NAMES_FAILURE.test(line)) continue
    const name = line.trimEnd().slice(0, NAME_CHARS)
    if (!already.includes(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * The names, said as cut, within `room`; what does not fit is counted, never
 * dropped silently — and the last is always said, after the count: it is the
 * failure nearest the end, the one a stopped run was in when it stopped.
 */
function said(names: readonly string[], room: number): string {
  const head = '[cut from the front of this output, the failures it named:]'
  const final = names.at(-1)
  const kept: string[] = []
  let used = head.length + 1
  // Room for the count and the last name is set aside whatever they come to.
  const more = `[and ${names.length} more]`.length + 1
  const lastRoom = (final?.length ?? 0) + 1
  for (const [i, name] of names.entries()) {
    const last = i === names.length - 1
    if (used + name.length + 1 + (last ? 0 : more + lastRoom) > room) break
    kept.push(name)
    used += name.length + 1
  }
  if (kept.length === names.length) return [head, ...kept, ''].join('\n')
  // Said only where it fits, which is everywhere but a room smaller than one name.
  const ends = final !== undefined && used + more + lastRoom <= room ? [final] : []
  const left = names.length - kept.length - ends.length
  return [head, ...kept, `[and ${left} more]`, ...ends, ''].join('\n')
}

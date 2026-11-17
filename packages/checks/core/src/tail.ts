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

/** The line that heads a failure, as vitest and jest print it. */
const NAMES_FAILURE = /^\s*FAIL\s+\S/

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

/** The names, said as cut, within `room`; what does not fit is counted, never dropped silently. */
function said(names: readonly string[], room: number): string {
  const head = '[cut from the front of this output, the failures it named:]'
  const kept: string[] = []
  let used = head.length + 1
  // Room for the count is set aside whatever it comes to: it is never longer than this.
  const more = `[and ${names.length} more]`.length + 1
  for (const [i, name] of names.entries()) {
    const last = i === names.length - 1
    if (used + name.length + 1 + (last ? 0 : more) > room) break
    kept.push(name)
    used += name.length + 1
  }
  const left = names.length - kept.length
  return [head, ...kept, ...(left > 0 ? [`[and ${left} more]`] : []), ''].join('\n')
}

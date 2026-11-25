import type { TadeEvent } from './events.ts'

// Which of the journal's warnings still stand: what a machine says is wrong
// with it, here and to another machine of the person's (`web-machine.ts`).
//
// A warning is a moment, written once, and nothing writes that it was put
// right. Listing the newest twenty kept ipax saying "the orchestrator:
// claude-code cannot run "unknown/unknown"" for a day after opus was chosen,
// through three windows that each started the orchestrator again on opus.
// Two kinds of line stop being true without a word, and only those go:
//
// - **What a window said about its own orchestrator or away view**
//   (`WINDOW_SAID`): what starting the orchestrator found, a request the
//   listener could not answer. Both die with that window, and the next one
//   starts its orchestrator and its listener again and says again whatever
//   still holds — so a later `tade_opened` supersedes it.
// - **The same words said again**: the newest line says it, once.
//
// Everything else stands: a warning nothing here can tell has been put right
// is listed, and never dropped for being old. With no `tade_opened` read, every
// line is from the window that is open, and nothing is superseded.

/** How every warning about what the orchestrator's start or restart found begins. */
export const ORCHESTRATOR_SAID = 'the orchestrator: '

/** How every warning about one request the away view could not answer begins. */
export const AWAY_REQUEST_SAID = 'the away view could not answer a request: '

/** The warnings about a window's own run, which the next window says again where they still hold. */
const WINDOW_SAID = [ORCHESTRATOR_SAID, AWAY_REQUEST_SAID] as const

/** The journal's warnings that still stand, newest first: `events` holds them and the `tade_opened` lines. */
export function standingWarnings(events: readonly TadeEvent[]): TadeEvent[] {
  let opened = Number.NEGATIVE_INFINITY
  for (const event of events) {
    if (event.type === 'tade_opened' && event.seq > opened) opened = event.seq
  }
  const said = new Set<string>()
  const standing: TadeEvent[] = []
  for (const event of [...events].sort((a, b) => b.seq - a.seq)) {
    if (event.type !== 'warning') continue
    const message = event.detail.message
    if (typeof message !== 'string' || message === '') continue
    if (event.seq < opened && WINDOW_SAID.some((start) => message.startsWith(start))) continue
    if (said.has(message)) continue
    said.add(message)
    standing.push(event)
  }
  return standing
}

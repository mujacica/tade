import { type Closing, closeBy, type Unclosed } from '@tade/core'

// What happens between the window closing and the shell prompt coming back.
//
// Measured on a home like a real one (a Claude Code orchestrator, the away
// view on, a DSN that did not answer): the window was gone in 30 ms, Sentry's
// close took its whole two seconds, and then the process never ended at all —
// the orchestrator's model process was let go of rather than ended, its pipes
// held the event loop open, and its reaper ends it only once Tade has gone.
// Each waited on the other until a second ctrl+c. So:
//
// - every close has a deadline, side by side, and a late or failed one is named;
// - whatever still holds the process open after that is not waited for
//   (`endSoon`), because a handle somebody leaked is not a reason to keep a
//   terminal;
// - and a second ctrl+c always ends it at once (`onSignals`).
//
// Nothing here stops an agent: under a driver whose lanes outlive the window
// the workbench lets go of them, and that is still what `last` does.

/** The side-by-side closes: the orchestrator, MCP, the tool socket, the status child. */
const TOGETHER_MS = 500

/** The workbench, alone after them: lets go of the lanes, then the journal and the lock. */
const LAST_MS = 400

/**
 * The whole of it. What is queued to be sent goes meanwhile, and may have
 * whatever is left of this — and never more, because a network that is down
 * is not a reason to keep anybody's terminal.
 */
export const QUIT_MS = 1_000

/** How long a process with nothing left to do is given to end by itself, before it is ended. */
export const LINGER_MS = 100

export interface Quitting {
  /** Closed side by side, first. */
  together: readonly Closing[]
  /** Closed alone, after them: the workbench, which they may still be writing to. */
  last: Closing
  /** Closed in the background the whole time, by `QUIT_MS`: what is still to be sent. */
  meanwhile: readonly Closing[]
  /** Between `together` and `last`. */
  between?: () => void
}

/**
 * Close everything on the way out, by `QUIT_MS` at the most, and answer what
 * was still going when it was given up on, and what threw.
 */
export async function closeAll(
  quitting: Quitting,
  now: () => number = Date.now,
): Promise<Unclosed[]> {
  const began = now()
  const meanwhile = closeBy(quitting.meanwhile, began + QUIT_MS, now)
  const late = await closeBy(quitting.together, now() + TOGETHER_MS, now)
  quitting.between?.()
  late.push(...(await closeBy([quitting.last], now() + LAST_MS, now)))
  late.push(...(await meanwhile))
  return late
}

/**
 * What is said about what did not close: a line naming everything late, then
 * a line for each that threw, with what it threw. Empty when there is nothing.
 */
export function leftBehind(unclosed: readonly Unclosed[]): string[] {
  const late = unclosed.filter((one) => !('error' in one)).map((one) => one.name)
  const lines = late.length
    ? [`closed without waiting for ${listed(late)}, which did not finish closing in time`]
    : []
  for (const one of unclosed) {
    if (!('error' in one)) continue
    const why = one.error instanceof Error ? one.error.message : String(one.error)
    lines.push(`${one.name} could not be closed: ${why}`)
  }
  return lines
}

/** `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  return names.length === 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
}

/**
 * End the process if it has not ended by itself in `ms`. The timer holds
 * nothing open, so a process that ends sooner is not kept for it.
 */
export function endSoon(ms: number = LINGER_MS, exit: () => void = () => process.exit()): void {
  setTimeout(exit, ms).unref()
}

/** What a signal is listened for on: the process, or a stand-in in a test. */
export interface Signals {
  on(signal: NodeJS.Signals, listener: () => void): unknown
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown
}

const ASKED: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

/**
 * Close on the first signal and end at once on any after it.
 *
 * A listener on SIGINT is what turns Node's own answer off, so one that only
 * ever said "close" made every later ctrl+c a no-op for as long as closing
 * took. `already` says whether closing has begun some other way — a key in
 * the window — so the first signal after that is already the second ask.
 */
export function onSignals(
  target: Signals,
  close: () => void,
  now: () => void,
  already: () => boolean,
): () => void {
  let asked = false
  const listener = () => {
    if (asked || already()) return now()
    asked = true
    close()
  }
  for (const signal of ASKED) target.on(signal, listener)
  return () => {
    for (const signal of ASKED) target.removeListener(signal, listener)
  }
}

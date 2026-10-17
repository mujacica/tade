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
// - and a second ctrl+c always ends it at once (`onSignals`);
// - while closing the terminal closes it as quitting does, writing nothing to
//   a terminal that has gone (`hangingUp`).
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
 * Close on the first signal and end at once on any after it — but a hang-up
 * is never the second ask.
 *
 * A listener on SIGINT is what turns Node's own answer off, so one that only
 * ever said "close" made every later ctrl+c a no-op for as long as closing
 * took. `already` says whether closing has begun some other way — a key in
 * the window — so the first signal after that is already the second ask.
 *
 * SIGHUP is the terminal going (`hangingUp`), and Node's own answer to it was
 * to end there and then: the driver never let go, the journal never heard,
 * and the home stayed locked by a process that was not there. Nobody is left
 * to have asked twice, and one window closing is two of them — the kernel's,
 * then the shell passing it on to its jobs — so every one is `hungUp`, which
 * is safe to be told twice and never cuts a close short.
 */
export function onSignals(
  target: Signals,
  close: () => void,
  now: () => void,
  already: () => boolean,
  hungUp: () => void,
): () => void {
  let asked = false
  const listener = () => {
    if (asked || already()) return now()
    asked = true
    close()
  }
  for (const signal of ASKED) target.on(signal, listener)
  target.on('SIGHUP', hungUp)
  return () => {
    for (const signal of ASKED) target.removeListener(signal, listener)
    target.removeListener('SIGHUP', hungUp)
  }
}

/** What the window is drawn in: the stream it reads keys from and the two it writes. */
export interface TerminalStreams {
  stdin: Pick<NodeJS.ReadStream, 'on'>
  stdout: Pick<NodeJS.WriteStream, 'on' | 'write'>
  stderr: Pick<NodeJS.WriteStream, 'on' | 'write'>
}

/**
 * The terminal hanging up — its window closed, the ssh connection under it
 * gone: from then on nothing is written to it, and `close` is told, once, to
 * close the window as quitting does. Answers the hang-up, for SIGHUP, and is
 * told it by an error on any of the terminal's streams too, since a frame
 * drawn between the hang-up and its signal is the first to hear of it — and
 * on the window's own terminal no other error means anything else.
 *
 * Nothing at all is written, because a write to a terminal that has gone does
 * not simply go nowhere. It is an `EIO` thrown a moment later out of nowhere,
 * which `watchProcess` takes for a crash and ends Tade on, half way through
 * closing — and on macOS the first write to a stream Node has not made yet
 * never returns: Node makes `process.stderr` when it is first asked for, by
 * opening the terminal again, and an open of one that has hung up waits for
 * it to come back. So the streams are taken here, while there is a terminal,
 * and on the hang-up every write to them — the window's last frame, the
 * restore that would have given the screen back, a line about what did not
 * close, a warning of Node's own — is dropped where it is made.
 */
export function hangingUp(terminal: TerminalStreams, close: () => void): () => void {
  // Read now, so neither is made after the hang-up (see above).
  const { stdin, stdout, stderr } = terminal
  let gone = false
  const hangUp = () => {
    if (gone) return
    gone = true
    stdout.write = dropped
    stderr.write = dropped
    close()
  }
  stdin.on('error', hangUp)
  stdout.on('error', hangUp)
  stderr.on('error', hangUp)
  return hangUp
}

/** A write to a terminal that has gone: taken, sent nowhere, and its callback answered. */
const dropped = ((...args: unknown[]) => {
  const done = args.findLast((arg) => typeof arg === 'function')
  if (typeof done === 'function') process.nextTick(done as () => void)
  return true
}) as NodeJS.WriteStream['write']

import { constants } from 'node:os'

// How a pane ended, as tmux says it: what its command exited with or was
// killed by, and telling the server to look when it has not said. Read by
// `reap` in `index.ts`, which is where the argument for each of them is.

/** Which process the tmux server is, as every row of a format says it. */
export function serverPid(pid: string): number | null {
  const n = Number(pid)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Tell a tmux server there is a child to wait on.
 *
 * Not a kill, and not a way of ending anything: SIGCHLD is the signal the
 * kernel sends when a child has changed state, and what tmux does with one
 * is wait on whatever is waitable and write down how each of them ended. So
 * this can only ever make tmux *look*; what it finds, and what it then says
 * about it, stays tmux's own answer, which is the whole point of sending it
 * rather than assuming what it would have said.
 *
 * One syscall, and ours to make: the server is the one Tade started, or the
 * one it adopted, and either is this user's. Gone or not ours to signal is
 * no answer either way, and the grace is what answers then.
 */
export function lookAgain(server: number): void {
  try {
    process.kill(server, 'SIGCHLD')
  } catch {
    // Nothing to tell, or nobody we may tell. Either way, not an error here.
  }
}

/** What a command exited with. Nothing at all is not a zero. */
export function exitStatus(status: string): number | null {
  if (status === '') return null
  const code = Number(status)
  return Number.isInteger(code) ? code : null
}

/**
 * What a command was killed by, as a number.
 *
 * tmux names a signal the way the platform it was built on does — `HUP`
 * where that has a name for it, `1` where it does not — and a lane's exit is
 * reported as the number, whichever of the two we were handed.
 */
export function signalNumber(signal: string): number | null {
  if (signal === '') return null
  const n = Number(signal)
  if (Number.isInteger(n)) return n > 0 ? n : null
  const known: Record<string, number | undefined> = constants.signals
  return known[signal.startsWith('SIG') ? signal : `SIG${signal}`] ?? null
}

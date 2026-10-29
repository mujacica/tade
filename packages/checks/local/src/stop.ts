// Ending what a check started. Its own file so that a group already gone can
// be held to a test: through a run it is a race, since whether the shell's
// last child has been reaped by the SIGKILL that follows a SIGTERM is the
// machine's to say, and on a loaded ubuntu runner it never had been — so the
// lines for it went unrun there and nowhere else.

/** Signal the whole group: a command is a shell, and the work is its children. */
export function stop(pid: number | null, signal: NodeJS.Signals): void {
  if (pid === null) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone, which is the outcome we wanted.
    }
  }
}

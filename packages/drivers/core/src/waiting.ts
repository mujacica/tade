// Waiting on processes the way the suite does, without a fixed sleep: until
// something is true, and whether a process is still there. Apart from the
// suite so it has room, and re-exported from it for everybody who waits.

/** Is this process still there? EPERM means yes, and not ours to signal. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone, which is the outcome we wanted.
  }
}

/** Wait until `check` passes, polling. Beats fixed sleeps in PTY tests. */
export async function until<T>(
  check: () => T | Promise<T>,
  { timeout = 5_000, interval = 20 } = {},
): Promise<T> {
  const deadline = Date.now() + timeout
  let last: unknown
  for (;;) {
    try {
      const v = await check()
      if (v) return v
    } catch (err) {
      last = err
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting${last ? `: ${String(last)}` : ''}`)
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

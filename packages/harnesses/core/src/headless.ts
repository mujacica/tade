import type { ChildProcess } from 'node:child_process'

/**
 * End a headless run, and let go of it at once.
 *
 * Its group is told to stop, since it runs in its own. Its pipes and its handle
 * are let go of here rather than when it has gone: a pipe still open is the
 * event loop kept alive, so a model process slow to stop was Tade's window
 * closed and its process still there. One that never stops is the reaper's —
 * it forces what it started a few seconds after being asked.
 */
export function endHeadless(child: ChildProcess): void {
  const pid = child.pid
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy()
  child.unref()
}

import { closeSync } from 'node:fs'
import { codeOf, mastersOpen } from './held.ts'

// Why a window that has been open a week leaves the machine with no
// pseudo-terminals, and every lane after that fails with `posix_spawnp failed.`
//
// On macOS node-pty 1.1.0 opens one pseudo-terminal more than it uses for each
// spawn: before the real one it opens a spare, so that a process with nothing on
// descriptors 0–2 cannot be handed its own pty there, and the loop that closes
// spares again never closes the first, which is normally the only one
// (`pty_posix_spawn` in `src/unix/pty.cc`). So it stays open in this process
// for as long as the process lives, whether the lane ended, was closed or was
// opened again. macOS has 511 (`kern.tty.ptmx_max`) for every terminal on the
// machine. A window open since 19 October held 334 of them with about a dozen
// lanes still running, and agents' test runs went red on whatever was left. The
// 1.2.0 betas close it; no release does yet.
//
// So the masters open in this process are listed before the spawn and after
// it, and one that is new and is not the lane's own is the spare, and closed.
// Nothing but node-pty opens a master, and it does so on this thread, inside
// the spawn: the emulators' thread, which opens files while it starts, never
// opens one. Where the spawn threw, no new one is anybody's. A node-pty that
// closes its spare leaves nothing new, so this then closes nothing.

/**
 * Spawn through node-pty and close the pseudo-terminal it leaves behind,
 * whether the spawn worked or threw.
 *
 * `master` is the descriptor of the lane's own pty, read from what `spawn`
 * returned, or undefined where it does not say: then nothing is closed, since
 * nothing tells the spare from the lane's. Only on macOS, where the spare is
 * opened at all.
 *
 * Looking for the spare never stands in the way of the lane: where a look
 * fails, `trouble` is told that the spare may still be open, and the lane is
 * opened all the same.
 */
export function spawnClosingSpare<T>(
  spawn: () => T,
  master: (made: T) => number | undefined,
  trouble: (problem: Error) => void,
  platform: string = process.platform,
): T {
  if (platform !== 'darwin') return spawn()
  const before = looked(() => mastersOpen(platform), trouble)
  let made: T
  try {
    made = spawn()
  } catch (error) {
    looked(() => closeNew(before, null, platform), trouble)
    throw error
  }
  const own = master(made)
  if (own !== undefined) looked(() => closeNew(before, own, platform), trouble)
  return made
}

/** Close every master open now that was not before and is not `own`. */
function closeNew(before: Set<number> | null, own: number | null, platform: string): void {
  if (before === null) return
  for (const fd of mastersOpen(platform) ?? []) {
    if (before.has(fd) || fd === own) continue
    try {
      closeSync(fd)
    } catch (error) {
      // Closed already, between the look and now: nothing left to give back.
      if (codeOf(error) !== 'EBADF') throw error
    }
  }
}

/** What `look` answers, or null once `trouble` has been told why it could not. */
function looked<T>(look: () => T, trouble: (problem: Error) => void): T | null {
  try {
    return look()
  } catch (error) {
    trouble(
      new Error(
        `The pseudo-terminal node-pty leaves open beside a lane could not be looked for, so it may still be open: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      ),
    )
    return null
  }
}

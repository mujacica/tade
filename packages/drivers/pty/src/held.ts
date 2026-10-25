import { fstatSync, readdirSync, statSync } from 'node:fs'

// How many pseudo-terminals this process holds, and whether that is more than
// the lanes it is running account for.
//
// Every lane holds one master from the moment it is spawned until its end has
// been read or it was closed, and nothing else in the window opens one. So a
// count above the lanes is a leak, and a leak only grows when a lane is
// spawned: that is when it is looked for, and nothing runs on a timer for it.
// The machine's are shared by everything on it (511 on macOS,
// `kern.tty.ptmx_max`), and once they are gone every new lane, every test run
// and every terminal window on the machine fails with `posix_spawnp failed.`

/** The code a failed system call threw with, where it was one. */
export const codeOf = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null)?.code

/**
 * The descriptors of the pseudo-terminal masters this process holds now, or
 * null on a machine with no `/dev/ptmx` or `/dev/fd` to ask. Any other failure
 * to look is thrown: a look that failed is not a count of none.
 *
 * A master is a character device opened through `/dev/ptmx` (`isMaster`).
 * Linux numbers every one as `/dev/ptmx` itself, whose major it shares with
 * `/dev/tty` and the console, so the whole number is compared there.
 */
export function mastersOpen(platform: string = process.platform): Set<number> | null {
  let ptmx: number
  let fds: string[]
  try {
    ptmx = statSync('/dev/ptmx').rdev
    fds = readdirSync('/dev/fd')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null
    throw error
  }
  const open = new Set<number>()
  for (const name of fds) {
    const fd = Number(name)
    try {
      const it = fstatSync(fd)
      if (it.isCharacterDevice() && isMaster(platform, ptmx, it.rdev)) open.add(fd)
    } catch (error) {
      // The descriptor the listing itself had open, closed by the time it is
      // looked at, is not one of anybody's.
      if (codeOf(error) !== 'EBADF') throw error
    }
  }
  return open
}

/**
 * Whether a character device numbered `rdev` is a pseudo-terminal master, on
 * a machine whose `/dev/ptmx` is numbered `ptmx`: a clone with `/dev/ptmx`'s
 * major (the top byte) on macOS, and `/dev/ptmx` itself elsewhere.
 */
export function isMaster(platform: string, ptmx: number, rdev: number): boolean {
  return platform === 'darwin' ? rdev >>> 24 === ptmx >>> 24 : rdev === ptmx
}

/** How many pseudo-terminal masters this process holds now: `mastersOpen`, counted. */
export function mastersHeld(platform: string = process.platform): number | null {
  return mastersOpen(platform)?.size ?? null
}

/**
 * How many masters held past the lanes must go unaccounted for before it is
 * said. A leak of one a lane says so by the third lane; a master caught in the
 * moment between a lane ending and its end being read never gets there.
 */
export const LEAK_SAID_AT = 3

/** What to say about a count, or null when there is nothing to say. */
export function leakIn(held: number | null, lanes: number): string | null {
  if (held === null || held - lanes < LEAK_SAID_AT) return null
  return (
    `This window holds ${held} pseudo-terminals and is running ${lanes} lanes, so ` +
    `${held - lanes} are held by nothing it runs. They are the machine's, shared ` +
    'with every terminal on it, and once they run out every new lane fails with ' +
    '"posix_spawnp failed." Closing Tade and opening it again gives them back.'
  )
}

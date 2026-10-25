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

/**
 * The descriptors of the pseudo-terminal masters this process holds now, or
 * null where it cannot tell.
 *
 * A master is a character device opened through `/dev/ptmx`. On macOS each one
 * is a clone with a minor of its own and `/dev/ptmx`'s major; elsewhere it is
 * `/dev/ptmx` itself, whose major Linux shares with `/dev/tty` and the console.
 */
export function mastersOpen(platform: string = process.platform): Set<number> | null {
  let ptmx: number
  let fds: string[]
  try {
    ptmx = statSync('/dev/ptmx').rdev
    fds = readdirSync('/dev/fd')
  } catch {
    return null
  }
  const isMaster =
    platform === 'darwin'
      ? (rdev: number) => rdev >>> 24 === ptmx >>> 24
      : (rdev: number) => rdev === ptmx
  const open = new Set<number>()
  for (const name of fds) {
    const fd = Number(name)
    try {
      const it = fstatSync(fd)
      if (it.isCharacterDevice() && isMaster(it.rdev)) open.add(fd)
    } catch {
      // The descriptor the listing itself had open, gone by now.
    }
  }
  return open
}

/** How many pseudo-terminal masters this process holds now, or null where it cannot tell. */
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

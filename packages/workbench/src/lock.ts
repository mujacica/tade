import { open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

// One control room per home directory.
//
// Tade keeps no server, so two windows opened on the same home would both be
// appending to the same journal and both numbering events from their own
// count. The lock makes that a clear refusal instead of a corrupt log. It
// guards writing only: reading the journal, the notes and the git state needs
// no permission from anybody.

export class HomeBusyError extends Error {
  readonly code = 'HOME_BUSY'
  readonly pid: number
  constructor(pid: number, home: string) {
    super(`Tade is already open on ${home} (pid ${pid})`)
    this.name = 'HomeBusyError'
    this.pid = pid
  }
}

export interface HomeLock {
  release(): Promise<void>
}

/**
 * Claim a home directory for writing.
 *
 * A lock file whose process is gone is not a lock: Tade being killed must not
 * leave you locked out of your own workbench, so a stale one is taken over
 * rather than reported.
 */
export async function lockHome(home: string): Promise<HomeLock> {
  const path = join(home, 'tade.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, 'wx')
      await fh.write(`${process.pid}\n`)
      await fh.close()
      return { release: () => rm(path, { force: true }) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Our own pid counts: two windows in one process are still two windows,
      // and letting the second take the lock from the first would be the exact
      // interleaving this exists to prevent.
      const holder = await holderOf(path)
      if (holder !== null) throw new HomeBusyError(holder, home)
      // Nobody's: whoever wrote it is gone. Take it over and try again.
      await rm(path, { force: true })
    }
  }
  throw new Error(`could not lock ${path}`)
}

/**
 * Who has this home open, or null if nobody. A lock file naming a process
 * that is gone counts as nobody: that is a crash, not an owner.
 */
export function heldBy(home: string): Promise<number | null> {
  return holderOf(join(home, 'tade.lock'))
}

/** The pid holding the lock, or null if it names nothing that is running. */
async function holderOf(path: string): Promise<number | null> {
  const pid = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10)
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch (err) {
    // EPERM means someone else's process is there, which still counts.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? pid : null
  }
}

import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { holdUntilExit, letGoOf } from './held.ts'
import { holderAt, type LockHolder } from './lock.ts'

// Whoever waits longest goes first, for anything waited for by polling: a
// machine's slot (`machine.ts`) and a checkout's run lock (`lock.ts`) alike.
//
// Polling alone hands what came free to whoever looks next — a run that had
// only just asked, as often as one that had waited ten minutes — and a
// `checks_run` with `wait 600` lost it time after time to runs that started
// after it did. So a wait takes a ticket: a file named for when it started,
// held by its pid the way a lock is, and a lock is only taken by somebody with
// no live ticket older than theirs (fewer than there are slots free). A taker
// that is not waiting counts every ticket as ahead of it.

const TICKET = /^\d{16}-\d+-\d{6}\.wait$/
let tickets = 0

/** A place held in one queue, and how to give it up. */
export interface Place {
  name: string
  leave: () => Promise<void>
}

/**
 * Take a place at the back of the queue in `dir`. The name is the order —
 * when it was taken, then whose, then which of this process's — so the oldest
 * sorts first; one process holds several, because every `checks_run` an agent
 * makes waits inside the window. It is written aside and renamed into place,
 * so nobody reading the queue finds it half-written and takes it for a dead
 * one.
 */
export async function joinQueue(
  dir: string,
  holder: { what: string; where?: string },
  now: () => number,
): Promise<Place> {
  await mkdir(dir, { recursive: true })
  const at = now()
  const name = `${String(at).padStart(16, '0')}-${process.pid}-${String(tickets++ % 1_000_000).padStart(6, '0')}.wait`
  const path = join(dir, name)
  const aside = `${path}.writing`
  await writeFile(
    aside,
    `${JSON.stringify({ pid: process.pid, ...holder, at: new Date(at).toISOString() })}\n`,
    { mode: 0o600 },
  )
  await rename(aside, path)
  // Given back however this process ends, as a lock is (`held.ts`).
  holdUntilExit(path)
  return {
    name,
    leave: () => {
      letGoOf(path)
      return rm(path, { force: true })
    },
  }
}

/**
 * Who holds a live ticket older than `ticket`, oldest first — everybody, for
 * a taker with none. A ticket whose process is gone is nobody, and is cleared
 * away.
 */
export async function waitingAhead(dir: string, ticket: string | null): Promise<LockHolder[]> {
  // No queue yet is nobody waiting; a queue that cannot be read is not, and is thrown.
  const names = await readdir(dir).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
    throw err
  })
  const ahead = names
    .filter((name) => TICKET.test(name) && (ticket === null || name < ticket))
    .sort()
  const live = await Promise.all(
    ahead.map(async (name) => {
      const holder = await holderAt(join(dir, name))
      if (!holder) await rm(join(dir, name), { force: true })
      return holder
    }),
  )
  return live.filter((one): one is LockHolder => one !== null)
}

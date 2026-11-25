import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
//
// A wait has a deadline, though, and asking again was a new ticket at the
// back: with eight related runs of twenty minutes each queued for one slot, a
// `checks_run` that may wait ten minutes never got there in seven tries, and
// every retry made its own place worse. So a wait that gives up at its deadline
// on behalf of somebody named (`as` — the task asking) keeps its ticket aside
// for `KEPT_MS`, and their next wait takes it back with the place it had. Kept
// aside it holds nobody up: a slot that comes free while nobody is waiting on
// that ticket goes to whoever is.

const TICKET = /^\d{16}-\d+-\d{6}\.wait$/
const KEPT = /^(\d{16}-\d+-\d{6})\.kept$/
/** How long a place given up at a deadline is kept for whoever gave it up to ask again. */
export const KEPT_MS = 15 * 60_000
let tickets = 0

/** A place held in one queue, and how to give it up. */
export interface Place {
  name: string
  /** Gone from the queue: what was waited for was had, or whoever asked has gone. */
  leave: () => Promise<void>
  /**
   * Given up at a deadline: set aside for `as` to take back (`takeBack`) for
   * `KEPT_MS`, or left, for a place nobody named.
   */
  keep: () => Promise<void>
}

/** Who is waiting, as a ticket says it, and — for a place that can be kept — on whose behalf. */
interface Holder {
  what: string
  where?: string
  as?: string
}

/**
 * Take a place at the back of the queue in `dir`. The name is the order —
 * when it was taken, then whose, then which of this process's — so the oldest
 * sorts first; one process holds several, because every `checks_run` an agent
 * makes waits inside the window. It is written aside and renamed into place,
 * so nobody reading the queue finds it half-written and takes it for a dead
 * one.
 */
export async function joinQueue(dir: string, holder: Holder, now: () => number): Promise<Place> {
  await mkdir(dir, { recursive: true })
  const at = now()
  const name = `${String(at).padStart(16, '0')}-${process.pid}-${String(tickets++ % 1_000_000).padStart(6, '0')}.wait`
  return placeAt(dir, name, holder, at, now)
}

/**
 * The place `as` gave up at a deadline in `dir`, taken back where it was —
 * or null, when they kept none or it has lapsed. Lapsed ones, and ones whose
 * process is gone, are cleared away on the way.
 */
export async function takeBack(
  dir: string,
  holder: Holder & { as: string },
  now: () => number,
): Promise<Place | null> {
  const names = await readdir(dir).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
    throw err
  })
  let mine: string | null = null
  for (const name of names.sort()) {
    const ticket = KEPT.exec(name)?.[1]
    if (!ticket) continue
    const path = join(dir, name)
    const kept = await keptAt(path)
    if (!kept || kept.until <= now() || !(await holderAt(path))) {
      await rm(path, { force: true })
    } else if (kept.as === holder.as && mine === null) {
      // Moved out of the way before it is put back, so two waits by the same
      // asker cannot both take it: the second finds nothing to move.
      const taking = `${path}.${process.pid}-${tickets++}.taking`
      const moved = await rename(path, taking).then(
        () => true,
        (err: unknown) => {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw err
        },
      )
      if (!moved) continue
      letGoOf(path)
      mine = `${ticket}.wait`
      // Held under its own name while the ticket goes back, so a process that
      // ends between the two leaves nothing behind.
      holdUntilExit(taking)
      try {
        const place = await placeAt(dir, mine, holder, kept.at, now)
        return place
      } finally {
        letGoOf(taking)
        await rm(taking, { force: true })
      }
    }
  }
  return null
}

/** Write a ticket called `name` into place in `dir`, and say how to give it up. */
async function placeAt(
  dir: string,
  name: string,
  holder: Holder,
  at: number,
  now: () => number,
): Promise<Place> {
  const path = join(dir, name)
  await writeAside(path, { pid: process.pid, ...holder, at: new Date(at).toISOString() })
  // Given back however this process ends, as a lock is (`held.ts`).
  holdUntilExit(path)
  const leave = () => {
    letGoOf(path)
    return rm(path, { force: true })
  }
  return {
    name,
    leave,
    keep: async () => {
      if (!holder.as) return leave()
      const kept = path.replace(/\.wait$/, '.kept')
      await writeAside(kept, {
        pid: process.pid,
        ...holder,
        at: new Date(at).toISOString(),
        until: now() + KEPT_MS,
      })
      holdUntilExit(kept)
      await leave()
    },
  }
}

async function writeAside(path: string, body: Record<string, unknown>): Promise<void> {
  const aside = `${path}.writing`
  await writeFile(aside, `${JSON.stringify(body)}\n`, { mode: 0o600 })
  await rename(aside, path)
}

/** What a kept place says: whose, since when it was waited for, and until when it is kept. */
async function keptAt(path: string): Promise<{ as: string; at: number; until: number } | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const at = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN
    if (typeof raw.as !== 'string' || typeof raw.until !== 'number' || Number.isNaN(at)) return null
    return { as: raw.as, at, until: raw.until }
  } catch (err) {
    // Gone since the listing, or not a kept place at all: nobody's to take
    // back, and cleared by the caller. A queue that cannot be read is thrown,
    // as `waitingAhead` throws it.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) return null
    throw err
  }
}

/**
 * Who holds a live ticket older than `ticket`, oldest first — everybody, for
 * a taker with none. A ticket whose process is gone is nobody, and is cleared
 * away. A place kept aside is not a ticket: nobody is waiting on it.
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

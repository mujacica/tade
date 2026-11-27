import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
// for `KEPT_MS`, and their next wait takes it back with the place it had.
//
// Kept aside it still holds its turn for `HELD_MS`, the time an agent takes to
// ask again, and after that holds nobody up: a slot that comes free while
// nobody is waiting on that ticket goes to whoever is. Holding nobody up from
// the first moment, it saved nothing: a checks_run gave up at 16:50:59 and the
// run behind it had the checkout 0.8 s later, 14 s before it asked again; it
// waited eight times in 85 minutes and never ran.

const TICKET = /^(\d{16}-\d+-\d{6})\.wait$/
const KEPT = /^(\d{16}-\d+-\d{6})\.kept$/
/** A kept place in the moment between being moved aside and put back as a ticket (`takeBack`). */
const TAKING = /^(\d{16}-\d+-\d{6})\.kept\.\d+-\d+\.taking$/
/** How long a place given up at a deadline is kept for whoever gave it up to ask again. */
export const KEPT_MS = 15 * 60_000
/** How long a place given up at a deadline still holds its turn — and holds those behind it up. */
export const HELD_MS = 2 * 60_000
let tickets = 0

/** A place held in one queue, and how to give it up. */
export interface Place {
  name: string
  /** When this place was first waited for, which is what orders it. */
  at: number
  /** Gone from the queue: what was waited for was had, or whoever asked has gone. */
  leave: () => Promise<void>
  /**
   * Given up at a deadline: set aside for `as` to take back (`takeBack`) for
   * `KEPT_MS`, or left, for a place nobody named. It holds its turn for
   * `heldMs` (`HELD_MS`, the time an agent takes to ask again).
   */
  keep: (heldMs?: number) => Promise<void>
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
 * one. `since` places it where somebody stood who was already waiting — one
 * that had a lock and let it go for want of the machine (`run.ts`).
 */
export async function joinQueue(
  dir: string,
  holder: Holder,
  now: () => number,
  since?: number,
): Promise<Place> {
  await mkdir(dir, { recursive: true })
  const at = since ?? now()
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

/**
 * How long a kept place goes on holding its turn, from one look to the next,
 * while whoever kept it is waiting for something they need before it
 * (`holdKept`). It is a few of those looks, so a place that stops being held
 * holds nobody up for long after.
 */
export const STILL_MS = 10_000

/** Whoever has what a kept place's asker waits for: the process, and where it runs. */
export interface WaitedFor {
  pid: number
  /** Where it runs. Unknown — a lock somebody took without saying — is any waiter of that process. */
  where?: string
}

/**
 * Make the place `as` kept in `dir` hold its turn for at least `ms` more.
 * This is for a run waiting for its checkout, or the batch tree, before it
 * waits for the machine (`run.ts`, `batch.ts`). While it does, it is not gone,
 * but its kept place stopped holding its turn `HELD_MS` after it was kept, and
 * a suite that started after it took the slot.
 *
 * The exception is a place behind it that is one of `waitingFor` — whoever
 * has the lock the asker waits for, waiting for the machine behind this
 * place — because holding the turn against them would leave each waiting for
 * the other. They are let through (`through`, read by `waitingAhead`), and
 * the place goes on holding its turn against everybody else. It is matched by
 * process and where, and never by where alone: a run in the batch tree waits
 * for the checkout's lock, whose holder waits from the checkout, and a shell's
 * suite in the checkout that asked after this place holds no lock and is not
 * who it waits for. Leaving the place to lapse instead, as it once did, let
 * that suite in between the lock's holder letting go of the machine and the
 * asker taking the lock and asking for it.
 * Says whether it now holds its turn for that long.
 */
export async function holdKept(
  dir: string,
  as: string,
  opts: { waitingFor: readonly WaitedFor[]; ms: number; now: () => number },
): Promise<boolean> {
  const names = await readdir(dir).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
    throw err
  })
  const order = (name: string) =>
    TICKET.exec(name)?.[1] ?? KEPT.exec(name)?.[1] ?? TAKING.exec(name)?.[1]
  for (const name of names.sort()) {
    const ticket = KEPT.exec(name)?.[1]
    if (!ticket) continue
    const path = join(dir, name)
    const kept = await keptAt(path)
    if (!kept || kept.as !== as || kept.until <= opts.now() || !(await holderAt(path))) continue
    const behind = names.filter((other) => {
      const at = order(other)
      return at !== undefined && at > ticket
    })
    const through: WaitedFor[] = []
    for (const other of behind) {
      const one = await holderAt(join(dir, other))
      if (one && letThrough(opts.waitingFor, one)) {
        through.push({ pid: one.pid, ...(one.where === undefined ? {} : { where: one.where }) })
      }
    }
    const until = opts.now() + opts.ms
    // Held long enough already, for the same ones let through, it is not
    // written again on every look.
    if (kept.held - opts.now() >= opts.ms / 2 && sameThrough(kept.through, through)) return true
    // Moved out of the way while it is written again, as `takeBack` moves it,
    // so a wait that takes it back meanwhile has it, rather than a copy left
    // behind as well. A place being moved still counts as ahead (`waitingAhead`).
    const taking = `${path}.${process.pid}-${tickets++}.taking`
    const moved = await rename(path, taking).then(
      () => true,
      (err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw err
      },
    )
    if (!moved) return false
    holdUntilExit(taking)
    try {
      const raw = JSON.parse(await readFile(taking, 'utf8')) as Record<string, unknown>
      await writeAside(path, {
        ...raw,
        held: Math.max(kept.held, until),
        until: Math.max(kept.until, until),
        through,
      })
    } finally {
      letGoOf(taking)
      await rm(taking, { force: true })
    }
    return true
  }
  return false
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
    at,
    leave,
    keep: async (heldMs = HELD_MS) => {
      if (!holder.as) return leave()
      const kept = path.replace(/\.wait$/, '.kept')
      await writeAside(kept, {
        pid: process.pid,
        ...holder,
        at: new Date(at).toISOString(),
        held: now() + heldMs,
        until: now() + KEPT_MS,
      })
      holdUntilExit(kept)
      await leave()
    },
  }
}

/** Who a kept place lets through while it holds its turn, as written; nobody, for anything else. */
function throughIn(raw: unknown): WaitedFor[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((one: unknown) => {
    if (typeof one !== 'object' || one === null) return []
    const { pid, where } = one as { pid?: unknown; where?: unknown }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return []
    return [{ pid, ...(typeof where === 'string' ? { where } : {}) }]
  })
}

const sameThrough = (a: readonly WaitedFor[], b: readonly WaitedFor[]): boolean =>
  a.length === b.length && a.every((one, i) => one.pid === b[i]?.pid && one.where === b[i]?.where)

/** Whether `holder` is one a kept place lets through: by process, and where where it said one. */
const letThrough = (through: readonly WaitedFor[], holder: LockHolder | null): boolean =>
  holder !== null &&
  through.some(
    (them) => them.pid === holder.pid && (them.where === undefined || them.where === holder.where),
  )

async function writeAside(path: string, body: Record<string, unknown>): Promise<void> {
  const aside = `${path}.writing`
  await writeFile(aside, `${JSON.stringify(body)}\n`, { mode: 0o600 })
  await rename(aside, path)
}

/**
 * What a kept place says: whose, since when it was waited for, until when it
 * still holds its turn (none, written before it did), and until when it is kept.
 */
async function keptAt(path: string): Promise<{
  as: string
  at: number
  held: number
  until: number
  through: WaitedFor[]
} | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const at = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN
    if (typeof raw.as !== 'string' || typeof raw.until !== 'number' || Number.isNaN(at)) return null
    const held = typeof raw.held === 'number' ? raw.held : 0
    return { as: raw.as, at, held, until: raw.until, through: throughIn(raw.through) }
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
 * away. A place kept aside counts while it still holds its turn (`HELD_MS`),
 * except to one it lets through (`holdKept`), and after that is not a ticket:
 * nobody is waiting on it. One being taken
 * back counts too: for that moment there is neither a kept place nor a ticket,
 * and a wait polling behind it found the queue empty and went first.
 */
export async function waitingAhead(
  dir: string,
  ticket: string | null,
  now: () => number = Date.now,
): Promise<LockHolder[]> {
  const mine = ticket === null ? null : (TICKET.exec(ticket)?.[1] ?? ticket)
  // A place moves — kept, being taken back, a ticket again — and one that
  // moved between the listing and the reading is in neither, which read as
  // nobody ahead. So one found gone is looked for again under its new name.
  for (let look = 1; ; look++) {
    // No queue yet is nobody waiting; a queue that cannot be read is not, and is thrown.
    const names = await readdir(dir).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
      throw err
    })
    const ahead = names
      .map((name) => ({
        name,
        order: TICKET.exec(name)?.[1] ?? KEPT.exec(name)?.[1] ?? TAKING.exec(name)?.[1],
      }))
      .filter(
        (one): one is { name: string; order: string } =>
          one.order !== undefined && (mine === null || one.order < mine),
      )
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    // Who is asking, as their own ticket says: a kept place that lets them
    // through (`holdKept`) is not ahead of them. A taker with no ticket is
    // nobody it lets through.
    const own = mine === null ? undefined : names.find((name) => TICKET.exec(name)?.[1] === mine)
    const asker = own === undefined ? null : await holderAt(join(dir, own))
    const looked = await Promise.all(
      ahead.map(async ({ name }): Promise<LockHolder | null | typeof MOVED> => {
        const path = join(dir, name)
        if (KEPT.test(name)) {
          // Lapsed and dead ones are cleared by whoever asks again (`takeBack`).
          const kept = await keptAt(path)
          if (kept && (kept.held <= now() || letThrough(kept.through, asker))) return null
          return (kept && (await holderAt(path))) ?? ((await there(path)) ? null : MOVED)
        }
        const holder = await holderAt(path)
        if (holder) return holder
        if (!(await there(path))) return MOVED
        await rm(path, { force: true })
        return null
      }),
    )
    if (look < LOOKS && looked.includes(MOVED)) continue
    return looked.filter((one): one is LockHolder => one !== null && one !== MOVED)
  }
}

/**
 * Who is waiting in `dir` at this moment, by their tickets alone, oldest
 * first: a place kept aside belongs to somebody who gave up and may ask again,
 * which is not the same as waiting. A run that has its checkout and waits for
 * the machine has a ticket (`run.ts`); a run waiting for that checkout behind
 * it holds its machine place kept aside, from the same process and where, and
 * must not be taken for it.
 */
export async function waitingNow(dir: string): Promise<LockHolder[]> {
  const names = await readdir(dir).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
    throw err
  })
  const held = await Promise.all(
    names
      .filter((name) => TICKET.test(name))
      .sort()
      .map((name) => holderAt(join(dir, name))),
  )
  return held.filter((one): one is LockHolder => one !== null)
}

/** A place that was listed and had gone by the time it was read. */
const MOVED = Symbol('moved')
/** How many times a queue is listed again for places that moved while it was read. */
const LOOKS = 3

async function there(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    },
  )
}

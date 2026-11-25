import { createHash } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { holdUntilExit, letGoOf } from './held.ts'
import { joinQueue, type Place, takeBack, waitingAhead } from './turn.ts'

// One run at a time, per worktree.
//
// In the default `checkout` workspace every agent shares one checkout, so four
// agents each deciding to run the suite before their push is four suites on
// one machine — precisely the starvation the tests warn about, and it would be
// Tade causing it. The lock is why running checks should go through Tade
// rather than an agent typing the command in a shell: the dedup, the record
// and the row in the window all come with it.
//
// It is only half of the bound. Six worktrees are six of these locks, and that
// was sixty-seven vitest processes on one laptop, so a run that needs the
// machine also takes one of the machine's own slots (`machine.ts`), which are
// claimed exactly the way this is.
//
// The rule is `lockHome`'s: a lock whose process is gone is not a lock, so a
// stale one is taken over rather than reported. Nobody is locked out by a
// crash, and nobody is ever told the checks passed because somebody else's run
// did.

export interface RunLock {
  release(): Promise<void>
}

/** A worktree's lock had by waiting for it in turn (`waitForRunLock`). */
export interface WaitedLock extends RunLock {
  /**
   * Let the worktree go and keep the asker's place, where they first stood, as
   * a wait that gave up at its deadline keeps it: for a run that had the
   * worktree and then gave up waiting for the machine (`run.ts`). Let go with
   * `release` instead, its place went with the lock, and the run behind had
   * the worktree the moment it was free.
   */
  giveUp(): Promise<void>
}

/** Who is running what here, when somebody is. */
export interface LockHolder {
  pid: number
  /** What it is running, as it said: `tests`, `format, types`. */
  what: string
  /** When it started, as an ISO time. */
  at: string
  /** Where it is running, for a lock that is not about one worktree: the checkout. */
  where?: string
}

export function lockPath(records: string): string {
  return join(records, 'checks.lock')
}

/**
 * Claim this worktree for a run. Null when somebody else has it, with who and
 * since when, so the caller can wait or say so — never pretend.
 */
export function takeRunLock(
  records: string,
  what: string,
  now: () => number = Date.now,
  /** Where the run runs, so whoever waits for this lock can tell it among those waiting for the machine (`holdKept`). */
  where?: string,
): Promise<RunLock | { held: LockHolder }> {
  return claim(lockPath(records), where === undefined ? { what } : { what, where }, now)
}

/** Who is running checks in this worktree, or null. A dead pid is nobody. */
export function heldBy(records: string): Promise<LockHolder | null> {
  return holderAt(lockPath(records))
}

let claims = 0

/**
 * Claim one lock file: made exclusively, with this process as its holder. One
 * whose holder is gone is taken over; one whose holder is alive is answered
 * with who it is.
 *
 * It is written aside and linked into place, never made empty and filled in.
 * Made and then written, there was a moment in which it was empty, and an
 * empty lock reads as nobody's (`holderAt`): a second taker in that moment
 * removed it and took it too, and two runs went on in one checkout. Every
 * release after that removed whoever's lock was there by then, so once two
 * shared it nobody had it alone again. So a release takes back only the lock
 * it wrote — every run in the window has the window's pid, so the pid alone
 * cannot say whose it is, and each claim writes its own `claim`.
 *
 * A dead holder's lock is removed only by whoever takes it over (`takeOver`).
 * Two takers who both found it dead used each to remove it and link their own,
 * and the second's removal was of the first's fresh lock: both held it. Nor is
 * a lock that went between failing to link it and reading it anybody's to
 * remove — that one is linked for again, since the next might be live.
 */
export async function claim(
  path: string,
  holder: { what: string; where?: string },
  now: () => number = Date.now,
): Promise<RunLock | { held: LockHolder }> {
  await mkdir(dirname(path), { recursive: true })
  const at = new Date(now()).toISOString()
  const mine = `${process.pid}-${claims++}`
  const text = `${JSON.stringify({ pid: process.pid, ...holder, at, claim: mine })}\n`
  const aside = `${path}.${mine}.writing`
  await writeFile(aside, text, { mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(aside, path)
        // Given back however this process ends, a reload included (`held.ts`).
        holdUntilExit(path)
        return {
          release: async () => {
            letGoOf(path)
            // Gone already is given back; a lock that cannot be read is thrown, not left.
            const there = await readFile(path, 'utf8').catch((err: unknown) => {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
              throw err
            })
            if (there === text) await rm(path, { force: true })
          },
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        const there = await textAt(path)
        if (there === null) continue
        const held = holderIn(there)
        if (held) return { held }
        const taking = await takeOver(path, there, holder, now)
        if (taking) return taking
      }
    }
    return { held: { pid: 0, ...holder, at } }
  } finally {
    await rm(aside, { force: true })
  }
}

/**
 * Remove a dead holder's lock, as the one taker allowed to: whoever holds the
 * guard named after exactly that lock, claimed the way the lock is — so a
 * guard whose taker died is taken over by the same rule, one level down. While
 * the guard is held nobody else may remove the dead lock, so one that still
 * reads as the dead one is that one; a taker who comes late finds the guard
 * held, or the lock gone or somebody's new one, and removes nothing. Somebody
 * else taking it over is who has it.
 */
async function takeOver(
  path: string,
  dead: string,
  holder: { what: string; where?: string },
  now: () => number,
): Promise<{ held: LockHolder } | null> {
  const which = createHash('sha256').update(dead).digest('hex').slice(0, 16)
  const guard = await claim(`${path}.${which}.taking`, holder, now)
  if ('held' in guard) return guard
  try {
    if ((await textAt(path)) === dead) await rm(path, { force: true })
  } finally {
    await guard.release()
  }
  return null
}

/** What a lock file says; null when there is none. One nobody can read says nothing. */
async function textAt(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((err: unknown) =>
    (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : '',
  )
}

/** Who holds one lock file, or null. A dead pid is nobody, and so is a file nobody can read. */
export async function holderAt(path: string): Promise<LockHolder | null> {
  return holderIn((await textAt(path)) ?? '')
}

/** Who a lock's text names, if they are alive. */
function holderIn(text: string): LockHolder | null {
  if (!text.trim()) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  const pid = typeof raw.pid === 'number' ? raw.pid : 0
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
  } catch (err) {
    // EPERM means somebody else's process is there, which still counts.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return null
  }
  return {
    pid,
    what: typeof raw.what === 'string' ? raw.what : '',
    at: typeof raw.at === 'string' ? raw.at : '',
    ...(typeof raw.where === 'string' ? { where: raw.where } : {}),
  }
}

/** Where those waiting for this worktree hold their place, one ticket each (`turn.ts`). */
export function runQueueDir(records: string): string {
  return join(records, 'checks.queue')
}

/**
 * Wait for the worktree, up to a point, and then say who has it. Waiting is
 * the polite half of the same rule: a second asker queues rather than starting
 * a second suite — and in turn, so a lock let go goes to whoever has waited
 * longest rather than whoever looks next. Somebody ahead in the queue is who
 * it is waiting for, while the lock itself is free for that moment.
 */
export async function waitForRunLock(
  records: string,
  what: string,
  opts: {
    waitMs?: number
    everyMs?: number
    now?: () => number
    /** Who the wait is for, so giving up at the deadline keeps their place (`turn.ts`). */
    as?: string
    /** Where the asker runs, written in the lock and in its place in the queue (`takeRunLock`). */
    where?: string
    /**
     * Done at every look while the wait goes on, told who has the lock (or is
     * ahead for it). A run uses it to hold the turn of the machine place it
     * kept, which it needs next, unless that one waits behind it (`run.ts`).
     */
    meanwhile?: (held: LockHolder) => Promise<unknown>
  } = {},
): Promise<WaitedLock | { held: LockHolder }> {
  const now = opts.now ?? Date.now
  const asked = now()
  const deadline = asked + (opts.waitMs ?? 0)
  const every = opts.everyMs ?? 250
  const queue = runQueueDir(records)
  // Taken only once there is a wait, or taken back where this asker kept one;
  // kept at the deadline, and given up however else it ends.
  const where = opts.where
  const holder = where === undefined ? { what } : { what, where }
  let place: Place | null = opts.as ? await takeBack(queue, { ...holder, as: opts.as }, now) : null
  let gaveUp = false
  try {
    for (;;) {
      const ahead = await waitingAhead(queue, place?.name ?? null, now)
      const got = ahead[0]
        ? { held: (await heldBy(records)) ?? ahead[0] }
        : await takeRunLock(records, what, now, where)
      if (!('held' in got)) {
        const as = opts.as
        const since = place?.at ?? asked
        return {
          release: () => got.release(),
          giveUp: async () => {
            // Kept before the worktree goes, so nobody behind finds it free
            // with no place ahead of them.
            if (as) await (await joinQueue(queue, { ...holder, as }, now, since)).keep()
            await got.release()
          },
        }
      }
      if (now() >= deadline) {
        gaveUp = true
        return got
      }
      place ??= await joinQueue(queue, opts.as ? { ...holder, as: opts.as } : holder, now)
      await opts.meanwhile?.(got.held)
      await pause(every)
    }
  } finally {
    await (gaveUp ? place?.keep() : place?.leave())
  }
}

/** A wait that never holds the process open by itself. */
export function pause(ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms)
    timer.unref?.()
  })
}

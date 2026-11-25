import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { holdUntilExit, letGoOf } from './held.ts'
import { joinQueue, type Place, waitingAhead } from './turn.ts'

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
): Promise<RunLock | { held: LockHolder }> {
  return claim(lockPath(records), { what }, now)
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
    for (let attempt = 0; attempt < 2; attempt++) {
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
        const held = await holderAt(path)
        if (held) return { held }
        await rm(path, { force: true })
      }
    }
    return { held: { pid: 0, ...holder, at } }
  } finally {
    await rm(aside, { force: true })
  }
}

/** Who holds one lock file, or null. A dead pid is nobody, and so is a file nobody can read. */
export async function holderAt(path: string): Promise<LockHolder | null> {
  const text = await readFile(path, 'utf8').catch(() => '')
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
  opts: { waitMs?: number; everyMs?: number; now?: () => number } = {},
): Promise<RunLock | { held: LockHolder }> {
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.waitMs ?? 0)
  const every = opts.everyMs ?? 250
  const queue = runQueueDir(records)
  // Taken only once there is a wait, and given up however it ends.
  let place: Place | null = null
  try {
    for (;;) {
      const ahead = await waitingAhead(queue, place?.name ?? null)
      const got = ahead[0]
        ? { held: (await heldBy(records)) ?? ahead[0] }
        : await takeRunLock(records, what, now)
      if (!('held' in got)) return got
      if (now() >= deadline) return got
      place ??= await joinQueue(queue, { what }, now)
      await pause(every)
    }
  } finally {
    await place?.leave()
  }
}

/** A wait that never holds the process open by itself. */
export function pause(ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms)
    timer.unref?.()
  })
}

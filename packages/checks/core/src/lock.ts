import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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

/**
 * Claim one lock file: made exclusively, with this process as its holder. One
 * whose holder is gone is taken over; one whose holder is alive is answered
 * with who it is.
 */
export async function claim(
  path: string,
  holder: { what: string; where?: string },
  now: () => number = Date.now,
): Promise<RunLock | { held: LockHolder }> {
  await mkdir(dirname(path), { recursive: true })
  const at = new Date(now()).toISOString()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, 'wx', 0o600)
      await fh.write(`${JSON.stringify({ pid: process.pid, ...holder, at })}\n`)
      await fh.close()
      return { release: () => rm(path, { force: true }) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const held = await holderAt(path)
      if (held) return { held }
      await rm(path, { force: true })
    }
  }
  return { held: { pid: 0, ...holder, at } }
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

/**
 * Wait for the worktree, up to a point, and then say who has it. Waiting is
 * the polite half of the same rule: a second asker queues rather than starting
 * a second suite.
 */
export async function waitForRunLock(
  records: string,
  what: string,
  opts: { waitMs?: number; everyMs?: number; now?: () => number } = {},
): Promise<RunLock | { held: LockHolder }> {
  const deadline = (opts.now ?? Date.now)() + (opts.waitMs ?? 0)
  const every = opts.everyMs ?? 250
  for (;;) {
    const got = await takeRunLock(records, what, opts.now)
    if (!('held' in got)) return got
    if ((opts.now ?? Date.now)() >= deadline) return got
    await pause(every)
  }
}

/** A wait that never holds the process open by itself. */
export function pause(ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms)
    timer.unref?.()
  })
}

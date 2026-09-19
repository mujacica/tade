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
}

export function lockPath(worktree: string): string {
  return join(worktree, '.tade', 'checks.lock')
}

/**
 * Claim this worktree for a run. Null when somebody else has it, with who and
 * since when, so the caller can wait or say so — never pretend.
 */
export async function takeRunLock(
  worktree: string,
  what: string,
  now: () => number = Date.now,
): Promise<RunLock | { held: LockHolder }> {
  const path = lockPath(worktree)
  await mkdir(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, 'wx', 0o600)
      await fh.write(
        `${JSON.stringify({ pid: process.pid, what, at: new Date(now()).toISOString() })}\n`,
      )
      await fh.close()
      return { release: () => rm(path, { force: true }) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const holder = await heldBy(worktree)
      if (holder) return { held: holder }
      await rm(path, { force: true })
    }
  }
  return { held: { pid: 0, what, at: new Date(now()).toISOString() } }
}

/** Who is running checks in this worktree, or null. A dead pid is nobody. */
export async function heldBy(worktree: string): Promise<LockHolder | null> {
  const text = await readFile(lockPath(worktree), 'utf8').catch(() => '')
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
  }
}

/**
 * Wait for the worktree, up to a point, and then say who has it. Waiting is
 * the polite half of the same rule: a second asker queues rather than starting
 * a second suite.
 */
export async function waitForRunLock(
  worktree: string,
  what: string,
  opts: { waitMs?: number; everyMs?: number; now?: () => number } = {},
): Promise<RunLock | { held: LockHolder }> {
  const deadline = (opts.now ?? Date.now)() + (opts.waitMs ?? 0)
  const every = opts.everyMs ?? 250
  for (;;) {
    const got = await takeRunLock(worktree, what, opts.now)
    if (!('held' in got)) return got
    if ((opts.now ?? Date.now)() >= deadline) return got
    await new Promise((done) => {
      const timer = setTimeout(done, every)
      timer.unref?.()
    })
  }
}

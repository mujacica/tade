import { createHash } from 'node:crypto'
import { copyFile, mkdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runtimeDir, tadeHome } from '@tade/core'

// A copy of a checkout's index that git has refreshed, for `git status` to
// read through where the index itself is too far behind the files to read
// in time.
//
// Every `git status` Tade runs has optional locks off (`GIT_ENV` in
// `git.ts`), so it never takes the lock an agent commits through — and so it
// never writes back what it learns either. A file whose stat no longer matches
// what the index says of it is read and hashed again on every look, through
// whatever clean filter it has, until something else refreshes the index. On
// 2026-10-21 a commit renormalized 1,008 files in vrolta into Git LFS, and
// every look ran LFS's clean filter over them past its 5 s budget, every beat:
// the look was unread until an agent's own git happened to refresh the index.
//
// Refreshing the index itself would take that lock for as long as the refresh
// runs, which is as long as the look that ran out of time, and an agent's
// commit in that while fails. So the refresh is of a copy, in Tade's runtime
// folder (nothing Tade writes is inside a project), taken when a look runs out
// of time and given far longer than a look, in the background: the beat goes
// on answering with the last look that could. Looks read through the copy for
// as long as it is a copy of the index as it is now. The index moving — a
// stage, a commit, an agent's status refreshing it — is the copy going: the
// next look reads the index itself, and where that is slow again, this starts
// again.
//
// What the copy says is what the index says: the same entries and the same
// object ids, with fresher stat information. Its mtime is set to the index's
// own, because git takes a file changed at or after the index was written as
// one to hash rather than trust (racy git), and a copy dated later would trust
// a file the index would not.

/** How long the refresh of one copy may take: far past a look, since it runs beside them. */
export const REFRESH_MS = 120_000

/** How the copier runs git: `git.ts`'s own `git`, handed in so the two do not import each other. */
export type RunGit = (
  dir: string,
  args: string[],
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
) => Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }>

interface Copy {
  /** The index this is a copy of. */
  index: string
  /** The copy. */
  path: string
  /** The index's marks when it was copied: the copy stands only while they still read the same. */
  of: string
}

interface Refreshing {
  done: Promise<boolean>
  /** Why the last refresh left no copy, in words for the look's warning. */
  why: string | null
  /** When a refresh that failed may be tried again: a refresh is expensive, and a broken one does not mend itself. */
  until: number
}

/** The refreshed copy each checkout's looks read through, by the folder git is run in. */
const copies = new Map<string, Copy>()
const refreshing = new Map<string, Refreshing>()

/**
 * Where `git status` in `dir` should read the index from: a refreshed copy,
 * as `GIT_INDEX_FILE`, or nothing where there is none or the index has moved
 * since it was taken — which is also when a copy is forgotten. Its file is
 * left for the next refresh of this checkout to write over, as it is the
 * runtime folder's to clear.
 */
export async function freshIndexFor(dir: string): Promise<Record<string, string> | null> {
  const copy = copies.get(dir)
  if (!copy) return null
  if ((await marksOf(copy.index)) === copy.of) return { GIT_INDEX_FILE: copy.path }
  copies.delete(dir)
  return null
}

/**
 * Refresh a copy of `dir`'s index in the background, because a look there ran
 * out of time. Once at a time per checkout, and not again for `REFRESH_MS`
 * after one failed, whose reason `freshIndexProblem` keeps for the look's
 * warning. Never rejects: nobody awaits it but a test, through
 * `freshIndexRefreshing`.
 */
export function refreshIndexOf(dir: string, run: RunGit, now = Date.now()): void {
  const was = refreshing.get(dir)
  if (was && now < was.until) return
  const entry: Refreshing = {
    done: Promise.resolve(false),
    why: null,
    until: Number.POSITIVE_INFINITY,
  }
  entry.done = refresh(dir, run)
    .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
    .then((why) => {
      if (why === null) {
        refreshing.delete(dir)
        return true
      }
      entry.why = `a refreshed copy of the index could not be made: ${why.split('\n')[0]}`
      entry.until = Date.now() + REFRESH_MS
      return false
    })
  refreshing.set(dir, entry)
}

/** Why the last refresh of `dir`'s index left no copy to read through, while it is not tried again. */
export function freshIndexProblem(dir: string): string | null {
  return refreshing.get(dir)?.why ?? null
}

/** The refresh under way for `dir`, for a test to wait on: whether it left a copy to read through. */
export function freshIndexRefreshing(dir: string): Promise<boolean> | null {
  return refreshing.get(dir)?.done ?? null
}

/** Forget every copy, and throw them away. For tests. */
export async function forgetFreshIndexes(): Promise<void> {
  const paths = [...copies.values()].map((copy) => copy.path)
  copies.clear()
  refreshing.clear()
  await Promise.all(paths.map((path) => rm(path, { force: true })))
}

/** Null where it left a copy to read through, and otherwise why not. */
async function refresh(dir: string, run: RunGit): Promise<string | null> {
  const where = await run(dir, ['rev-parse', '--git-path', 'index'], REFRESH_MS, {})
  if (!where.ok) return `git rev-parse failed: ${where.stderr}`
  const index = resolve(dir, where.stdout.trim())
  const folder = join(runtimeDir(tadeHome()), 'index')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const path = join(folder, createHash('sha1').update(dir).digest('hex').slice(0, 16))
  // Written beside the copy and renamed over it, so a look in another process
  // reading the copy that is there never reads half of this one.
  const next = `${path}.${process.pid}`
  try {
    const of = await marksOf(index)
    const at = await stat(index)
    await copyFile(index, next)
    await utimes(next, at.atime, at.mtime)
    // Never a split index, which would write its shared half into the project.
    const done = await run(
      dir,
      [
        '-c',
        'core.splitIndex=false',
        'update-index',
        '-q',
        '--unmerged',
        '--ignore-missing',
        '--refresh',
      ],
      REFRESH_MS,
      { GIT_INDEX_FILE: next },
    )
    if (!done.ok) {
      return done.timedOut
        ? `git update-index took longer than ${REFRESH_MS / 1000}s`
        : `git update-index failed: ${done.stderr}`
    }
    // An index that moved while this ran is a copy of an index that is gone.
    if ((await marksOf(index)) !== of) return 'the index moved while it was refreshed'
    await rename(next, path)
    copies.set(dir, { index, path, of })
    return null
  } finally {
    await rm(next, { force: true })
    await rm(`${next}.lock`, { force: true })
  }
}

/**
 * The index's marks, as the probe gate takes them: a rename by git is a new
 * inode. An index that is not there is a mark of its own; one that will not
 * stat for any other reason is thrown, and the look says so (`probeOf`).
 */
async function marksOf(path: string): Promise<string> {
  try {
    const s = await stat(path, { bigint: true })
    return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'
    throw err
  }
}

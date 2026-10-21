import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Reality, Workspace } from '@tade/core'
import { GIT_MS, git, keepIndexesFresh, newProbeGate, problemWith, REUSE_MS } from '@tade/status'
import { marksFrom, marksOf } from './files.ts'
import type { Change } from './frame.ts'
import { CHANGED_FORMAT, changedFrom, diffFrom, withUntracked } from './reality.ts'

// What git says about a checkout — what is changed in it, each file's mark,
// one file's diff, its branches — and when asking again would only find what
// the last look did.
//
// Here rather than in `live.ts`, as `work-look.ts` is for the ACTIONS tab:
// `Live` is how often anybody asks and what is held between asks, and this is
// what one ask *is*, with the gate in front of it.
//
// The FILES tree's marks, CHANGES and the branch were asked of git every two
// seconds whether anything had moved or not — four or five `git`s a look,
// about two a second on a window nobody was touching — for an answer that was
// nearly always the last one. So a look first reads a signature, and keeps the
// answer it already has while the signature reads the same as the one that
// answer was taken at. The signature is the status child's own
// (`newProbeGate`, `status/src/gate.ts`) — a stat of `.git/index`, `.git/HEAD`
// and the checkout's folder — and two things that one cannot see, because what
// it cannot see is an edit in place to a file git already tracks:
//
// - a stat of every path the last answer named, since a file already changed
//   being changed again moves its counts and nothing else, and
// - what status last said of the checkout — its head, how far ahead, and
//   every dirty path — since status looks behind its own gate every few
//   seconds anyway, and a file nobody had touched becoming touched is a new
//   path in that list.
//
// It is still a signature, so a kept answer stands only so long: `STANDS_MS`
// where status is watching the checkout, and status's own `REUSE_MS` where
// nothing is — a project's checkout with no agent in it, which only a look can
// say anything about.

/**
 * How long a kept answer may stand on a checkout status is watching, while
 * nothing in its signature has moved.
 *
 * A minute, as `LANDED_MS` is: with status's word in the signature, what is
 * left for this to catch is what neither a stat nor status says — the base a
 * change is measured from moving under it — and nobody watches that to the
 * second.
 */
export const STANDS_MS = 60_000

/** How many of the paths an answer named are stat'ed for its signature, at the most. */
const NAMED = 256

/** How many commits one look at a project's tree reads, at the most. */
const COMMITS_READ = 200

/** How many answers the gate remembers. Past this the oldest goes. */
const KEPT = 256

/** What a look whose answer still stands gives back, rather than asking git. */
export const STILL: unique symbol = Symbol('still')

/** The signature an answer was taken at, when, and how long it may stand on it. */
interface Held {
  seen: string
  at: number
  every: number
}

export class CheckoutGate {
  /** The status child's gate, asked only for its signature: the stats are the same stats. */
  private readonly probe = newProbeGate()
  private readonly held = new Map<string, Held>()
  private readonly told: (root: string) => string

  /** `told` is what status last said of a checkout, and `''` where it says nothing of it. */
  constructor(told: (root: string) => string) {
    this.told = told
    // The window looks again, so a look that ran out of time leaves the next
    // one an index it can read in time, as status's poller does (`fresh-index.ts`).
    keepIndexesFresh()
  }

  /**
   * Ask `look`, unless the answer it gave under `key` still stands: `STILL`
   * where it does, and otherwise whatever it answers. `null` is a look that
   * could not answer, and is never kept, so the next one asks again.
   *
   * The signature is read *before* the look, so whatever lands while git is
   * reading is a signature the next look does not recognise.
   */
  async ask<T>(
    key: string,
    root: string,
    named: readonly string[],
    now: number,
    look: () => Promise<T | null>,
  ): Promise<T | null | typeof STILL> {
    const seen = await this.signature(root, named)
    const was = this.held.get(key)
    if (seen && was?.seen === seen.seen && now >= was.at && now - was.at < was.every) return STILL
    const answer = await look()
    if (seen && answer !== null) this.keep(key, { seen: seen.seen, at: now, every: seen.every })
    return answer
  }

  /** Null where the checkout cannot be stat'ed: never a reuse, as status's gate says. */
  private async signature(
    root: string,
    named: readonly string[],
  ): Promise<{ seen: string; every: number } | null> {
    const tree = await this.probe.seen(root)
    if (tree === null) return null
    const told = this.told(root)
    const files = await Promise.all(named.slice(0, NAMED).map((path) => markOf(join(root, path))))
    return {
      seen: [tree, told, named.length, ...files].join('\n'),
      every: told === '' ? REUSE_MS : STANDS_MS,
    }
  }

  private keep(key: string, held: Held): void {
    this.held.delete(key)
    if (this.held.size >= KEPT) {
      const oldest = this.held.keys().next().value
      if (oldest !== undefined) this.held.delete(oldest)
    }
    this.held.set(key, held)
  }
}

/**
 * One path's marks, taken as the status gate takes them — the inode, because
 * a save by rename replaces a file rather than touching it, and nanoseconds
 * where there are any. A path that is not there is a mark of its own.
 */
export async function markOf(path: string): Promise<string> {
  try {
    const s = await stat(path, { bigint: true })
    return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  } catch {
    return 'gone'
  }
}

/**
 * What status last said of a checkout: for every task working in it, its head,
 * how far ahead of its base it is, and every changed file git tracks, with
 * git's code for it. `''` where no task works there, which is a checkout only a
 * look can say anything about.
 *
 * Not the files git does not track: nothing gated on this reads them — the
 * diff from the base cannot see one, and the window takes them from status
 * itself (`treesFrom`) — so a new file is not a reason to ask git for a diff.
 */
export function toldOf(world: Workspace | null, root: string): string {
  const at = resolve(root)
  const said: string[] = []
  for (const project of world?.projects ?? []) {
    for (const task of project.tasks) {
      if (!task.git || resolve(task.worktree) !== at) continue
      const tracked = Object.entries(task.git.xy ?? {})
        .filter(([, code]) => code !== '??')
        .map(([path, code]) => `${code} ${path}`)
      said.push([task.git.head, task.git.ahead, ...tracked].join('\0'))
    }
  }
  return said.join('\n')
}

/** What status said of a checkout it looks at, read the way the window draws it. */
export interface TreeSaid {
  /** What it was read out of, as one string: the same string is the same answer. */
  readonly of: string
  /** Each changed file's mark, as the FILES tree draws it (`markFor`). */
  readonly marks: Readonly<Record<string, string>>
  /** The files git does not track, which a diff from the base never names. */
  readonly untracked: readonly string[]
  /** How many files are changed and not committed. */
  readonly dirty: number
}

/**
 * What status said of every checkout a task works in, by where it is
 * (`resolve`d): the first task's look answers, because every task in one
 * checkout is handed the same one. A checkout no task works in is not here,
 * and is looked at by the window itself.
 *
 * One whose codes read as they did keeps the answer it had (`was`), so what a
 * frame was handed is the same object for as long as the tree is the same —
 * and a beat costs a string per checkout, not a map of marks.
 */
export function treesFrom(
  world: Workspace,
  was: ReadonlyMap<string, TreeSaid>,
): Map<string, TreeSaid> {
  const out = new Map<string, TreeSaid>()
  for (const project of world.projects) {
    for (const task of project.tasks) {
      const at = resolve(task.worktree)
      // A snapshot with no codes is one that did not say, which is a look.
      if (!task.git?.xy || out.has(at)) continue
      const xy = task.git.xy
      const of = JSON.stringify(xy)
      const kept = was.get(at)
      out.set(
        at,
        kept?.of === of
          ? kept
          : {
              of,
              marks: marksOf(xy),
              untracked: Object.keys(xy).filter((path) => xy[path] === '??'),
              dirty: Object.keys(xy).length,
            },
      )
    }
  }
  return out
}

/** What git says about each file under a checkout — changed, new, conflicted — or null. */
export async function marksIn(root: string): Promise<Record<string, string> | null> {
  const out = await git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  return out.ok ? marksFrom(out.stdout) : null
}

/**
 * What git tracks that changed in a checkout since it branched, measured from
 * where it branched — the merge base, so work that landed on `base` since is
 * not counted as the checkout's — or from `HEAD` where there is no base. Null
 * where git could not say.
 *
 * The diff alone: the files git does not track are what status said of the
 * checkout (`TreeSaid.untracked`), or `untrackedIn` where it says nothing.
 */
export async function diffSince(root: string, base: string | null): Promise<Change[] | null> {
  const since = base ? await git(root, ['merge-base', 'HEAD', base]) : null
  const from = since?.ok ? since.stdout.trim() : 'HEAD'
  const [names, numstat] = await Promise.all([
    git(root, ['diff', '--name-status', '-z', from]),
    git(root, ['diff', '--numstat', '-z', from]),
  ])
  if (!names.ok) return null
  return diffFrom(names.stdout, numstat.ok ? numstat.stdout : '')
}

/**
 * What a look at a checkout's changes found: what git tracks that changed
 * since the base, and the files it does not track where the look had to ask
 * for them — null where status said, which is every checkout an agent works in.
 */
export interface ChangesLooked {
  diff: Change[]
  untracked: readonly string[] | null
}

/** The diff since `base`, and `git status`'s untracked files only where `asks`. */
export async function changesIn(
  root: string,
  base: string | null,
  asks: boolean,
): Promise<ChangesLooked | null> {
  const [diff, untracked] = await Promise.all([
    diffSince(root, base),
    asks ? untrackedIn(root) : null,
  ])
  return diff && { diff, untracked }
}

/** No files git does not track, as one array, so an answer joined with it is kept. */
const NONE: readonly string[] = []

/**
 * What the window last found changed in each checkout, keyed by the place and
 * the base it is measured from, and the answer CHANGES draws out of it: the
 * diff joined with the files git does not track — status's word where it
 * looks at the tree, and the look's own where it does not.
 *
 * The answer is the same object for as long as neither half is a new one,
 * because it is read in every frame and a region is kept over identity.
 */
export class ChangesHeld {
  private readonly looked = new Map<string, ChangesLooked & { at: number }>()
  private readonly joined = new Map<string, { of: readonly unknown[]; changes: Change[] }>()

  /** When the checkout under `key` was last looked at: never is `null`. */
  at(key: string): number | null {
    return this.looked.get(key)?.at ?? null
  }

  /** Every path the last look named, which the gate's signature stats. */
  named(key: string): string[] {
    const was = this.looked.get(key)
    return [...(was?.diff ?? []).map((one) => one.path), ...(was?.untracked ?? [])]
  }

  /**
   * Keep what a look found, or that the last answer still stands (`STILL`),
   * as of `now`. True where it says something the last look did not, the
   * first look included: before it, the side drew `…`.
   */
  keep(key: string, looked: ChangesLooked | typeof STILL, now: number): boolean {
    const was = this.looked.get(key)
    if (looked === STILL) {
      if (was) this.looked.set(key, { ...was, at: now })
      return false
    }
    this.looked.set(key, { ...looked, at: now })
    const before = was ? { diff: was.diff, untracked: was.untracked } : null
    return (
      JSON.stringify({ diff: looked.diff, untracked: looked.untracked }) !== JSON.stringify(before)
    )
  }

  /** What is changed, or `null` before any look: not looked is not empty. */
  answer(key: string, said: readonly string[] | undefined): Change[] | null {
    const was = this.looked.get(key)
    if (!was) return null
    const untracked = said ?? was.untracked ?? NONE
    const kept = this.joined.get(key)
    if (kept?.of[0] === was.diff && kept.of[1] === untracked) return kept.changes
    const changes = withUntracked(was.diff, untracked)
    this.joined.set(key, { of: [was.diff, untracked], changes })
    return changes
  }
}

/**
 * The files git does not track in a checkout status says nothing of, out of a
 * `git status` of the window's own. None where it could not say, as CHANGES
 * always took a failed status: the diff is the half that can be wrong.
 */
export async function untrackedIn(root: string): Promise<string[]> {
  const out = await git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  if (!out.ok) return []
  const marks = marksFrom(out.stdout)
  return Object.keys(marks).filter((path) => marks[path] === 'U')
}

/**
 * One file's diff, from a root and a base like `changesIn`: a change in a
 * shared checkout is nobody's, so a task only names where to look. `null` is a
 * look that could not happen, and never an empty one.
 */
export async function diffIn(
  root: string,
  base: string | null,
  path: string,
): Promise<string | null> {
  const since = base ? await git(root, ['merge-base', 'HEAD', base]) : null
  const from = since?.ok ? since.stdout.trim() : 'HEAD'
  const tracked = await git(root, ['diff', '--no-color', '-U3', from, '--', path])
  if (tracked.ok && tracked.stdout.trim() !== '') return tracked.stdout
  // Nothing from `git diff` is two opposite answers: a file git tracks that
  // nobody changed, and one it never heard of, which is all new — an unchanged
  // file used to come back as the whole of it in green. `--no-index` exits 1
  // whenever it finds anything, so its output is all that says it looked.
  const known = await git(root, ['ls-files', '--error-unmatch', '--', path])
  if (known.ok) return tracked.ok ? tracked.stdout : null
  const added = await git(root, ['diff', '--no-color', '-U3', '--no-index', '/dev/null', path])
  return added.stdout.trim() === '' ? null : added.stdout
}

/** A checkout's branches, newest first, and the one it is on. */
export async function branchesIn(
  root: string,
): Promise<{ name: string; current: boolean; when: string }[]> {
  const out = await git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(HEAD)%00%(refname:short)%00%(committerdate:relative)',
    'refs/heads',
  ])
  if (!out.ok) return []
  return out.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [head, name, when] = line.split('\0')
      return { name: name ?? '', current: head === '*', when: when ?? '' }
    })
    .filter((row) => row.name !== '')
}

/** What one look at a shared checkout read, each half `null` where git could not read it. */
interface TreeRead {
  dirty: string[] | null
  committed: { task: string; paths: string[] }[] | null
  /** Why not, in `problemWith`'s words, where either half could not be read. */
  unread?: string
}

/**
 * What a shared checkout says now about the agents at work in it (`at`, each
 * with when it started): every dirty path, whoever changed it, and what each of
 * them has committed since the first of them started.
 */
async function treeIn(root: string, at: ReadonlyMap<string, number>): Promise<TreeRead> {
  const since = [...at.values()].sort((one, other) => one - other)[0]
  const [status, log] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    git(root, [
      'log',
      '-n',
      String(COMMITS_READ),
      ...(since === undefined ? [] : [`--since=${new Date(since).toISOString()}`]),
      `--format=${CHANGED_FORMAT}`,
      '--name-only',
    ]),
  ])
  const committed = new Map<string, Set<string>>()
  for (const commit of log.ok ? changedFrom(log.stdout) : []) {
    // Whose a commit is, is read back out of the trailer that says so —
    // never a table Tade keeps. One without it belongs to nobody.
    if (!at.has(commit.task)) continue
    const paths = committed.get(commit.task) ?? new Set<string>()
    for (const path of commit.paths) paths.add(path)
    committed.set(commit.task, paths)
  }
  // Once each, so git missing or a machine too busy for both is said once.
  const problems = [problemWith('git', status, GIT_MS), problemWith('git', log, GIT_MS)]
  const unread = [...new Set(problems.filter(Boolean))].join('; ')
  return {
    dirty: status.ok ? Object.keys(marksFrom(status.stdout)).sort() : null,
    committed: log.ok
      ? [...committed].map(([task, paths]) => ({ task, paths: [...paths].sort() }))
      : null,
    ...(unread ? { unread } : {}),
  }
}

/**
 * Each shared checkout as the last look that could read it, half by half.
 *
 * A failed `git status` or `git log` used to come back as nothing dirty and
 * nothing committed, which the queue reads as the files having settled: it
 * let held work go and started it on a look that never happened. So a half
 * git could not read is the last one it could, and the answer says why
 * (`Reality.unread`) — which the queue's rule takes as evidence that may only
 * hold. Kept by root, one entry a checkout, for as long as the window is open.
 */
export class TreeReads {
  private readonly last = new Map<string, Pick<Reality, 'dirty' | 'committed'>>()

  async look(
    root: string,
    at: ReadonlyMap<string, number>,
  ): Promise<Pick<Reality, 'dirty' | 'committed' | 'unread'>> {
    const now = await treeIn(root, at)
    const last = this.last.get(resolve(root)) ?? { dirty: [], committed: [] }
    const read = { dirty: now.dirty ?? last.dirty, committed: now.committed ?? last.committed }
    this.last.set(resolve(root), read)
    // What a look would have counted: the commits of agents still at work.
    const committed = read.committed.filter((one) => at.has(one.task))
    return { dirty: read.dirty, committed, ...(now.unread ? { unread: now.unread } : {}) }
  }
}

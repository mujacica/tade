import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Reality, Workspace } from '@tade/core'
import { git, newProbeGate, REUSE_MS } from '@tade/status'
import { marksFrom } from './files.ts'
import type { Change } from './frame.ts'
import { CHANGED_FORMAT, changedFrom, changesFrom } from './reality.ts'

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
 * how far ahead of its base it is, and every dirty path. `''` where no task
 * works there, which is a checkout only a look can say anything about.
 */
export function toldOf(world: Workspace | null, root: string): string {
  const at = resolve(root)
  const said: string[] = []
  for (const project of world?.projects ?? []) {
    for (const task of project.tasks) {
      if (!task.git || resolve(task.worktree) !== at) continue
      said.push([task.git.head, task.git.ahead, ...task.git.dirty].join('\0'))
    }
  }
  return said.join('\n')
}

/** What git says about each file under a checkout — changed, new, conflicted — or null. */
export async function marksIn(root: string): Promise<Record<string, string> | null> {
  const out = await git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  return out.ok ? marksFrom(out.stdout) : null
}

/**
 * Everything changed in a checkout since it branched, measured from where it
 * branched — the merge base, so work that landed on `base` since is not counted
 * as the checkout's — or from `HEAD` where there is no base. Null where git
 * could not say.
 */
export async function changesIn(root: string, base: string | null): Promise<Change[] | null> {
  const since = base ? await git(root, ['merge-base', 'HEAD', base]) : null
  const from = since?.ok ? since.stdout.trim() : 'HEAD'
  const [names, numstat, status] = await Promise.all([
    git(root, ['diff', '--name-status', '-z', from]),
    git(root, ['diff', '--numstat', '-z', from]),
    git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
  ])
  if (!names.ok) return null
  return changesFrom(names.stdout, numstat.ok ? numstat.stdout : '', status.ok ? status.stdout : '')
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

/**
 * What a shared checkout says now about the agents at work in it (`at`, each
 * with when it started): every dirty path, whoever changed it, and what each of
 * them has committed since the first of them started.
 */
export async function treeIn(
  root: string,
  at: ReadonlyMap<string, number>,
): Promise<Pick<Reality, 'dirty' | 'committed'>> {
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
  return {
    dirty: status.ok ? Object.keys(marksFrom(status.stdout)).sort() : [],
    committed: [...committed].map(([task, paths]) => ({ task, paths: [...paths].sort() })),
  }
}

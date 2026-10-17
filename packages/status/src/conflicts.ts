import { isAbsolute, relative } from 'node:path'
import {
  type Conflict,
  contested,
  type Elsewhere,
  hunksFrom,
  LIVE_STATES,
  liveBranchOf,
  sortConflicts,
  type Task,
  type Wrote,
} from '@tade/core'
import { git } from './git.ts'
import { pooled } from './pool.ts'

// The conflict forecast's look (the rules are core's `conflicts.ts`).
//
// With a worktree each: `git merge-tree --write-tree` between each pair of live
// branches, and each branch against its base, answers "these two would
// conflict in x.ts" without touching a ref, an index or a working tree. What a
// merge of two commits comes to depends on those two commits and nothing else,
// so an answer is kept by the pair of commit ids for as long as whoever polls
// holds it (`ConflictsHeld`): the heads come off the git look the gate already
// keeps (`newProbeGate`), so a beat on which no branch moved spawns nothing at
// all, and a beat on which one did asks only about the pairs it is in.
//
// In a shared checkout there is no merge to ask about yet: what collides is two
// agents with uncommitted hunks in one file. Git cannot say whose a hunk is, so
// whose comes from what each agent's harness said it wrote (`Wrote`, carried in
// from the window on the liveness table), and only where two of them claim one
// changed file is git asked anything — when each such file was last committed,
// because a commit of that file took whatever was in it (`hunksFrom`).
//
// Where the same repository is a project on another machine too, its live
// branches are in this home's mirror (`mirror.ts`, `core/src/elsewhere.ts`),
// and each of this project's live branches is merged with each of them there,
// in the same pass and out of the same keep: a pair of commit ids is the same
// merge in any repository that holds both. The mirror is where it runs, since
// only it holds the other machine's commits; the checkout is never asked to.
//
// Never throws, and every spawn has a deadline: a pair that could not be asked
// is named in a warning and left out, never answered as clean.

/** How long one `git merge-tree` may take: a merge of two big branches on a loaded machine. */
const MERGE_MS = 10_000

/**
 * How many merges one look may ask that it has not asked before. The rest wait
 * for the next beat, which finds the ones asked here already answered: the
 * first look at twelve live branches is 66 pairs, and a beat is two seconds.
 */
const MERGES_PER_LOOK = 12

/** How many answers are kept. Past this the oldest goes. */
const KEPT = 512

/** How many commits one look at a shared checkout's contested files reads, at the most. */
const COMMITS_READ = 200

/** What whoever polls holds between looks: answers that cannot have changed. */
export interface ConflictsHeld {
  /** By the two commits, in the order asked: the files a merge of them conflicts in. */
  merges: Map<string, string[]>
  /** By HEAD, the files asked about and how far back: when each was last committed. */
  commits: Map<string, Map<string, number>>
}

export function newConflictsHeld(): ConflictsHeld {
  return { merges: new Map(), commits: new Map() }
}

/** One merge to ask about, where it is asked, and the conflict it is if it does. */
interface Ask {
  conflict: Omit<Conflict, 'files'>
  ours: string
  theirs: string
  /** The repository that holds both commits: the project's, or its mirror for another machine's. */
  root: string
}

/** What one project's live work would collide over, and what could not be asked. */
export async function forecastConflicts(req: {
  root: string
  tasks: readonly Task[]
  base: { ref: string; oid: string } | null
  wrote: (task: string) => Promise<Wrote[]>
  pool: number
  held?: ConflictsHeld | undefined
  /** Other machines' live branches in this repository, in this home's mirror of it. */
  elsewhere?: Elsewhere | undefined
}): Promise<{ conflicts: Conflict[]; warnings: string[] }> {
  const held = req.held ?? newConflictsHeld()
  const warnings: string[] = []
  const found: Conflict[] = []
  try {
    found.push(...(await branchConflicts(req, held, warnings)))
    found.push(...(await checkoutConflicts(req, held, warnings)))
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    warnings.push(`${req.root}: could not forecast conflicts: ${why.split('\n')[0]}`)
  }
  return { conflicts: sortConflicts(found), warnings }
}

/** Each pair of live branches, and each live branch its base has moved under. */
async function branchConflicts(
  req: Parameters<typeof forecastConflicts>[0],
  held: ConflictsHeld,
  warnings: string[],
): Promise<Conflict[]> {
  const live = req.tasks.filter(liveBranchOf)
  const asks: Ask[] = []
  for (const [i, one] of live.entries()) {
    for (const other of live.slice(i + 1)) {
      const [a, b] = [one, other].sort((x, y) => x.id.localeCompare(y.id)) as [Task, Task]
      asks.push({
        conflict: { kind: 'branches', tasks: [a.id, b.id] },
        ours: a.git?.head ?? '',
        theirs: b.git?.head ?? '',
        root: req.root,
      })
    }
    // Each branch another machine is working on in this repository: merged in the mirror.
    for (const there of req.elsewhere?.branches ?? []) {
      asks.push({
        conflict: {
          kind: 'elsewhere',
          tasks: [one.id],
          elsewhere: { machine: there.machine, task: there.task, branch: there.branch },
        },
        ours: one.git?.head ?? '',
        theirs: there.head,
        root: req.elsewhere?.mirror ?? req.root,
      })
    }
    // A base that has not moved since the branch left it merges by fast-forward;
    // a branch stacked on another task's merges into that one, which the pair says.
    const own = (one.git?.baseRef ?? req.base?.ref) === req.base?.ref
    if (req.base && own && (one.git?.behind ?? 1) > 0) {
      asks.push({
        conflict: { kind: 'base', tasks: [one.id], base: req.base.ref },
        ours: req.base.oid,
        theirs: one.git?.head ?? '',
        root: req.root,
      })
    }
  }
  const unasked = asks.filter((ask) => !held.merges.has(keyOf(ask))).slice(0, MERGES_PER_LOOK)
  const answers = await pooled(unasked, req.pool, (ask) => mergeTree(ask.root, ask))
  for (const [i, ask] of unasked.entries()) {
    const answer = answers[i]
    if (!answer || 'problem' in answer) {
      warnings.push(
        `${ask.conflict.tasks.join(' and ')}: could not ask git whether ${unaskedSays(ask.conflict)}: ${answer && 'problem' in answer ? answer.problem : 'no answer'}`,
      )
      continue
    }
    keep(held.merges, keyOf(ask), answer.files)
  }
  const out: Conflict[] = []
  for (const ask of asks) {
    const files = held.merges.get(keyOf(ask))
    if (files && files.length > 0) out.push({ ...ask.conflict, files })
  }
  return out
}

function keyOf(ask: Ask): string {
  return `${ask.ours}\0${ask.theirs}`
}

/** What a merge that could not be asked was to answer, in the words of its warning. */
function unaskedSays(conflict: Ask['conflict']): string {
  if (conflict.kind === 'base') return `it would merge into ${conflict.base}`
  const there = conflict.elsewhere
  if (there) return `it would merge with ${there.task} on ${there.machine}`
  return 'they would merge'
}

/**
 * The files merging two commits would conflict in: `[]` for a clean merge.
 *
 * Exit 0 is clean and 1 is conflicted, with the tree and then each conflicted
 * file NUL-separated; anything else is git saying it could not, which is never
 * read as clean.
 */
async function mergeTree(
  root: string,
  ask: Ask,
): Promise<{ files: string[] } | { problem: string }> {
  const out = await git(
    root,
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ask.ours, ask.theirs],
    MERGE_MS,
  )
  if (out.ok) return { files: [] }
  const [tree, ...names] = out.stdout.split('\0')
  if (!/^[0-9a-f]{40,64}$/.test(tree ?? '')) {
    return { problem: out.stderr.split('\n')[0] || 'git did not answer in time' }
  }
  return { files: [...new Set(names.filter(Boolean))].sort() }
}

/** Two agents of one shared checkout with uncommitted hunks in the same file. */
async function checkoutConflicts(
  req: Parameters<typeof forecastConflicts>[0],
  held: ConflictsHeld,
  warnings: string[],
): Promise<Conflict[]> {
  const shared = req.tasks.filter(
    (task) => task.workspace === 'checkout' && LIVE_STATES.has(task.state),
  )
  if (shared.length < 2) return []
  const dirty = [...new Set(shared.flatMap((task) => task.git?.dirty ?? []))]
  const head = shared.find((task) => task.git?.head)?.git?.head ?? ''
  const claims = new Map<string, Wrote[]>()
  for (const task of shared) {
    const wrote = (await req.wrote(task.id)).flatMap((one) => {
      const path = inRoot(req.root, one.path)
      return path ? [{ path, at: one.at }] : []
    })
    if (wrote.length > 0) claims.set(task.id, wrote)
  }
  const paths = contested(claims, dirty)
  if (paths.length === 0) return []
  const open = new Set(paths)
  const since = Math.min(
    ...[...claims.values()].flat().flatMap((one) => (open.has(one.path) ? [one.at] : [])),
  )
  const committed = await lastCommitted(req.root, head, paths, since, held)
  if (!committed) {
    warnings.push(`${req.root}: could not ask git when ${paths.join(', ')} were last committed`)
    return []
  }
  return hunksFrom(claims, dirty, committed)
}

/** A path a harness reported, as the checkout names it; null for one outside it. */
function inRoot(root: string, path: string): string | null {
  const local = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//, '')
  return local && !local.startsWith('..') && !isAbsolute(local) ? local : null
}

/** When each of `paths` was last committed since `since`, in milliseconds; absent where it was not. */
async function lastCommitted(
  root: string,
  head: string,
  paths: readonly string[],
  since: number,
  held: ConflictsHeld,
): Promise<Map<string, number> | null> {
  // Whole seconds, as git keeps them, and one earlier: a commit in the same
  // second as the first write is one this has to see.
  const from = Math.floor(since / 1000) - 1
  const key = [head, from, ...paths].join('\0')
  const kept = held.commits.get(key)
  if (kept) return kept
  const out = await git(root, [
    'log',
    '-n',
    String(COMMITS_READ),
    `--since=@${from}`,
    '--format=%x00%ct',
    '--name-only',
    '--',
    ...paths,
  ])
  if (!out.ok) return null
  const last = new Map<string, number>()
  for (const chunk of out.stdout.split('\0')) {
    const [when, ...names] = chunk.split('\n')
    const at = Number(when) * 1000
    if (!Number.isFinite(at) || at <= 0) continue
    // Newest first, so the first time a file is named is when it was last committed.
    for (const name of names) if (name && !last.has(name)) last.set(name, at)
  }
  keep(held.commits, key, last)
  return last
}

function keep<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value)
  while (map.size > KEPT) map.delete(map.keys().next().value as string)
}

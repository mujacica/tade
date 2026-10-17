import type { TadeEvent } from './events.ts'
import type { Conflict, Task, TaskState } from './model.ts'

// The conflict forecast: which pieces of live work would collide, said before
// they do.
//
// Two ways to collide, one for each way a project keeps its agents. With a
// worktree each, it is a merge: `git merge-tree` between each pair of live
// branches and each branch against its base answers it, read-only and exactly,
// and the look is `status/src/conflicts.ts`. In a shared checkout nothing is a
// merge yet — it is two agents with uncommitted hunks in one file, which git
// cannot attribute and so is read off what each agent's harness said it wrote
// (`Wrote`), kept only while no commit has touched the file since. And where
// one repository is a project on two machines, it is a merge again: this
// machine's live branches against the other's, fetched into this home's mirror
// (`elsewhere.ts`) — told here, and never anything held or said there.
//
// A forecast is evidence, and evidence may only ever hold or tell: nothing here
// starts, stops or changes work. What is done about one is the orchestrator's
// (or the person's, as `queue.holds` says), told once per collision in words
// that name the call (`conflictSays`, in the window's `queue.ts`).
//
// Pure: facts in, answers out.

/** A file an agent's harness said it wrote, and when, as the window watched it. */
export interface Wrote {
  path: string
  at: number
}

/** The states whose work is still going somewhere: a branch that will be merged, hunks that will be committed. */
export const LIVE_STATES: ReadonlySet<TaskState> = new Set(['working', 'blocked', 'review'])

/**
 * Whether a task's branch is live work a merge could collide over: a branch of
 * its own, still going somewhere, not landed, with something on it. The same
 * question on every machine, so the one that answers another machine's mirror
 * (`web`'s repositories) and this one's forecast never disagree about it.
 */
export function liveBranchOf(task: Pick<Task, 'workspace' | 'state' | 'git'>): boolean {
  return (
    task.workspace !== 'checkout' &&
    LIVE_STATES.has(task.state) &&
    !!task.git?.head &&
    !task.git.mergedIntoBase &&
    (task.git.ahead ?? 1) > 0
  )
}

/** One side's view of a conflict: who or what is on the other side, and over which files. */
export interface ConflictOn {
  kind: Conflict['kind']
  /** The other task, the base branch for `base`, or `<task> on <machine>` for `elsewhere`. */
  with: string
  files: readonly string[]
}

/** Another machine's task, in the words every line about it uses: `tade/fix on vps`. */
export function elsewhereSaid(other: { machine: string; task: string }): string {
  return `${other.task} on ${other.machine}`
}

/** Who or what is on the other side of a conflict from `task`, in words; null where nothing is. */
export function otherSide(conflict: Conflict, task: string): string | null {
  if (conflict.kind === 'base') return conflict.base ?? 'its base'
  if (conflict.kind === 'elsewhere') {
    return conflict.elsewhere ? elsewhereSaid(conflict.elsewhere) : 'another machine'
  }
  return conflict.tasks.find((t) => t !== task) ?? null
}

/** The conflicts one task is in, as it would say them. */
export function conflictsOn(
  task: string,
  conflicts: readonly Conflict[] | undefined,
): ConflictOn[] {
  const out: ConflictOn[] = []
  for (const one of conflicts ?? []) {
    if (!one.tasks.includes(task)) continue
    const other = otherSide(one, task)
    if (other) out.push({ kind: one.kind, with: other, files: one.files })
  }
  return out
}

/**
 * Which dirty paths of a shared checkout more than one agent says it wrote.
 * Only these are worth asking git anything about.
 */
export function contested(
  claims: ReadonlyMap<string, readonly Wrote[]>,
  dirty: readonly string[],
): string[] {
  const open = new Set(dirty)
  const by = new Map<string, Set<string>>()
  for (const [task, wrote] of claims) {
    for (const one of wrote) {
      if (!open.has(one.path)) continue
      const tasks = by.get(one.path) ?? new Set<string>()
      tasks.add(task)
      by.set(one.path, tasks)
    }
  }
  return [...by]
    .filter(([, tasks]) => tasks.size > 1)
    .map(([path]) => path)
    .sort()
}

/**
 * Who has uncommitted hunks in the same file of a shared checkout.
 *
 * A write counts while the file is still changed and no commit has touched it
 * since (`committed`, by path, in milliseconds, as git's whole seconds): a
 * commit of that file takes whatever was in it, whoever wrote it, so a write
 * older than that commit is not a hunk anybody still holds. A commit in the
 * same second as a write is taken to have it — the later answer, and the one
 * that never invents a collision.
 */
export function hunksFrom(
  claims: ReadonlyMap<string, readonly Wrote[]>,
  dirty: readonly string[],
  committed: ReadonlyMap<string, number>,
): Conflict[] {
  const open = new Set(contested(claims, dirty))
  const holders = new Map<string, Set<string>>()
  for (const [task, wrote] of claims) {
    for (const one of wrote) {
      if (!open.has(one.path)) continue
      const last = committed.get(one.path)
      if (last !== undefined && one.at < last + 1_000) continue
      const tasks = holders.get(one.path) ?? new Set<string>()
      tasks.add(task)
      holders.set(one.path, tasks)
    }
  }
  const pairs = new Map<string, Set<string>>()
  for (const [path, tasks] of holders) {
    const sorted = [...tasks].sort()
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}\0${sorted[j]}`
        const files = pairs.get(key) ?? new Set<string>()
        files.add(path)
        pairs.set(key, files)
      }
    }
  }
  return sortConflicts(
    [...pairs].map(([key, files]) => ({
      kind: 'hunks' as const,
      tasks: key.split('\0'),
      files: [...files].sort(),
    })),
  )
}

/** In one order every time: the answer is compared, written down and drawn. */
export function sortConflicts(conflicts: readonly Conflict[]): Conflict[] {
  return [...conflicts].sort((a, b) => conflictKey(a).localeCompare(conflictKey(b)))
}

/** Which collision this is, whatever files it is over now. */
export function conflictKey(
  conflict: Pick<Conflict, 'kind' | 'tasks' | 'base' | 'elsewhere'>,
): string {
  const there = conflict.elsewhere ? `${conflict.elsewhere.machine}:${conflict.elsewhere.task}` : ''
  return [conflict.kind, ...conflict.tasks, conflict.base ?? '', there].join('\0')
}

/**
 * Which side gives way, and which keeps going.
 *
 * The one that finished its turn and is waiting for review lands first, so the
 * one still working takes its changes in; between two alike, the one started
 * later does, because the earlier one has the longer head start on the files.
 * A rule rather than a judgement, so it is the same every time it is said —
 * and only a suggestion: the call it names is the orchestrator's to make.
 */
export function whoYields(
  conflict: Conflict,
  tasks: ReadonlyMap<string, { state: TaskState; created: string }>,
): { yields: string; keeps: string | null } {
  const [one = '', other] = conflict.tasks
  // The other machine's agent is that machine's to steer: the side here gives way.
  if (conflict.kind !== 'branches' && conflict.kind !== 'hunks') return { yields: one, keeps: null }
  if (other === undefined) return { yields: one, keeps: null }
  const a = tasks.get(one)
  const b = tasks.get(other)
  const reviewing = (t: typeof a) => t?.state === 'review'
  if (reviewing(a) !== reviewing(b)) {
    return reviewing(a) ? { yields: other, keeps: one } : { yields: one, keeps: other }
  }
  const later = (b?.created ?? '') >= (a?.created ?? '') ? other : one
  return { yields: later, keeps: later === one ? other : one }
}

const KINDS = ['branches', 'base', 'hunks', 'elsewhere'] as const

/** The other machine's side of an `elsewhere` line, as it was written, or null. */
function elsewhereIn(value: unknown): Conflict['elsewhere'] | null {
  if (typeof value !== 'object' || value === null) return null
  const { machine, task, branch } = value as Record<string, unknown>
  if (typeof machine !== 'string' || typeof task !== 'string') return null
  return { machine, task, branch: typeof branch === 'string' ? branch : '' }
}

/** What the last `conflict_forecast` line said about each collision, by key. */
function toldOf(project: string, events: readonly TadeEvent[]): Map<string, Conflict | null> {
  const told = new Map<string, Conflict | null>()
  for (const event of events) {
    if (event.type !== 'conflict_forecast' || event.detail.project !== project) continue
    const detail = event.detail
    const tasks = Array.isArray(detail.tasks) ? detail.tasks.map(String) : []
    const kind = KINDS.find((one) => one === detail.kind) ?? 'branches'
    const base = typeof detail.base === 'string' ? detail.base : undefined
    const there = elsewhereIn(detail.elsewhere)
    const one: Conflict = {
      kind,
      tasks,
      ...(base ? { base } : {}),
      ...(there ? { elsewhere: there } : {}),
      files: Array.isArray(detail.files) ? detail.files.map(String) : [],
    }
    told.set(conflictKey(one), detail.gone === true ? null : one)
  }
  return told
}

/**
 * What to say about one project's forecast, given what was already said.
 *
 * A collision is told when it is first seen and again only when it reaches a
 * file it was not told over; one that was told and is no longer there is
 * written down as gone, so the next time it appears it is news again. Nothing
 * is said gone where the look said nothing — `undefined` is a look that could
 * not be made, and a forecast nobody could make is not every collision healed.
 */
export function conflictsToTell(
  project: string,
  now: readonly Conflict[] | undefined,
  events: readonly TadeEvent[],
): { tell: Conflict[]; gone: Conflict[] } {
  if (now === undefined) return { tell: [], gone: [] }
  const told = toldOf(project, events)
  const seen = new Set<string>()
  const tell: Conflict[] = []
  for (const one of now) {
    const key = conflictKey(one)
    seen.add(key)
    const was = told.get(key)
    if (was && one.files.every((file) => was.files.includes(file))) continue
    tell.push(one)
  }
  const gone: Conflict[] = []
  for (const [key, was] of told) if (was && !seen.has(key)) gone.push(was)
  return { tell: sortConflicts(tell), gone: sortConflicts(gone) }
}

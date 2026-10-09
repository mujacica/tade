import type { Finished } from './done.ts'
import type { TadeEvent } from './events.ts'
import type { DoneRule, StartCondition, TaskState } from './model.ts'
import { producesProblem } from './produces.ts'

// Work asked for now and started later.
//
// Queued work is a task that has not started, with a start condition in its
// task file: the tasks it waits on, and the time it waits for. Whether it can
// start is a query — of what status says the tasks are, what the journal says
// has finished or gone wrong, and the clock — so Tade acts on it by rule,
// without a model deciding again, and gives the same answer every time.
//
// Pure: facts in, answers out.

export interface Queued {
  task: string
  project: string
  /**
   * Set aside by a person, out of its own task file.
   *
   * Every other answer below is folded out of the journal, the clock or the
   * tree. This one is told — it is one of the two things "no probe could ever"
   * answer — and `deriveState` gives it precedence over every state but a
   * merge, so the queue has to read it or a task drawn as parked everywhere
   * else starts anyway. Not optional: the one unsafe answer is `false`, and a
   * caller that has to say which cannot arrive at it by forgetting.
   */
  parked: boolean
  start: StartCondition
}

export interface QueueFacts {
  /** What status says each task is now. A task it does not list has gone. */
  tasks: ReadonlyMap<string, { state: TaskState; reason: string }>
  finished: ReadonlyMap<string, Finished>
  /** The journal: what was removed, stopped, failed, paused or started anyway. */
  events: readonly TadeEvent[]
  now: number
  /**
   * What each project's tree actually says, for work about to start in it.
   * A project nobody has looked at is absent — which is not the same as a
   * project where nothing has changed, and is why this is a map and not a
   * list: with no look, the last hold written stands until it is answered.
   */
  reality?: ReadonlyMap<string, Reality>
}

/**
 * What a project's tree says now, rather than what whoever planned the work
 * read in it. Gathered at the moment something is about to start, because
 * that is the moment it is true: an agent that began after the plan was
 * written has been changing files ever since.
 */
export interface Reality {
  workspace: 'checkout' | 'worktree'
  /** The agents at work in it now, by task. */
  working: readonly string[]
  /** Changed and not committed, whoever changed them. */
  dirty: readonly string[]
  /** What each agent at work has committed since it started, by task. */
  committed: readonly { task: string; paths: readonly string[] }[]
}

/** What queued work would land in the middle of, and why that is held. */
export interface Collision {
  /** The files both it and work going on now change. */
  paths: string[]
  /** Whose changes they are, where git says whose. */
  by: string[]
  /** Why it is held, in a sentence a person can read. */
  because: string
}

export type QueueState =
  /** What it waits on has not finished. */
  | { kind: 'waiting'; on: string[] }
  /** Someone has to decide: what it waits on failed, stopped or went, or it could not start. */
  | {
      kind: 'held'
      on: string | null
      because: string
      /** The files work going on now has changed, when that is what holds it. */
      changed?: readonly string[]
      /** Whose changes they are, where git says whose. */
      by?: readonly string[]
    }
  /** Not before a time. */
  | { kind: 'scheduled'; at: number }
  /**
   * Paused, on its own or with everything else in its project — or parked,
   * which is the same answer to "may this start" and a different word for
   * why: a pause is a choice about the queue, a park a choice about the task.
   */
  | { kind: 'paused'; all: boolean; parked?: boolean }
  /** It can start, and does as soon as its project has room. */
  | { kind: 'ready' }

/** What a person can do to queued work. */
export const QUEUE_CHANGES = ['pause', 'resume', 'start', 'wait', 'order'] as const
export type QueueChange = (typeof QUEUE_CHANGES)[number]

export interface Choices {
  paused: boolean
  /** Started anyway, whatever it waits on. */
  anyway: boolean
  /** Where the last choice was made: trouble before it has been answered. */
  answeredAt: number
}

/** Every choice a person has made about one piece of queued work. */
export function choicesFor(task: string, events: readonly TadeEvent[]): Choices {
  const choices: Choices = { paused: false, anyway: false, answeredAt: 0 }
  for (const event of events) {
    if (event.type !== 'queue_changed' || event.task !== task) continue
    switch (event.detail.change) {
      case 'pause':
        choices.paused = true
        break
      case 'resume':
        choices.paused = false
        choices.answeredAt = event.seq
        break
      case 'start':
        choices.anyway = true
        choices.answeredAt = event.seq
        break
      case 'wait':
        choices.anyway = false
        choices.answeredAt = event.seq
        break
    }
  }
  return choices
}

/**
 * The order last written for queued work, or nothing written. Like every
 * other choice about the queue it is a fact in the journal, with who made it
 * and why — never a score that recomputes, so the last line written wins and
 * nothing can be starved by something newer looking better.
 */
export function writtenOrder(events: readonly TadeEvent[]): string[] {
  let order: string[] = []
  for (const event of events) {
    if (event.type !== 'queue_changed' || event.detail.change !== 'order') continue
    const said = event.detail.order
    if (Array.isArray(said)) order = said.map(String).filter((task) => task !== '')
  }
  return order
}

/**
 * Ready work in the order last written for it; anything unnamed keeps its
 * place behind, in the order it was asked for.
 *
 * This is a preference among work that is already ready, and nothing more: it
 * cannot jump a wait, unhold a hold, resume a pause, exceed `max_parallel` or
 * change what `queueStateOf` says about anything. `readyToStart` keeps its
 * rule and its signature — what changes is only which of the ready ones is
 * looked at first.
 */
export function inWrittenOrder(items: readonly Queued[], events: readonly TadeEvent[]): Queued[] {
  const written = writtenOrder(events)
  if (written.length === 0) return [...items]
  const place = new Map(written.map((task, at) => [task, at]))
  const behind = written.length
  // A stable sort, so work nobody named stays in the order it arrived in.
  return [...items].sort(
    (one, other) => (place.get(one.task) ?? behind) - (place.get(other.task) ?? behind),
  )
}

/** An order that puts one piece of work first and leaves the rest as they were. */
export function orderFirst(
  items: readonly Queued[],
  events: readonly TadeEvent[],
  task: string,
): string[] {
  const rest = inWrittenOrder(items, events)
    .map((item) => item.task)
    .filter((one) => one !== task)
  return [task, ...rest]
}

/**
 * Whether a project's whole queue is paused: the last word on it, for that
 * project or for every project.
 */
export function queuePaused(events: readonly TadeEvent[], project: string): boolean {
  let paused = false
  for (const event of events) {
    if (event.type !== 'queue_changed' || event.detail.all !== true) continue
    const scope = event.detail.project
    if (typeof scope === 'string' && scope !== project) continue
    if (event.detail.change === 'pause') paused = true
    if (event.detail.change === 'resume') paused = false
  }
  return paused
}

/**
 * Why something a task waits on is in trouble, if it is: gone, failed, or
 * stopped before it finished. Only trouble since the last time somebody chose
 * to wait anyway counts, and a run started again clears what came before it.
 */
function troubleWith(dep: string, facts: QueueFacts, since: number): string | null {
  let removed = false
  let stopped = false
  let failed = false
  for (const event of facts.events) {
    if (event.task !== dep) continue
    if (event.type === 'run_started') {
      stopped = false
      failed = false
    }
    if (event.seq <= since) continue
    if (event.type === 'task_removed') removed = true
    if (event.type === 'run_exited' && event.detail.stopped === true) stopped = true
    const code = event.detail.code
    if (
      event.type === 'failed' ||
      (event.type === 'run_exited' && typeof code === 'number' && code !== 0)
    ) {
      failed = true
    }
  }
  const now = facts.tasks.get(dep)
  if (!now)
    return removed ? `${dep} was removed before it finished` : `${dep} is not there any more`
  // A failure somebody already chose to wait past holds nothing until it fails again.
  if (now.state === 'failed' && (since === 0 || failed)) {
    return now.reason ? `${dep} failed: ${now.reason}` : `${dep} failed`
  }
  if (stopped && now.state !== 'working') return `${dep} was stopped before it finished`
  return null
}

/**
 * Why a task's own start failed, since anyone last answered it.
 *
 * Exported because the inbox asks the same question of an intake-originated
 * task and the answer must be the same sentence: a second reading of the same
 * events is a second answer, and the one place this is read from is here.
 */
export function troubleStarting(
  task: string,
  events: readonly TadeEvent[],
  since: number,
): string | null {
  let because: string | null = null
  for (const event of events) {
    if (event.task !== task || event.seq <= since) continue
    if (event.type === 'queue_held' && event.detail.start === 'failed') {
      because =
        typeof event.detail.because === 'string' ? event.detail.because : 'it could not start'
    }
  }
  return because
}

/**
 * Whether a hold was already said since anyone last answered it: said once, a
 * hold waits for an answer, and asking again every refresh is nagging.
 *
 * A hold on what the tree says is matched by being one, not by its words: the
 * files being changed under queued work change from one look to the next, and
 * a sentence that grows a filename is not news worth waking anybody for.
 */
export function holdSaid(
  task: string,
  held: { because: string; changed?: readonly string[] },
  events: readonly TadeEvent[],
): boolean {
  let said = false
  for (const event of events) {
    if (event.task !== task) continue
    const change = event.detail.change
    if (
      event.type === 'queue_changed' &&
      (change === 'start' || change === 'wait' || change === 'resume')
    ) {
      said = false
    }
    if (event.type !== 'queue_held') continue
    if (event.detail.because === held.because) said = true
    if (held.changed && Array.isArray(event.detail.changed)) said = true
  }
  return said
}

/**
 * Where one piece of queued work stands before anybody looks at the tree:
 * everything the journal and the clock say, and nothing about what other
 * agents have been doing to the files since.
 *
 * This is how the window knows which trees are worth the git calls: what this
 * says is ready is what is about to start, and only those are looked at.
 */
export function queueStanding(item: Queued, facts: QueueFacts): QueueState {
  return stateOf(item, facts, false)
}

/** Where one piece of queued work stands. */
export function queueStateOf(item: Queued, facts: QueueFacts): QueueState {
  return stateOf(item, facts, true)
}

function stateOf(item: Queued, facts: QueueFacts, tree: boolean): QueueState {
  // Parked first, above the journal and above `anyway`. Parking is the only
  // thing read here that a person told Tade rather than Tade deriving it, and
  // the only way to undo it is to pick the task up again — so it is newer
  // than any choice in the journal by construction, and there is nothing it
  // should lose to. `deriveState` orders it the same way, which is what keeps
  // the queue and the task list from giving two answers about one task.
  if (item.parked) return { kind: 'paused', all: false, parked: true }
  if (queuePaused(facts.events, item.project)) return { kind: 'paused', all: true }
  const choices = choicesFor(item.task, facts.events)
  if (choices.paused) return { kind: 'paused', all: false }
  const own = troubleStarting(item.task, facts.events, choices.answeredAt)
  if (own) return { kind: 'held', on: null, because: own }
  // Started anyway: somebody has already answered for this one, and an answer
  // is not asked twice — not for what it waits on, and not for the tree.
  if (choices.anyway) return { kind: 'ready' }
  const on: string[] = []
  for (const dep of item.start.after) {
    if (facts.finished.has(dep.task)) continue
    const trouble = troubleWith(dep.task, facts, choices.answeredAt)
    if (trouble) return { kind: 'held', on: dep.task, because: trouble }
    on.push(dep.task)
  }
  if (on.length > 0) return { kind: 'waiting', on }
  const at = item.start.at ? Date.parse(item.start.at) : Number.NaN
  if (Number.isFinite(at) && at > facts.now) return { kind: 'scheduled', at }
  if (!tree) return { kind: 'ready' }
  // Last, and only ever to hold: what the plan guessed about the code,
  // against what has actually happened to it since.
  const clash = collides(item, facts, choices.answeredAt)
  if (clash) {
    return { kind: 'held', on: null, because: clash.because, changed: clash.paths, by: clash.by }
  }
  return { kind: 'ready' }
}

/**
 * What holds queued work on the evidence: what the last look at the tree
 * found, or — where nobody has looked — what the last look wrote down and
 * nobody has answered. A hold heals on its own: the look that finds the
 * files settled says ready, so work never waits on a person for a reason
 * that has gone.
 */
function collides(item: Queued, facts: QueueFacts, since: number): Collision | null {
  const seen = facts.reality?.get(item.project)
  if (seen) return collidesNow(item, seen)
  return writtenCollision(item.task, facts.events, since)
}

/**
 * Where what queued work says it touches meets what agents at work have
 * actually changed. `touches` is a reading of the code somebody made when the
 * work was planned; this is the same files an hour later, and the difference
 * is the whole point.
 *
 * Only in a shared checkout: with a worktree each, nothing is being changed
 * under anybody, and what two branches do to one file is a merge — which was
 * said when the plan was checked, and is not a reason to hold a start.
 */
export function collidesNow(item: Queued, seen: Reality): Collision | null {
  if (seen.workspace !== 'checkout') return null
  // Work that said nothing about what it would change cannot be checked
  // against the tree, and holding everything that said nothing would stop the
  // queue rather than guard it.
  if (item.start.touches.length === 0) return null
  const others = seen.working.filter((task) => task !== item.task)
  if (others.length === 0) return null
  // What it waits on is what it builds on: those changes are the reason it is
  // starting at all.
  const waits = new Set(item.start.after.map((dep) => dep.task))
  const shares = (theirs: readonly string[]) =>
    item.start.touches.filter((path) => theirs.some((other) => sameOrInside(path, other)))
  const paths = new Set<string>()
  const by: string[] = []
  const said: string[] = []
  for (const one of seen.committed) {
    if (one.task === item.task || waits.has(one.task)) continue
    const shared = shares(one.paths)
    if (shared.length === 0) continue
    for (const path of shared) paths.add(path)
    by.push(one.task)
    said.push(
      `${one.task}, which is working, has already changed ${joined(shared)}, which this was planned to change`,
    )
  }
  // Nobody's name is on an uncommitted change — git does not say whose it is,
  // and Tade does not guess. What it says instead is true: the file is being
  // changed now, and these are the agents in the same checkout.
  const loose = shares(seen.dirty).filter((path) => !paths.has(path))
  if (loose.length > 0) {
    for (const path of loose) paths.add(path)
    said.push(
      `${joined(loose)}, which this was planned to change, ${loose.length === 1 ? 'is' : 'are'} changed and not committed, while ${joined(others)} ${others.length === 1 ? 'works' : 'work'} in the same checkout`,
    )
  }
  if (said.length === 0) return null
  return { paths: [...paths].sort(), by, because: said.join('; ') }
}

/** The last hold written about the tree and not answered since. */
function writtenCollision(
  task: string,
  events: readonly TadeEvent[],
  since: number,
): Collision | null {
  let found: Collision | null = null
  for (const event of events) {
    if (event.task !== task || event.seq <= since) continue
    if (event.type !== 'queue_held' || !Array.isArray(event.detail.changed)) continue
    found = {
      paths: event.detail.changed.map(String),
      by: Array.isArray(event.detail.by) ? event.detail.by.map(String) : [],
      because:
        typeof event.detail.because === 'string'
          ? event.detail.because
          : 'the code it was planned against has changed since',
    }
  }
  return found
}

/**
 * What to start now, in the order given: whatever is ready, as far as each
 * project has room. `room` is how many more agents a project may run; one it
 * does not name has no limit.
 *
 * Evidence reaches this the only way it may: through `queueStateOf`, which
 * holds work the tree has moved under. Held work is not ready, so it never
 * takes a slot from work behind it — and nothing the rule would not have
 * started can be started by anything anybody looked at.
 */
export function readyToStart(
  items: readonly Queued[],
  facts: QueueFacts,
  room: ReadonlyMap<string, number>,
): string[] {
  const left = new Map(room)
  const out: string[] = []
  for (const item of items) {
    if (queueStateOf(item, facts).kind !== 'ready') continue
    const free = left.get(item.project)
    if (free !== undefined) {
      if (free <= 0) continue
      left.set(item.project, free - 1)
    }
    out.push(item.task)
  }
  return out
}

/** What queued work in a worktree begins from, per task it waited on. */
export interface Upstream {
  workspace: 'checkout' | 'worktree'
  /** Its branch, or empty when it has none. */
  branch: string
  head: string | null
  done: DoneRule
}

/**
 * Where queued work in a worktree begins: on top of what it waited on, so it
 * has that work to build on — unless that finished by being merged, in which
 * case the base has it and the base is where to begin. With nothing to build
 * on it begins from the base as it is now, not as it was when it was planned.
 *
 * **Only ever inside one repository.** The upstream map is flat across every
 * project, because a wait is, so without `project` a task in `sentry-cli`
 * waiting on one in `sentry` was handed `sentry`'s branch name to start from —
 * which fails in the good case and in the bad one finds a ref of that name
 * that is somebody else's work entirely. A cross-repo wait is a wait on when,
 * not on what: the other repository's commits are not this one's to build on,
 * so this begins from its own base exactly as it would with no wait at all.
 */
export function startFrom(
  after: readonly { task: string }[],
  upstream: ReadonlyMap<string, Upstream>,
  baseRef: string | null,
  /** The project the work is starting in. Required: a silent default here is
   * a ref handed to the wrong repository, which is the failure this exists for. */
  project: string,
): string[] {
  const refs: string[] = []
  for (const dep of after) {
    if (!dep.task.startsWith(`${project}/`)) continue
    const found = upstream.get(dep.task)
    if (found?.workspace !== 'worktree' || found.done === 'merged') continue
    const ref = found.branch || found.head
    if (ref && !refs.includes(ref)) refs.push(ref)
  }
  return refs.length > 0 ? refs : baseRef ? [baseRef] : []
}

/** Whether two paths are the same, or one is a folder the other is in. */
export function sameOrInside(a: string, b: string): boolean {
  const clean = (path: string) => path.replace(/^\.\//, '').replace(/\/+$/, '')
  const x = clean(a)
  const y = clean(b)
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

/** `a`, `a and b`, `a, b and c`. */
export function joined(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** Where queued work stands, in a few words. */
export function describeQueueState(state: QueueState, clock: (at: number) => string): string {
  switch (state.kind) {
    case 'waiting':
      return `after ${joined(state.on)}`
    case 'held':
      return `held: ${state.because}`
    case 'scheduled':
      return `at ${clock(state.at)}`
    case 'paused':
      if (state.parked) return 'parked'
      return state.all ? 'paused with the queue' : 'paused'
    case 'ready':
      return 'next'
  }
}

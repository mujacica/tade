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
  /** Paused, on its own or with everything else in its project. */
  | { kind: 'paused'; all: boolean }
  /** It can start, and does as soon as its project has room. */
  | { kind: 'ready' }

/** What a person can do to queued work. */
export const QUEUE_CHANGES = ['pause', 'resume', 'start', 'wait', 'order'] as const
export type QueueChange = (typeof QUEUE_CHANGES)[number]

interface Choices {
  paused: boolean
  /** Started anyway, whatever it waits on. */
  anyway: boolean
  /** Where the last choice was made: trouble before it has been answered. */
  answeredAt: number
}

function choicesFor(task: string, events: readonly TadeEvent[]): Choices {
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

/** Why a task's own start failed, since anyone last answered it. */
function ownTrouble(task: string, events: readonly TadeEvent[], since: number): string | null {
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
  if (queuePaused(facts.events, item.project)) return { kind: 'paused', all: true }
  const choices = choicesFor(item.task, facts.events)
  if (choices.paused) return { kind: 'paused', all: false }
  const own = ownTrouble(item.task, facts.events, choices.answeredAt)
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

/** One agent in a plan, as the orchestrator gives it. */
export interface PlannedAgent {
  /** Its task's name: lowercase, dashes. */
  name: string
  /**
   * The repository this one works in; the plan's own project when unsaid, so
   * every plan written before a plan could span repositories means what it
   * meant. A change that touches three repos is three agents naming three
   * projects, and each is an ordinary task in an ordinary repository.
   */
  project?: string
  /** The words of the request this agent covers, verbatim. */
  said: string
  /** What its agent is told first. */
  prompt: string
  done?: DoneRule
  /**
   * The document it writes rather than a change to the code, named in its own
   * task's folder: how an agent sent to plan, audit or research says so.
   */
  produces?: string
  /** Other agents in the plan, or tasks already there, it waits on — with why. */
  after: { agent: string; why: string }[]
  touches: string[]
  at?: string
  model?: string
  thinking?: string
}

export interface Plan {
  /** Where its agents work unless one says otherwise. */
  project: string
  /** The whole request, verbatim. */
  said: string
  /**
   * What to call the change all of this is: a slug, when the work is one
   * change rather than several. Every task it makes carries it, and the
   * effort is the fold of the task files that name it — there is no table.
   * Without one the plan behaves exactly as it always has and makes none.
   */
  effort?: string
  agents: PlannedAgent[]
}

/** Which repository an agent in this plan works in. */
export function projectOf(plan: { project: string }, agent: { project?: string }): string {
  return agent.project || plan.project
}

/** Every repository a plan reaches into, the plan's own first. */
export function projectsIn(plan: Plan): string[] {
  const out = [plan.project]
  for (const agent of plan.agents) {
    const project = projectOf(plan, agent)
    if (!out.includes(project)) out.push(project)
  }
  return out
}

export type PlanCheck =
  | {
      ok: true
      /** Every agent after everything it waits on. */
      order: PlannedAgent[]
      /** Each `after` as the task id it names, by the waiting agent's own task id. */
      waitsOn: ReadonlyMap<string, { task: string; why: string }[]>
      warnings: string[]
    }
  | { ok: false; problems: string[] }

const NAME = /^[a-z0-9][a-z0-9._-]*$/

/** Work the project already has that a plan cannot see, and what it will change. */
export interface PlanBusy {
  task: string
  /** What it is doing, in a word or two: `working`, `queued`. */
  said: string
  touches: readonly string[]
}

/** What a plan is checked against: how each project works, and what is already there. */
export interface PlanContext {
  /**
   * Where a project's agents work, asked per project rather than given once:
   * with a plan spanning repositories the answer differs between two agents
   * in one plan, and `done: committed` and `done: merged` turn on it.
   */
  workspace: (project: string) => 'checkout' | 'worktree'
  /**
   * Every task Tade has, in every project, so a wait on one of them is a wait
   * Tade can keep. Qualified ids, which is what lets a task in one repository
   * wait on a task in another.
   */
  tasks: ReadonlySet<string>
  /** Work already going or waiting to go: a plan can collide with that too. */
  busy?: readonly PlanBusy[]
}

/**
 * Whether a plan can be kept, and in what order its tasks are made. Refused
 * whole rather than half made: a plan with a cycle in it, or a wait on
 * something that does not exist, would leave work waiting for ever.
 */
export function checkPlan(plan: Plan, context: PlanContext): PlanCheck {
  const problems: string[] = []
  const names = new Set<string>()
  if (plan.agents.length === 0) problems.push('a plan needs at least one agent')
  if (plan.effort !== undefined && !NAME.test(plan.effort)) {
    problems.push(`"${plan.effort}" is not a name for the change: lowercase letters, digits, - . _`)
  }
  // An agent's id is its own project's, so two agents may share a name only
  // when they are in different repositories — which is the ordinary shape of
  // one change landing in three of them under one name.
  const idOf = (agent: PlannedAgent) => `${projectOf(plan, agent)}/${agent.name}`
  for (const agent of plan.agents) {
    if (!NAME.test(agent.name)) {
      problems.push(`"${agent.name}" is not a task name: lowercase letters, digits, - . _`)
    }
    const id = idOf(agent)
    if (names.has(id)) problems.push(`${id} is in the plan twice`)
    names.add(id)
    const project = projectOf(plan, agent)
    if (
      (agent.done === 'committed' || agent.done === 'merged') &&
      context.workspace(project) !== 'worktree'
    ) {
      problems.push(
        `${agent.name} cannot finish when ${agent.done}: agents in ${project} share one checkout. Use said, idle or manual`,
      )
    }
    if (agent.at !== undefined && Number.isNaN(Date.parse(agent.at))) {
      problems.push(`${agent.name} starts at "${agent.at}", which is not a time`)
    }
    const produces = agent.produces === undefined ? null : producesProblem(agent.produces)
    if (produces) problems.push(`${agent.name} cannot produce that: ${produces}`)
  }

  const byName = new Map<string, PlannedAgent[]>()
  for (const agent of plan.agents) {
    byName.set(agent.name, [...(byName.get(agent.name) ?? []), agent])
  }
  const inPlan = new Set(plan.agents.map(idOf))
  const waitsOn = new Map<string, { task: string; why: string }[]>()
  for (const agent of plan.agents) {
    const here = projectOf(plan, agent)
    const mine = idOf(agent)
    const deps: { task: string; why: string }[] = []
    for (const dep of agent.after) {
      const task = named(dep.agent)
      if (task === undefined) continue
      if (!task) {
        problems.push(
          `${agent.name} waits on ${dep.agent}, which is neither in the plan nor a task Tade has`,
        )
        continue
      }
      if (task === mine) {
        problems.push(`${agent.name} cannot wait on itself`)
        continue
      }
      deps.push({ task, why: dep.why })
    }
    waitsOn.set(mine, deps)

    /**
     * The task one `after` entry names, null for nothing of that name, and
     * undefined where the problem is already written down.
     *
     * A qualified id points at exactly one thing wherever it is — an agent in
     * this plan or a task Tade already has — which is what a wait across
     * repositories is written as, and what tells two agents of one name apart.
     * A bare name is read in the waiting agent's own repository first, so a
     * plan naming one agent per repo means what it looks like it means; where
     * it could still mean two, it is refused rather than resolved by luck.
     */
    function named(said: string): string | null | undefined {
      if (said.includes('/')) return inPlan.has(said) || context.tasks.has(said) ? said : null
      const siblings = (byName.get(said) ?? []).filter((one) => one !== agent)
      const own = siblings.filter((one) => projectOf(plan, one) === here)
      const chosen = own.length > 0 ? own : siblings
      if (chosen.length > 1) {
        problems.push(
          `${agent.name} waits on ${said}, which is in ${joined(chosen.map((one) => projectOf(plan, one)))}: say which as ${projectOf(plan, chosen[0] as PlannedAgent)}/${said}`,
        )
        return undefined
      }
      if (chosen[0]) return idOf(chosen[0])
      return context.tasks.has(`${here}/${said}`) ? `${here}/${said}` : null
    }
  }
  if (problems.length > 0) return { ok: false, problems }

  // In the order given, each as soon as what it waits on inside the plan is placed.
  const order: PlannedAgent[] = []
  const placed = new Set<string>()
  const waitedOnHere = (id: string) =>
    (waitsOn.get(id) ?? []).map((dep) => dep.task).filter((task) => inPlan.has(task))
  while (order.length < plan.agents.length) {
    const next = plan.agents.find(
      (agent) =>
        !placed.has(idOf(agent)) && waitedOnHere(idOf(agent)).every((task) => placed.has(task)),
    )
    if (!next) {
      const stuck = plan.agents.filter((agent) => !placed.has(idOf(agent))).map(idOf)
      return { ok: false, problems: [`${joined(stuck)} wait on each other, so none could start`] }
    }
    order.push(next)
    placed.add(idOf(next))
  }

  return { ok: true, order, waitsOn, warnings: overlaps(plan, waitsOn, context) }
}

/**
 * Agents that may run at the same time and expect to change the same things.
 * Said, not refused: what an agent will touch is a reading of the code, and
 * the orchestrator may know better. In a shared checkout it is two agents in
 * one file at once; in worktrees it is a merge that may conflict.
 */
function overlaps(
  plan: Plan,
  waitsOn: ReadonlyMap<string, { task: string; why: string }[]>,
  context: PlanContext,
): string[] {
  const idOf = (agent: PlannedAgent) => `${projectOf(plan, agent)}/${agent.name}`
  /** Everything an agent waits on, directly or through what it waits on. */
  const reach = (id: string): Set<string> => {
    const seen = new Set<string>()
    const stack = [id]
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      for (const dep of waitsOn.get(current) ?? []) {
        if (seen.has(dep.task)) continue
        seen.add(dep.task)
        stack.push(dep.task)
      }
    }
    return seen
  }
  const warnings: string[] = []
  // Two files called `src/index.ts` in two repositories are not one file, so
  // paths are only ever compared inside one project. Without this the widening
  // to several repositories would make the warning lie the day it arrived.
  const shares = (mine: PlannedAgent, theirs: { project: string; touches: readonly string[] }) =>
    projectOf(plan, mine) !== theirs.project
      ? []
      : mine.touches.filter((path) => theirs.touches.some((other) => sameOrInside(path, other)))
  const said = (project: string, both: string, shared: readonly string[]) =>
    context.workspace(project) === 'checkout'
      ? `${both} change ${joined(shared)}, in one checkout`
      : `${both} change ${joined(shared)}: merging both may conflict`
  // Work the project already has is not in the plan, and nothing waits for it
  // unless the orchestrator says so: say what it will run into while it can.
  for (const one of plan.agents) {
    for (const busy of context.busy ?? []) {
      if (reach(idOf(one)).has(busy.task)) continue
      const shared = shares(one, {
        project: busy.task.split('/')[0] ?? busy.task,
        touches: busy.touches,
      })
      if (shared.length === 0) continue
      warnings.push(
        said(
          projectOf(plan, one),
          `${one.name} and ${busy.task}, which is ${busy.said}, both`,
          shared,
        ),
      )
    }
  }
  for (const [i, one] of plan.agents.entries()) {
    for (const other of plan.agents.slice(i + 1)) {
      if (reach(idOf(one)).has(idOf(other)) || reach(idOf(other)).has(idOf(one))) continue
      const shared = shares(one, { project: projectOf(plan, other), touches: other.touches })
      if (shared.length === 0) continue
      warnings.push(
        said(
          projectOf(plan, one),
          `${one.name} and ${other.name} can run at the same time and both`,
          shared,
        ),
      )
    }
  }
  return warnings
}

/** Whether two paths are the same, or one is a folder the other is in. */
function sameOrInside(a: string, b: string): boolean {
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
      return state.all ? 'paused with the queue' : 'paused'
    case 'ready':
      return 'next'
  }
}

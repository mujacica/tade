import type { Finished } from './done.ts'
import type { WilcoEvent } from './events.ts'
import type { DoneRule, StartCondition, TaskState } from './model.ts'

// Work asked for now and started later.
//
// Queued work is a task that has not started, with a start condition in its
// task file: the tasks it waits on, and the time it waits for. Whether it can
// start is a query — of what status says the tasks are, what the journal says
// has finished or gone wrong, and the clock — so Wilco acts on it by rule,
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
  events: readonly WilcoEvent[]
  now: number
}

export type QueueState =
  /** What it waits on has not finished. */
  | { kind: 'waiting'; on: string[] }
  /** Someone has to decide: what it waits on failed, stopped or went, or it could not start. */
  | { kind: 'held'; on: string | null; because: string }
  /** Not before a time. */
  | { kind: 'scheduled'; at: number }
  /** Paused, on its own or with everything else in its project. */
  | { kind: 'paused'; all: boolean }
  /** It can start, and does as soon as its project has room. */
  | { kind: 'ready' }

/** What a person can do to queued work. */
export const QUEUE_CHANGES = ['pause', 'resume', 'start', 'wait'] as const
export type QueueChange = (typeof QUEUE_CHANGES)[number]

interface Choices {
  paused: boolean
  /** Started anyway, whatever it waits on. */
  anyway: boolean
  /** Where the last choice was made: trouble before it has been answered. */
  answeredAt: number
}

function choicesFor(task: string, events: readonly WilcoEvent[]): Choices {
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
 * Whether a project's whole queue is paused: the last word on it, for that
 * project or for every project.
 */
export function queuePaused(events: readonly WilcoEvent[], project: string): boolean {
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
function ownTrouble(task: string, events: readonly WilcoEvent[], since: number): string | null {
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
 */
export function holdSaid(task: string, because: string, events: readonly WilcoEvent[]): boolean {
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
    if (event.type === 'queue_held' && event.detail.because === because) said = true
  }
  return said
}

/** Where one piece of queued work stands. */
export function queueStateOf(item: Queued, facts: QueueFacts): QueueState {
  if (queuePaused(facts.events, item.project)) return { kind: 'paused', all: true }
  const choices = choicesFor(item.task, facts.events)
  if (choices.paused) return { kind: 'paused', all: false }
  const own = ownTrouble(item.task, facts.events, choices.answeredAt)
  if (own) return { kind: 'held', on: null, because: own }
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
  return { kind: 'ready' }
}

/**
 * What to start now, in the order given: whatever is ready, as far as each
 * project has room. `room` is how many more agents a project may run; one it
 * does not name has no limit.
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
 */
export function startFrom(
  after: readonly { task: string }[],
  upstream: ReadonlyMap<string, Upstream>,
  baseRef: string | null,
): string[] {
  const refs: string[] = []
  for (const dep of after) {
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
  /** The words of the request this agent covers, verbatim. */
  said: string
  /** What its agent is told first. */
  prompt: string
  done?: DoneRule
  /** Other agents in the plan, or tasks already in the project, it waits on — with why. */
  after: { agent: string; why: string }[]
  touches: string[]
  at?: string
  model?: string
  thinking?: string
}

export interface Plan {
  project: string
  /** The whole request, verbatim. */
  said: string
  agents: PlannedAgent[]
}

export type PlanCheck =
  | {
      ok: true
      /** Every agent after everything it waits on. */
      order: PlannedAgent[]
      /** Each `after` as the task id it names. */
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

/** What a plan is checked against: how the project works, and what is already there. */
export interface PlanContext {
  workspace: 'checkout' | 'worktree'
  /** Every task the project has, so a wait on one of them is a wait Wilco can keep. */
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
  for (const agent of plan.agents) {
    if (!NAME.test(agent.name)) {
      problems.push(`"${agent.name}" is not a task name: lowercase letters, digits, - . _`)
    }
    if (names.has(agent.name)) problems.push(`${agent.name} is in the plan twice`)
    names.add(agent.name)
    if (
      (agent.done === 'committed' || agent.done === 'merged') &&
      context.workspace !== 'worktree'
    ) {
      problems.push(
        `${agent.name} cannot finish when ${agent.done}: agents in ${plan.project} share one checkout. Use said, idle or manual`,
      )
    }
    if (agent.at !== undefined && Number.isNaN(Date.parse(agent.at))) {
      problems.push(`${agent.name} starts at "${agent.at}", which is not a time`)
    }
  }

  const idOf = (name: string) => `${plan.project}/${name}`
  const waitsOn = new Map<string, { task: string; why: string }[]>()
  for (const agent of plan.agents) {
    const deps: { task: string; why: string }[] = []
    for (const dep of agent.after) {
      if (dep.agent === agent.name) {
        problems.push(`${agent.name} cannot wait on itself`)
        continue
      }
      const task = names.has(dep.agent)
        ? idOf(dep.agent)
        : context.tasks.has(dep.agent)
          ? dep.agent
          : context.tasks.has(idOf(dep.agent))
            ? idOf(dep.agent)
            : null
      if (!task) {
        problems.push(
          `${agent.name} waits on ${dep.agent}, which is neither in the plan nor a task in ${plan.project}`,
        )
        continue
      }
      deps.push({ task, why: dep.why })
    }
    waitsOn.set(agent.name, deps)
  }
  if (problems.length > 0) return { ok: false, problems }

  // In the order given, each as soon as what it waits on inside the plan is placed.
  const order: PlannedAgent[] = []
  const placed = new Set<string>()
  const planned = new Set(plan.agents.map((agent) => idOf(agent.name)))
  const inPlan = (name: string) =>
    (waitsOn.get(name) ?? []).map((dep) => dep.task).filter((task) => planned.has(task))
  while (order.length < plan.agents.length) {
    const next = plan.agents.find(
      (agent) =>
        !placed.has(idOf(agent.name)) && inPlan(agent.name).every((task) => placed.has(task)),
    )
    if (!next) {
      const stuck = plan.agents.filter((agent) => !placed.has(idOf(agent.name))).map((a) => a.name)
      return { ok: false, problems: [`${joined(stuck)} wait on each other, so none could start`] }
    }
    order.push(next)
    placed.add(idOf(next.name))
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
  const workspace = context.workspace
  const id = (name: string) => `${plan.project}/${name}`
  /** Everything an agent waits on, directly or through what it waits on. */
  const reach = (name: string): Set<string> => {
    const seen = new Set<string>()
    const stack = [name]
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      for (const dep of waitsOn.get(current) ?? []) {
        if (seen.has(dep.task)) continue
        seen.add(dep.task)
        if (dep.task.startsWith(`${plan.project}/`)) {
          stack.push(dep.task.slice(plan.project.length + 1))
        }
      }
    }
    return seen
  }
  const warnings: string[] = []
  const shares = (mine: readonly string[], theirs: readonly string[]) =>
    mine.filter((path) => theirs.some((other) => sameOrInside(path, other)))
  // Work the project already has is not in the plan, and nothing waits for it
  // unless the orchestrator says so: say what it will run into while it can.
  for (const one of plan.agents) {
    for (const busy of context.busy ?? []) {
      if (reach(one.name).has(busy.task)) continue
      const shared = shares(one.touches, busy.touches)
      if (shared.length === 0) continue
      warnings.push(
        workspace === 'checkout'
          ? `${one.name} and ${busy.task}, which is ${busy.said}, both change ${joined(shared)}, in one checkout`
          : `${one.name} and ${busy.task}, which is ${busy.said}, both change ${joined(shared)}: merging both may conflict`,
      )
    }
  }
  for (const [i, one] of plan.agents.entries()) {
    for (const other of plan.agents.slice(i + 1)) {
      if (reach(one.name).has(id(other.name)) || reach(other.name).has(id(one.name))) continue
      const shared = shares(one.touches, other.touches)
      if (shared.length === 0) continue
      warnings.push(
        workspace === 'checkout'
          ? `${one.name} and ${other.name} can run at the same time and both change ${joined(shared)}, in one checkout`
          : `${one.name} and ${other.name} can run at the same time and both change ${joined(shared)}: merging both may conflict`,
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

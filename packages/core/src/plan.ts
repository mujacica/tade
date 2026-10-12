import type { DoneRule } from './model.ts'
import { producesProblem } from './produces.ts'
import { joined } from './queue.ts'

// A plan: several agents, each one repository's share of one change, and
// whether the shape of it holds together before any of it is made.
//
// Split out of `queue.ts`, which is where a plan's tasks end up and which had
// grown to hold both subjects. The line between them is that this file is
// about work that does not exist yet — names, waits, repositories, what each
// says it will touch — and `queue.ts` is about where work that does exist
// stands. Nothing here reads the journal or the clock.
//
// "Plan" means this and not a subscription. The other sense — what a plan
// window was used up by, and what it would have cost at list — is `limits.ts`,
// and the two never meet.
//
// Pure: facts in, answers out.

/** One agent in a plan, as the orchestrator gives it. */
export interface PlannedAgent {
  /** Its task's name: lowercase, dashes. */
  name: string
  /**
   * The repository this one works in; the plan's own project when unsaid, so
   * every plan written before a plan could span repositories means what it
   * meant. A change that touches three repos is three agents naming three
   * projects, and each is an ordinary task in an ordinary repository. In a
   * plan that reaches into more than one, every agent has to say: `checkPlan`
   * refuses the plan rather than let the default route work to the wrong repo.
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
  /**
   * What it needs to know before it starts, written beside its task file and
   * read first — the same field `tade_task_create` takes.
   *
   * Separate from `prompt` on purpose and it is the whole of what keeps a
   * prompt governing: everything derived, quoted or filled in goes here, where
   * it is material an agent reads, and a prompt stays the words somebody wrote.
   * A template is the one caller so far (`fillTemplate`), and it is why this
   * exists: a plan stamped out of a stored shape has a ticket body, a handed
   * document and a filled-in value to pass on, and none of the three may be
   * joined into the instruction.
   */
  context?: string
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
  /**
   * The tasks it waits on, by qualified id: an agent that waits on this waits
   * on all of them too. Without it the walk stopped at the plan's edge, and an
   * agent six waits down a queued chain was warned about every task in it.
   */
  after?: readonly string[]
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
  /**
   * Work already going or waiting to go: a plan can collide with that too.
   * Never work that has finished — what it did is committed and the base, or
   * nobody's uncommitted file, which the look before starting already holds on.
   */
  busy?: readonly PlanBusy[]
  /**
   * The folders in a project that are a package of their own — a manifest is
   * in them — relative to its root, as whoever could look at the tree found
   * them. Unsaid, the repository's root is the only package there is.
   */
  packages?: (project: string) => readonly string[]
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
  // Inheriting the plan's project is right where there is one answer and
  // silently wrong the moment one agent names another repository: twice that
  // put work in the wrong repo, and a task in the wrong project looks exactly
  // like one somebody meant to put there. So it is refused, naming who said
  // nothing (`change-the-queue`).
  const inherit = plan.agents.filter((agent) => !agent.project)
  if (
    inherit.length > 0 &&
    plan.agents.some((agent) => agent.project && agent.project !== plan.project)
  ) {
    problems.push(
      `this plan spans ${joined(projectsIn(plan))}, so every agent has to say which project it works in: ${joined(inherit.map((one) => one.name))} ${inherit.length === 1 ? 'does' : 'do'} not, and would be put in ${plan.project}`,
    )
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

  return {
    ok: true,
    order,
    waitsOn,
    warnings: [...wholePackages(plan, context), ...overlaps(plan, waitsOn, context)],
  }
}

/**
 * Whether a `touches` entry is a whole package or more: the repository, a
 * folder a manifest is in, that folder's `src` or `lib`, or a folder with a
 * package inside it. `packages` is what the caller found, relative to the
 * repository's root.
 */
export function wholePackage(path: string, packages: readonly string[]): boolean {
  const clean = (one: string) => one.replace(/^\.(\/|$)/, '').replace(/\/+$/, '')
  const folder = clean(path)
  if (folder === '') return true
  const above = folder.replace(/(^|\/)(src|lib)$/, '')
  return packages
    .map(clean)
    .some((one) => one === folder || one === above || one.startsWith(`${folder}/`))
}

/**
 * An agent that says it will touch a whole package collides with every agent
 * in it: on 2026-10-11 three tasks that said `packages/app`, `packages/app/src`
 * or `packages/core/src` were 21 of one later plan's 44 warnings, and in a
 * shared checkout any file changed anywhere under one holds its start.
 */
function wholePackages(plan: Plan, context: PlanContext): string[] {
  const out: string[] = []
  for (const agent of plan.agents) {
    const project = projectOf(plan, agent)
    const packages = context.packages?.(project) ?? []
    const wide = agent.touches.filter((path) => wholePackage(path, packages))
    if (wide.length === 0) continue
    const them = wide.length === 1 ? 'it' : 'them'
    out.push(
      `${agent.name} says it touches all of ${joined(wide)}, ${wide.length === 1 ? 'a whole package' : 'whole packages'}: ${
        context.workspace(project) === 'checkout'
          ? `anything uncommitted in ${them} holds its start, and every agent in ${them} collides with it`
          : `every agent in ${them} collides with it`
      }. Name the files it will change instead`,
    )
  }
  return out
}

/**
 * Agents that may run at the same time and expect to change the same things.
 * Said, not refused: what an agent will touch is a reading of the code, and
 * the orchestrator may know better. In a shared checkout it is two agents in
 * one file at once; in worktrees it is a merge that may conflict.
 *
 * One line for each task run into, however many of the plan's agents run into
 * it: the first pair in full, then how many more and which. A line for every
 * pair was 44 lines of one shape on 2026-10-11, none of them real, and a real
 * one would have been lost among them the same way.
 */
function overlaps(
  plan: Plan,
  waitsOn: ReadonlyMap<string, { task: string; why: string }[]>,
  context: PlanContext,
): string[] {
  const idOf = (agent: PlannedAgent) => `${projectOf(plan, agent)}/${agent.name}`
  // Every wait there is — the plan's own and those of the work already there —
  // so an agent is never warned about what it already waits on through a
  // chain of queued work, which no plan can see the end of.
  const waits = new Map<string, readonly string[]>()
  for (const busy of context.busy ?? []) waits.set(busy.task, busy.after ?? [])
  for (const [id, deps] of waitsOn) {
    waits.set(
      id,
      deps.map((dep) => dep.task),
    )
  }
  /** Everything an agent waits on, directly or through what it waits on. */
  const reach = (id: string): Set<string> => {
    const seen = new Set<string>()
    const stack = [id]
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      for (const task of waits.get(current) ?? []) {
        if (seen.has(task)) continue
        seen.add(task)
        stack.push(task)
      }
    }
    return seen
  }
  const reached = new Map(plan.agents.map((agent) => [idOf(agent), reach(idOf(agent))]))
  const waitsFor = (one: string, other: string) => reached.get(one)?.has(other) === true
  const where = (project: string) =>
    context.workspace(project) === 'checkout' ? ', in one checkout' : ': merging both may conflict'

  /** By the task run into, in the order first met: its first pair, and who else. */
  const into = new Map<string, { name: string; first: string; also: string[] }>()
  const meet = (key: string, name: string, one: PlannedAgent, line: string | null) => {
    if (line === null) return
    const met = into.get(key)
    if (met) met.also.push(one.name)
    else into.set(key, { name, first: line, also: [] })
  }
  for (const one of plan.agents) {
    const project = projectOf(plan, one)
    // Work the project already has is not in the plan, and nothing waits for it
    // unless the orchestrator says so: say what it will run into while it can.
    // Two files called `src/index.ts` in two repositories are not one file, so
    // paths are only ever compared inside one project.
    for (const busy of context.busy ?? []) {
      if (waitsFor(idOf(one), busy.task) || (busy.task.split('/')[0] ?? busy.task) !== project) {
        continue
      }
      const shared = sharedSays(one, { name: busy.task, touches: busy.touches })
      meet(
        busy.task,
        busy.task,
        one,
        shared && `${one.name} and ${busy.task}, which is ${busy.said}, ${shared}${where(project)}`,
      )
    }
  }
  for (const [i, one] of plan.agents.entries()) {
    for (const other of plan.agents.slice(i + 1)) {
      if (projectOf(plan, other) !== projectOf(plan, one)) continue
      if (waitsFor(idOf(one), idOf(other)) || waitsFor(idOf(other), idOf(one))) continue
      const shared = sharedSays(one, other)
      meet(
        idOf(other),
        other.name,
        one,
        shared &&
          `${one.name} and ${other.name} can run at the same time and ${shared}${where(projectOf(plan, one))}`,
      )
    }
  }
  return [...into.values()].map(({ name, first, also }) => {
    if (also.length === 0) return first
    return also.length === 1
      ? `${first}; ${also[0]} runs into ${name} too`
      : `${first}; ${also.length} more of this plan's agents run into ${name} too: ${joined(also)}`
  })
}

/**
 * What two agents' `touches` share, in words, or null for nothing. A path both
 * name is said as itself; a folder one of them names whole is said once, as a
 * folder, rather than as every file of the other's it swallows.
 */
function sharedSays(
  mine: { name: string; touches: readonly string[] },
  theirs: { name: string; touches: readonly string[] },
): string | null {
  const clean = (path: string) => path.replace(/^\.\//, '').replace(/\/+$/, '')
  const inside = (path: string, folder: string) => clean(path).startsWith(`${clean(folder)}/`)
  const items: string[] = []
  const say = (item: string) => {
    if (!items.includes(item)) items.push(item)
  }
  for (const path of mine.touches) {
    const folder = theirs.touches.find((other) => inside(path, other))
    if (theirs.touches.some((other) => clean(other) === clean(path))) say(path)
    else if (folder !== undefined) say(`${folder} (${theirs.name} said it touches all of it)`)
    else if (theirs.touches.some((other) => inside(other, path))) {
      say(`${path} (${mine.name} said it touches all of it)`)
    }
  }
  return items.length === 0 ? null : `both change ${joined(items)}`
}

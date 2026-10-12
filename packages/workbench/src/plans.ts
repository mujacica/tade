import {
  type Config,
  checkPlan,
  type EventFilter,
  joined,
  type Plan,
  type PlanBusy,
  type PlannedAgent,
  projectOf,
  projectsIn,
  type TadeEvent,
  workspaceFor,
} from '@tade/core'
import { sameConversation, type TaskWorktree } from './tasks.ts'
import type { CreateTaskRequest } from './workbench.ts'

// Making a plan's tasks: the one place a change that spans repositories turns
// into ordinary tasks in ordinary repositories.
//
// Its own file because it is its own subject, and because everything it does
// is about several projects at once while the workbench around it is about one
// thing at a time: which repositories the plan reaches into, whether Tade has
// them all, every task in every project so a wait can cross one, every name a
// task has ever had, and the effort's sentence written down once everything
// that can refuse the plan has had its say.

/** What a plan made: its tasks, in the order they were made, and what to watch out for. */
export interface PlanMade {
  made: TaskWorktree[]
  warnings: string[]
}

/** What making a plan needs of the workbench, and nothing else. */
export interface PlanDeps {
  config: Config
  /** The journal, for what tasks Tade has and has had, and what each effort was called. */
  events(filter: EventFilter): Promise<readonly TadeEvent[]>
  /** Write a line down: the effort's name and sentence. */
  note(event: { type: 'effort_named'; detail: Record<string, unknown> }): Promise<void>
  createTask(req: CreateTaskRequest): Promise<TaskWorktree>
  resolveModel(said: string): Promise<{ provider: string; id: string }>
  /**
   * Each harness's own answer for what conversation a task name makes — what
   * `guardName` asks of one name — so a plan whose `a.b` would carry on the
   * `a-b` somebody removed is refused before anything is made.
   */
  keyOf: readonly ((id: string) => string)[]
}

/** One planned agent's task id: its own project's, which may not be the plan's. */
export function agentId(plan: Plan, agent: { name: string; project?: string }): string {
  return `${projectOf(plan, agent)}/${agent.name}`
}

/**
 * Make every task in a plan, in an order where each comes after what it waits
 * on — or none of them, with every reason, when the plan cannot be kept. Making
 * is not starting: the queue starts whatever is ready.
 */
export async function makePlan(
  deps: PlanDeps,
  plan: Plan,
  by = 'orchestrator',
  /** Work the projects already have, so the plan is checked against it too. */
  busy: readonly PlanBusy[] = [],
): Promise<PlanMade> {
  // Every repository it reaches into, not just the plan's own: a change that
  // spans three repos is refused whole if one of them is not a project here,
  // naming it, rather than half made and stuck.
  const unknown = projectsIn(plan).filter((name) => !deps.config.projects[name])
  if (unknown.length > 0) {
    throw new Error(
      `unknown project${unknown.length > 1 ? 's' : ''} "${unknown.join('", "')}": add to config.yaml first`,
    )
  }
  const journal = await deps
    .events({ types: ['task_created', 'task_removed', 'effort_named'] })
    .catch(() => [])
  // Every task Tade has, in every project. The ids are already qualified, so
  // widening this is the whole of what lets a task in one repository wait on a
  // task in another — `checkPlan` resolves them exactly as it always did.
  const tasks = new Set<string>()
  // And every name a task has ever had, which a removed one keeps for good.
  const used: string[] = []
  let named: unknown
  for (const event of journal) {
    if (event.type === 'effort_named' && event.detail.effort === plan.effort) {
      named = event.detail.intent_spoken
    }
    if (!event.task) continue
    if (event.type === 'task_created') {
      tasks.add(event.task)
      used.push(event.task)
    } else if (event.type === 'task_removed') tasks.delete(event.task)
  }
  const check = checkPlan(plan, {
    workspace: (project) => workspaceFor(deps.config, project),
    tasks,
    busy,
  })
  // Every reason in one answer, names included: asked one task at a time as
  // each was made, a plan made its first task and then threw on its second,
  // and the next attempt was refused over the task that one had left behind.
  const taken = namesTaken(deps.keyOf, plan, used, tasks)
  if (!check.ok || taken) {
    const problems = [...(check.ok ? [] : check.problems), ...(taken ? [taken] : [])]
    throw new Error(`the plan was not made: ${problems.join('; ')}`)
  }
  // Every model named for the work settled first: a plan that starts half its
  // agents and then cannot tell which model the rest meant is a mess to undo.
  const models = new Map<string, { provider: string; id: string }>()
  for (const agent of check.order) {
    if (agent.model) models.set(agentId(plan, agent), await deps.resolveModel(agent.model))
  }
  // Written once nothing is left that could refuse the plan, before the tasks,
  // and only when the sentence is new: it is the only thing an effort has that
  // nothing else can recover once its task files are gone, and written by every
  // attempt it said one effort four times over.
  if (plan.effort && named !== plan.said) {
    await deps.note({
      type: 'effort_named',
      detail: {
        effort: plan.effort,
        projects: projectsIn(plan),
        intent_spoken: plan.said,
        by,
      },
    })
  }
  const made: TaskWorktree[] = []
  for (const agent of check.order) {
    const model = models.get(agentId(plan, agent))
    try {
      made.push(
        await deps.createTask({
          project: projectOf(plan, agent),
          slug: agent.name,
          intent: agent.said,
          by,
          ...(plan.effort ? { effort: plan.effort } : {}),
          ...(agent.done ? { done: agent.done } : {}),
          ...(agent.produces ? { produces: agent.produces } : {}),
          // Written beside the task file for its agent to read first, exactly
          // as a task made one at a time gets it. A plan that carries one is a
          // plan stamped out of something stored, and this is where everything
          // it filled in goes — never into the prompt above.
          ...(agent.context ? { context: agent.context } : {}),
          start: {
            after: check.waitsOn.get(agentId(plan, agent)) ?? [],
            prompt: agent.prompt,
            touches: agent.touches,
            ...(agent.at ? { at: new Date(Date.parse(agent.at)).toISOString() } : {}),
            ...(model ? { model } : {}),
            ...(agent.thinking ? { thinking: agent.thinking } : {}),
          },
        }),
      )
    } catch (err) {
      throw new Error(stoppedAt(plan, check.order, made, err))
    }
  }
  return { made, warnings: check.warnings }
}

/**
 * The plan's agents whose names cannot be used — a task's name, ever, or one
 * that would carry on its conversation in some harness, or another agent's in
 * this plan — in one sentence, with a free name for each. The rule is
 * `guardName`'s, asked of the whole plan before anything is made. A free name
 * is the agent's own with a number, the way schedules number theirs, and only
 * a suggestion.
 */
function namesTaken(
  keyOf: PlanDeps['keyOf'],
  plan: Plan,
  used: readonly string[],
  tasks: ReadonlySet<string>,
): string | undefined {
  const ids = plan.agents.map((agent) => agentId(plan, agent))
  // What no name may be, a free one included: every task's, and every agent's here.
  const taken = [...used, ...ids]
  const said: string[] = []
  const free: string[] = []
  plan.agents.forEach((agent, n) => {
    const id = agentId(plan, agent)
    // The same name twice in a plan is `checkPlan`'s to say.
    const earlier = ids.slice(0, n).filter((other) => other !== id)
    const clash = sameConversation(keyOf, used, id) ?? sameConversation(keyOf, earlier, id)
    if (!clash) return
    said.push(
      clash !== id
        ? `${id} would carry on ${clash}'s conversation`
        : tasks.has(id)
          ? `${id} is a task already`
          : `${id} was used before`,
    )
    for (let k = 2; k <= 50; k++) {
      const next = `${id}-${k}`
      if (sameConversation(keyOf, taken, next)) continue
      taken.push(next)
      free.push(`${agent.name}-${k}`)
      break
    }
  })
  if (said.length === 0) return undefined
  const existing = said.some((one) => one.endsWith(' is a task already'))
  return `${joined(said)}, and a task's name is never used twice: name ${said.length === 1 ? 'it' : 'them'} again${free.length > 0 ? ` (free: ${free.join(', ')})` : ''}${existing ? ', or have the work wait on what is a task already, in after, rather than planning it again' : ''}`
}

/**
 * Why making stopped after every check had passed — a disk, git, or a name
 * another plan took in the moment between — and what was made by then. What
 * was made is kept and named rather than removed: removing a task never gives
 * its name back, and the queue may already have started the first of them.
 * Made in an order where each comes after what it waits on, it waits only on
 * what exists, so what is left can be planned again on its own, waiting on it.
 */
function stoppedAt(
  plan: Plan,
  order: readonly PlannedAgent[],
  made: readonly TaskWorktree[],
  err: unknown,
): string {
  const failed = order[made.length]
  const why = `${failed ? agentId(plan, failed) : 'a task'} could not be made: ${err instanceof Error ? err.message : String(err)}`
  if (made.length === 0) return `the plan was not made: ${why}`
  const left = order.slice(made.length).map((agent) => agentId(plan, agent))
  return `the plan was made only in part: ${joined(made.map((task) => task.id))} ${made.length === 1 ? 'is' : 'are'} queued, then ${why}. ${joined(left)} ${left.length === 1 ? 'was' : 'were'} not made: plan only ${left.length === 1 ? 'that' : 'those'} again, waiting on what was made where ${left.length === 1 ? 'it needs' : 'they need'} to`
}

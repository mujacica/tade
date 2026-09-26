import {
  type Config,
  checkPlan,
  type EventFilter,
  type Plan,
  type PlanBusy,
  projectOf,
  projectsIn,
  type TadeEvent,
  workspaceFor,
} from '@tade/core'
import type { TaskWorktree } from './tasks.ts'
import type { CreateTaskRequest } from './workbench.ts'

// Making a plan's tasks: the one place a change that spans repositories turns
// into ordinary tasks in ordinary repositories.
//
// Its own file because it is its own subject, and because everything it does
// is about several projects at once while the workbench around it is about one
// thing at a time: which repositories the plan reaches into, whether Tade has
// them all, every task in every project so a wait can cross one, and the
// effort's sentence written down once before anything is made.

/** What a plan made: its tasks, in the order they were made, and what to watch out for. */
export interface PlanMade {
  made: TaskWorktree[]
  warnings: string[]
}

/** What making a plan needs of the workbench, and nothing else. */
export interface PlanDeps {
  config: Config
  /** The journal, for what tasks Tade already has. */
  events(filter: EventFilter): Promise<readonly TadeEvent[]>
  /** Write a line down: the effort's name and sentence. */
  note(event: { type: 'effort_named'; detail: Record<string, unknown> }): Promise<void>
  createTask(req: CreateTaskRequest): Promise<TaskWorktree>
  resolveModel(said: string): Promise<{ provider: string; id: string }>
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
  const created = await deps.events({ types: ['task_created', 'task_removed'] }).catch(() => [])
  // Every task Tade has, in every project. The ids are already qualified, so
  // widening this is the whole of what lets a task in one repository wait on a
  // task in another — `checkPlan` resolves them exactly as it always did.
  const tasks = new Set<string>()
  for (const event of created) {
    if (!event.task) continue
    if (event.type === 'task_created') tasks.add(event.task)
    else tasks.delete(event.task)
  }
  const check = checkPlan(plan, {
    workspace: (project) => workspaceFor(deps.config, project),
    tasks,
    busy,
  })
  if (!check.ok) throw new Error(`the plan was not made: ${check.problems.join('; ')}`)
  // Every model named for the work settled first: a plan that starts half its
  // agents and then cannot tell which model the rest meant is a mess to undo.
  const models = new Map<string, { provider: string; id: string }>()
  for (const agent of check.order) {
    if (agent.model) models.set(agentId(plan, agent), await deps.resolveModel(agent.model))
  }
  // Written before the tasks, and once: the sentence is the only thing an
  // effort has that nothing else can recover once its task files are gone.
  if (plan.effort) {
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
    made.push(
      await deps.createTask({
        project: projectOf(plan, agent),
        slug: agent.name,
        intent: agent.said,
        by,
        ...(plan.effort ? { effort: plan.effort } : {}),
        ...(agent.done ? { done: agent.done } : {}),
        ...(agent.produces ? { produces: agent.produces } : {}),
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
  }
  return { made, warnings: check.warnings }
}

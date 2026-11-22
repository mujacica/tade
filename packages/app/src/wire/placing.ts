import {
  agentMachine,
  type Config,
  hubOf,
  orchestratorAttachments,
  type Plan,
  type PlannedAgent,
  placeQueued,
  projectOf,
  waitsElsewhere,
} from '@tade/core'
import type { Placing } from './moves.ts'

// Where a plan's work waits: the window's half of `placeQueued`
// (`@tade/core`'s `placement.ts`). Each agent that does not say where it runs
// is placed before anything is made — on the hub where it waits for later and
// nothing ties it here, here otherwise — in the order the plan's own waits
// give, because what ties one agent here can be another agent of the same
// plan staying here. What is placed elsewhere is made parked here and sent
// there as a take (`Moves.startThere`) once the plan is made, so it is never
// started here in the moment between.

/** The links, as placing reads them: which machines there are, which are up, and what each has. */
export interface Places {
  /** The machines this one links to, by their names here. */
  machines(): readonly string[]
  /** Whether a machine's link is up now. */
  up(machine: string): boolean
  /** The one project on that machine that is this project's repository, or null. */
  projectThere(machine: string, project: string): string | null
  /** Queued work made here, sent there; answers what happened, throws why not. */
  send(task: string, machine: string, how: Placing): Promise<string>
}

/** A plan with every agent's machine decided, and why each is where it is, by agent name. */
export interface PlanPlaced {
  plan: Plan
  why: ReadonlyMap<string, string>
  /** The agents placed by the rule rather than by the plan: one not taken there runs here. */
  byRule: ReadonlySet<string>
}

/** Which agent of the plan a wait names, where it names one. */
function siblingOf(plan: Plan, agent: PlannedAgent, said: string): PlannedAgent | null {
  const name = said.split('/').at(-1) ?? said
  const project = said.includes('/') ? said.slice(0, said.indexOf('/')) : projectOf(plan, agent)
  const same = plan.agents.filter((one) => one !== agent && one.name === name)
  return same.find((one) => projectOf(plan, one) === project) ?? same[0] ?? null
}

/**
 * Every agent of a plan placed: what it says where it says, and otherwise
 * `placeQueued`'s answer, each once what it waits on in the plan has been.
 */
export function placePlan(
  plan: Plan,
  facts: {
    config: Pick<Config, 'machine' | 'remotes'>
    home: string
    self: string
    places: Places | null
    /** Whether a task Tade already has, here, has finished. */
    finished: (task: string) => boolean
    now: number
  },
): PlanPlaced {
  const { hub } = hubOf(facts.config)
  const placed = new Map<string, string | null>()
  const why = new Map<string, string>()
  const byRule = new Set<string>()
  for (const agent of plan.agents) {
    const said = agentMachine(agent, facts.self)
    if (said !== null) {
      placed.set(agent.name, said)
      why.set(agent.name, `planned for ${said} from ${facts.self}`)
    } else if (agent.machine !== undefined) placed.set(agent.name, null)
  }
  const attachments = orchestratorAttachments(facts.home)
  // In the plan's own order of waits: an agent is placed once every agent of
  // the plan it waits on has been. A loop is refused by `checkPlan` anyway.
  for (let round = 0; round <= plan.agents.length; round++) {
    for (const agent of plan.agents) {
      if (placed.has(agent.name)) continue
      const waitsHere: string[] = []
      let unfinished = 0
      let ready = true
      for (const dep of agent.after) {
        if (waitsElsewhere(dep.agent)) {
          unfinished++
          continue
        }
        const sibling = siblingOf(plan, agent, dep.agent)
        if (sibling !== null) {
          if (!placed.has(sibling.name)) ready = false
          unfinished++
          if ((placed.get(sibling.name) ?? null) === null) waitsHere.push(sibling.name)
          continue
        }
        const task = dep.agent.includes('/') ? dep.agent : `${projectOf(plan, agent)}/${dep.agent}`
        if (facts.finished(task)) continue
        unfinished++
        waitsHere.push(task)
      }
      if (!ready && round < plan.agents.length) continue
      const at = agent.at ? Date.parse(agent.at) : Number.NaN
      const project = projectOf(plan, agent)
      const context = `${plan.context ?? ''}\n${agent.context ?? ''}`
      const answer = placeQueued({
        hub,
        self: facts.self,
        hubUp: hub !== null && facts.places?.up(hub.name) === true,
        projectThere: hub === null ? null : (facts.places?.projectThere(hub.name, project) ?? null),
        startsNow: unfinished === 0 && !(Number.isFinite(at) && at > facts.now),
        // An approval is given where the document is kept.
        waitsHere: [
          ...waitsHere,
          ...agent.after.filter((dep) => dep.approved).map((dep) => `${dep.agent}'s approval`),
        ],
        filesHere: context.includes(attachments),
        measurement: plan.race !== undefined || plan.replay !== undefined,
      })
      placed.set(agent.name, answer.on)
      if (answer.why !== null) why.set(agent.name, answer.why)
      if (answer.on !== null) byRule.add(agent.name)
    }
  }
  return {
    plan: {
      ...plan,
      agents: plan.agents.map((agent) => {
        const on = placed.get(agent.name) ?? null
        const { machine: _, ...rest } = agent
        return on === null ? rest : { ...rest, machine: on }
      }),
    },
    why,
    byRule,
  }
}

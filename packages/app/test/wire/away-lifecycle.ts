import type { Config } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { Agents, type AgentsDeps } from '../../src/wire/agents.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Projects, type ProjectsDeps } from '../../src/wire/projects.ts'
import type { Lifecycle } from '../../src/wire/web-lifecycle.ts'

// The lifecycle half of the away harness: the window's own `Agents` and
// `Projects` subjects behind the away view, and the registry's agent lanes.
//
// **Its own file for the reason `away-intake.ts` is**: a different subject, and
// the harness at the length a file is allowed to be.
//
// **The subjects are the real ones.** Stopping is `Agents`' stop, marked as
// stopped on purpose; closing and opening are `Projects`' doors, writing the
// home's real `config.yaml` and the real journal. What is stood in for is what
// the harness already stands in for — a harness and a driver — and only at
// the three doors those answer: which lanes the registry holds, stopping one,
// and reattaching one. Each stand-in writes the journal line the real one
// writes, so the counts a verb re-checks at the act are read off the real
// journal rather than off a fixture's say-so.

/**
 * The registry's agent lanes, by task: alive or kept with their spec.
 *
 * A task with no entry has never had an agent, which is the one shape `reopen`
 * must refuse rather than start.
 */
export type AgentLanes = Map<string, boolean>

/** The three doors a registry and a harness answer, or undefined for every other. */
export function laneDoor(
  name: string | symbol,
  lanes: AgentLanes,
  running: Map<string, string>,
  client: Workbench,
): unknown {
  if (name === 'lanes') {
    return (task?: string) =>
      [...lanes]
        .filter(([one]) => task === undefined || one === task)
        .map(([one, alive]) => ({ id: `${one}/agent`, task: one, kind: 'agent', alive }))
  }
  if (name === 'stopAgent') {
    return async (task: string) => {
      if (!lanes.has(task)) throw new Error(`no lane for ${task}`)
      lanes.set(task, false)
      running.delete(task)
      await client.log.append({ type: 'lane_closed', lane: `${task}/agent`, task })
    }
  }
  if (name === 'reopenAgent') {
    return async (req: { task: string; cwd: string }) => {
      if (lanes.get(req.task) === true) throw new Error(`${req.task} already has an agent running`)
      lanes.set(req.task, true)
      running.set(req.task, 'pi')
      await client.log.append({ type: 'run_started', task: req.task, detail: { cwd: req.cwd } })
      return {}
    }
  }
  return undefined
}

/**
 * The two subjects, over the harness's own wiring.
 *
 * `useConfig` keeps the window's own `surfaces` when a project is closed or
 * opened: the home's `config.yaml` is the workbench's and says nothing about
 * the away view, while the window's config is the harness's — and a close that
 * turned acting off by reading the other file would be a test about the
 * fixture rather than about closing.
 */
export function lifecycleFor(
  wire: Wiring,
  held: { get(): Config; set(config: Config): void },
): Lifecycle {
  const agents = new Agents(wire, {} as AgentsDeps)
  const projects = new Projects(wire, {
    useConfig: (config) => held.set({ ...config, surfaces: held.get().surfaces }),
  } as ProjectsDeps)
  return { agents: () => agents, projects: () => projects }
}

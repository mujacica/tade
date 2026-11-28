import {
  type AgentLane,
  byOf,
  type CloseProjectCall,
  type From,
  Moved,
  NotThere,
  type Outcome,
  type ProjectFacts,
  type ProjectIn,
  projectFactsOf,
  projectRev,
  type StopAgentCall,
  type WebActing,
} from '@tade/web'
import { agentLaneOf, type ProjectLine, projectLines } from '../away-lifecycle.ts'
import type { AgentMenuDoors } from './agent-doors.ts'
import { type ActingDeps, after, onTask } from './web-acting.ts'

// The window's end of the two lifecycle verbs: an agent stopped and a project
// closed — the two another machine's window presses there (`remote-agent.ts`,
// `remote-project.ts`). Opening either again is the window's own, done in
// the full view or at the machine.
//
// **Each one goes through the door the keyboard goes through**, and adds only
// what a request from away needs on top: the re-check, the provenance and a
// sentence with no path in it. Stopping is the `Agents` subject's stop — the
// agent marked as stopped on purpose, so the window never opens it again behind
// anybody's back — and closing is `Projects.closeProject`, which deletes
// nothing and stops nothing. A second implementation of either here would be a
// second set of rules about one lane and one config.
//
// ## What each re-check reads, at the moment of the write
//
// The row's revision (`was`) is checked first, as for every verb, and it is
// about the screen. What makes each of these an act about *this* world is read
// again here, after it, from the thing that is the truth:
//
// | verb | read at the act |
// |---|---|
// | `stop` | the registry's own `<task>/agent` lane is alive, and the journal's count of starts is the one the screen was of |
// | `close` | the window's config still has the project, and the journal's count of lines about where it lives |
//
// **One at a time per target** (`busy`), because the door the keyboard uses
// awaits between its own check and its write — a config written, then read
// back — and two closes asked in that gap would both find the project still on
// the list and both write a line saying they closed it.

/** The two verbs this file carries out, as `WebActing` declares them. */
export type LifecycleActing = Pick<WebActing, 'stop' | 'close'>

/** What stopping and opening an agent needs of the window's `Agents` subject. */
export interface AgentDoors {
  /** Stop one agent, by its exact task, as stopped on purpose. Throws. */
  stopExactly(task: string, by: string): Promise<void>
  /**
   * Open one stopped agent again where it left off, saying nothing to it.
   * `nowhere` where the window does not know where it works, `busy` where it is
   * being opened already. Throws anything else.
   */
  reopenExactly(task: string, by: string): Promise<'opened' | 'busy' | 'nowhere'>
}

/** What closing and opening a project needs of the window's `Projects` subject. */
export interface ProjectDoors {
  closeProject(name: string, by: string): Promise<string>
  openAt(req: { path: string; name: string; create: boolean; by: string }): Promise<string>
}

/**
 * The two subjects, asked for when an act needs them rather than when the
 * window wires itself — the away view comes up before either exists.
 */
export interface Lifecycle {
  agents(): AgentDoors
  projects(): ProjectDoors
  /**
   * The rest of an agent's menu (`agent-doors.ts`): absent where a window was
   * wired without it, and then each of those verbs is `not_offered`.
   */
  menus?(): AgentMenuDoors
}

/** What the lifecycle verbs need beyond `ActingDeps`: the subjects, and the project rows. */
export interface LifecycleDeps extends Lifecycle {
  /**
   * What the projection last said about one project, as the facts a verb
   * checks: `seen`'s rule, one level up — the same row the device tapped.
   */
  seenProject(name: string): ProjectFacts | null
}

/** One project's facts out of the rows the projection was built from, or null. */
export function projectSeen(rows: readonly ProjectIn[], name: string): ProjectFacts | null {
  const row = rows.find((one) => one.name === name)
  return row === undefined ? null : projectFactsOf(row)
}

/** The two verbs, over one window's doors. One `busy` set for both. */
export function lifecycleActing(deps: ActingDeps): LifecycleActing {
  const busy = new Set<string>()
  const alone = <T>(target: string, work: () => Promise<T>, rev: () => string): Promise<T> => {
    if (busy.has(target)) {
      return Promise.reject(new Moved(`${target} is being changed by another request`, rev()))
    }
    busy.add(target)
    return work().finally(() => busy.delete(target))
  }
  return {
    stop: (call, from) =>
      onTask(deps, call, (facts) =>
        alone(
          call.task,
          () => stop(deps, call, from, facts),
          () => after(facts),
        ),
      ),
    close: (call, from) =>
      onProject(deps, call, (facts) =>
        alone(
          call.project,
          () => close(deps, call, from, facts),
          () => projectRev(facts),
        ),
      ),
  }
}

type Facts = Parameters<typeof after>[0]

/**
 * Stop a task's agent: the registry's lane, asked now, must be the running one
 * the screen was of.
 *
 * **The journal is read first and the lane last**, with nothing awaited
 * between the lane and the stop: the count of starts is the slow read, and the
 * lane is the thing the act is about, so it is the one asked closest to the
 * write.
 */
async function stop(
  deps: ActingDeps,
  call: StopAgentCall,
  from: From,
  facts: Facts,
): Promise<Outcome> {
  const starts = await startsNow(deps, call.task)
  if (starts !== facts.starts) {
    throw new Moved(
      `${call.task}'s agent was started again since that screen was drawn`,
      after(facts, { starts }),
    )
  }
  const lane = laneNow(deps, call.task)
  if (lane !== 'running') {
    throw new Moved(`${call.task} has no agent running any more`, after(facts, { lane }))
  }
  await deps.lifecycle.agents().stopExactly(call.task, byOf(from))
  return {
    did: true,
    rev: after(facts, { lane: laneNow(deps, call.task) }),
    // What happens to the lane's spec is the half somebody deciding whether to
    // open it again needs, so it is said rather than implied.
    said:
      'stopped its agent: its lane is closed and its spec kept, so it can be opened again ' +
      'where it left off — its conversation, branch and worktree stay',
  }
}

/**
 * Close a project: the window's own close, which deletes nothing and stops
 * nothing, after the config and the journal say the screen was right.
 */
async function close(
  deps: ActingDeps,
  call: CloseProjectCall,
  from: From,
  facts: ProjectFacts,
): Promise<Outcome> {
  const changes = (await linesNow(deps)).get(call.project)?.changes ?? 0
  if (!Object.hasOwn(deps.config().projects, call.project)) {
    throw new Moved(`${call.project} is closed already`, projectRev({ open: false, changes }))
  }
  if (changes !== facts.changes) {
    throw new Moved(
      `${call.project} was moved or opened again since that screen was drawn`,
      projectRev({ open: true, changes }),
    )
  }
  // Counted before the close, which is what takes the project out of
  // everything that could still answer it.
  const working = deps.tade.runs().filter((run) => run.task.startsWith(`${call.project}/`)).length
  await deps.lifecycle.projects().closeProject(call.project, byOf(from))
  return {
    did: true,
    // **One line more than was read**, and not read back: the door writes
    // exactly one `config_changed` about where the project lives, and writes it
    // without waiting on the disk — so reading the journal here could answer
    // with the world from before the act.
    rev: projectRev({ open: false, changes: changes + 1 }),
    said: closedSaid(working),
  }
}

/** What closing came to, with no path in it: the sentence the window's own close says, from away. */
function closedSaid(working: number): string {
  const still =
    working === 0
      ? 'nothing was running in it'
      : `${working === 1 ? 'an agent is' : `${working} agents are`} still working in it, unseen here until it is open again`
  return (
    `closed it, and stopped nothing: ${still}. Nothing was deleted — its folder, history, ` +
    'branches, worktrees, tasks and notes all stay, and opening it again brings them back; ' +
    'its own settings went with it'
  )
}

/**
 * The first check every project verb makes: **the screen told the truth**,
 * `onTask`'s rule one level up.
 *
 * A project the projection does not have is a `404`: outside this device's
 * reach, or gone from the journal and the config both.
 */
async function onProject<T>(
  deps: ActingDeps,
  call: { project: string; was: string },
  work: (facts: ProjectFacts) => Promise<T>,
): Promise<T> {
  const facts = deps.lifecycle.seenProject(call.project)
  if (facts === null) throw new NotThere(`there is no project here called ${call.project}`)
  const now = projectRev(facts)
  if (now !== call.was)
    throw new Moved(`${call.project} has moved on since that screen was drawn`, now)
  return work(facts)
}

/** The task's own agent lane as the registry holds it **now**: the lane truth. */
function laneNow(deps: ActingDeps, task: string): AgentLane {
  return agentLaneOf({ id: task, lanes: deps.tade.lanes(task) })
}

/** How many agents were ever started on it, from the whole journal, now. */
async function startsNow(deps: ActingDeps, task: string): Promise<number> {
  return (await deps.tade.events({ types: ['run_started'], task })).length
}

/** Every project's lines about where it lives, from the whole journal, now. */
async function linesNow(deps: ActingDeps): Promise<Map<string, ProjectLine>> {
  return projectLines(await deps.tade.events({ types: ['config_changed'] }))
}

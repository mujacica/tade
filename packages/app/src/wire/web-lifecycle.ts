import { expandHome } from '@tade/core'
import {
  type AgentLane,
  byOf,
  type CloseProjectCall,
  type From,
  Moved,
  NotOffered,
  NotThere,
  type OpenProjectCall,
  type Outcome,
  type ProjectFacts,
  type ProjectIn,
  projectFactsOf,
  projectRev,
  type ReopenAgentCall,
  type StopAgentCall,
  type WebActing,
} from '@tade/web'
import { agentLaneOf, type ProjectLine, projectLines } from '../away-lifecycle.ts'
import { isRepo, whatIsAt } from '../projects.ts'
import { type ActingDeps, after, onTask } from './web-acting.ts'

// The window's end of the four lifecycle verbs: an agent stopped and opened
// again, a project closed and opened again.
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
// | `reopen` | that lane is there and not alive — never a task no agent has run on — and the same count |
// | `close` | the window's config still has the project, and the journal's count of lines about where it lives |
// | `open` | the config does not, the journal says where it was, and that folder is a repository nobody else has open |
//
// **One at a time per target** (`busy`), because the door the keyboard uses
// awaits between its own check and its write — a config written, then read
// back — and two closes asked in that gap would both find the project still on
// the list and both write a line saying they closed it.

/** The four verbs this file carries out, as `WebActing` declares them. */
export type LifecycleActing = Pick<WebActing, 'stop' | 'reopen' | 'close' | 'open'>

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
}

/** What the four verbs need beyond `ActingDeps`: the subjects, and the project rows. */
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

/** The four verbs, over one window's doors. One `busy` set for all four. */
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
    reopen: (call, from) =>
      onTask(deps, call, (facts) =>
        alone(
          call.task,
          () => reopen(deps, call, from, facts),
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
    open: (call, from) =>
      onProject(deps, call, (facts) =>
        alone(
          call.project,
          () => open(deps, call, from, facts),
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
 * Open a task's stopped agent again: a lane the registry kept, never a task no
 * agent has run on.
 */
async function reopen(
  deps: ActingDeps,
  call: ReopenAgentCall,
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
  if (lane === 'running') throw new Moved(`${call.task}'s agent is running`, after(facts, { lane }))
  // **Never a new agent.** A task with no lane of its own has nothing to bring
  // back, and making one is the opening instruction a device may not give.
  if (lane === 'none') {
    throw new NotOffered(`no agent has run on ${call.task}: starting one is done at the machine`)
  }
  const came = await deps.lifecycle.agents().reopenExactly(call.task, byOf(from))
  if (came === 'nowhere') throw new NotThere(`the window does not know where ${call.task} works`)
  if (came === 'busy') throw new Moved(`${call.task}'s agent is being opened already`, after(facts))
  return {
    did: true,
    // What the registry and the journal say now, rather than what was asked
    // for: guessing would be a revision nothing confirmed.
    rev: after(facts, { lane: laneNow(deps, call.task), starts: await startsNow(deps, call.task) }),
    said:
      'opened its agent again where it left off: the lane spec it kept and the same ' +
      'conversation, with nothing said to it',
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
 * Open a closed project again where the journal says it was — and only there,
 * so a device can bring back a project Tade has had and never name a folder.
 */
async function open(
  deps: ActingDeps,
  call: OpenProjectCall,
  from: From,
  facts: ProjectFacts,
): Promise<Outcome> {
  const line = (await linesNow(deps)).get(call.project)
  const changes = line?.changes ?? 0
  const config = deps.config()
  if (Object.hasOwn(config.projects, call.project)) {
    throw new Moved(`${call.project} is open already`, projectRev({ open: true, changes }))
  }
  if (changes !== facts.changes || line?.closedFrom == null) {
    throw new Moved(
      `${call.project} was moved or opened since that screen was drawn`,
      projectRev({ open: false, changes }),
    )
  }
  const root = line.closedFrom
  const full = expandHome(root)
  // **Somebody else's now**: the folder was opened under another name since,
  // and the keyboard's door would quietly go to that one instead.
  const other = Object.entries(config.projects).find(([, one]) => expandHome(one.root) === full)
  if (other !== undefined)
    throw new NotOffered(`the folder ${call.project} was in is open as ${other[0]}`)
  // **Not there, or not a repository any more**: opening never makes a
  // folder or a repository from away, which the keyboard's door would ask about.
  if (whatIsAt(full) !== 'folder' || !isRepo(full)) {
    throw new NotThere(`the folder ${call.project} was in is not a repository there any more`)
  }
  await deps.lifecycle
    .projects()
    .openAt({ path: root, name: call.project, create: false, by: byOf(from) })
  return {
    did: true,
    // One line more than was read, for the reason `close` gives.
    rev: projectRev({ open: true, changes: changes + 1 }),
    said:
      'opened it again where it was: its tasks, notes and agents are back on its page — its own ' +
      'settings are not, and are set again at the machine',
  }
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

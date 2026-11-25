import { IDLE_REASON, type QueueState } from '@tade/core'
import type { ScheduleThere } from './machine-there.ts'
import type { Machine, Place, RemoteAgent, RemoteProject } from './machines.ts'
import type { AgentPane, QueuedView, ScheduleView } from './model.ts'
import { type MenuItem, menuItems, queueMenuItems, scheduleMenuItems } from './panels/menu/state.ts'

// Another machine's agents, queued work and schedules as this machine's own
// rows: the same `AgentPane`, `QueuedView` and `ScheduleView` the side draws
// here, so a project there is drawn by the same views — `taskRow`, `queueRow`,
// `schedulesSection` — and pressed through the same actions and menus.
//
// **The machine is a value, and it travels in the id.** A row's id is what
// every control on it carries — `close-task:<id>`, `{ kind: 'task', task }`,
// `schedule-pause:<id>`, a menu's subject — so an id from another machine is
// that machine's id with the machine in front of it (`there`), and the one
// place that turns a press into an act asks `refOf` which machine it is for.
// Nothing between the drawing and that place knows two kinds of row exist.
// A task or schedule id here never starts with `@` (`TaskId`), and the
// separator is a control character no name can hold, so the two never meet.

const MARK = '@'
const SEP = '\u001f'

/** An id on another machine, as the rows here carry it. */
export function there(machine: string, id: string): string {
  return `${MARK}${machine}${SEP}${id}`
}

/** Which machine an id a row carried is on — null for this one — and its id there. */
export function refOf(id: string): { machine: string | null; id: string } {
  if (!id.startsWith(MARK)) return { machine: null, id }
  const cut = id.indexOf(SEP)
  if (cut < 0) return { machine: null, id }
  return { machine: id.slice(MARK.length, cut), id: id.slice(cut + SEP.length) }
}

/** Whether a row's id is another machine's. */
export function isThere(id: string): boolean {
  return refOf(id).machine !== null
}

/**
 * The fields of a pane that make this machine's `markOf` draw the mark that
 * machine drew: a remote sends its mark, never the facts it was made of.
 */
function asMarked(agent: RemoteAgent): Pick<AgentPane, 'state' | 'waiting' | 'reason'> {
  switch (agent.mark) {
    case 'working':
      return { state: 'working', waiting: false, reason: agent.reason }
    case 'failed':
      return { state: 'failed', waiting: false, reason: agent.reason }
    case 'parked':
      return { state: 'parked', waiting: false, reason: agent.reason }
    case 'done':
      return { state: 'review', waiting: false, reason: agent.reason }
    case 'idle':
      return { state: 'blocked', waiting: false, reason: IDLE_REASON }
    case 'needs-you':
      return { state: 'blocked', waiting: true, reason: agent.reason }
    default:
      return { state: 'queued', waiting: false, reason: agent.reason }
  }
}

/** An agent there, as a pane here: its id carries its machine (`there`). */
export function paneThere(agent: RemoteAgent, project: RemoteProject, machine: Machine): AgentPane {
  return { ...paneOf(agent, project), task: there(machine.name, agent.id) }
}

/**
 * An agent there, as a pane drawn standing in its project (`side.ts`): its id
 * as it is there, which the drawing names it by — the machine goes into what
 * is pressed on the way out (`thereTarget`).
 */
export function paneOf(agent: RemoteAgent, project: RemoteProject): AgentPane {
  return {
    task: agent.id,
    project: project.name,
    name: agent.name,
    title: agent.title,
    branch: '',
    // Its lane is that machine's: nothing here can draw it but through the link.
    lane: null,
    ...asMarked(agent),
    approval: agent.approval
      ? {
          tool: agent.approval.tool,
          summary: agent.approval.command?.text ?? agent.approval.tool,
          id: agent.approval.id,
        }
      : null,
    lanes: [],
  }
}

/**
 * Queued work there, as queued work here. A remote says how it stands in its
 * own words (`reason`) and a mark, never its queue state, so the state is the
 * one its mark is: held where it wants somebody, paused where it is parked, and
 * otherwise waiting — and what the row says under its name is that machine's.
 */
export function queuedThere(
  agent: RemoteAgent,
  project: RemoteProject,
  machine: Machine,
): AgentPane & { queued: QueuedView } {
  return { ...queuedOf(agent, project), task: there(machine.name, agent.id) }
}

/** Queued work there, as `paneOf` draws an agent there: by its id there. */
export function queuedOf(
  agent: RemoteAgent,
  project: RemoteProject,
): AgentPane & { queued: QueuedView } {
  const state: QueueState =
    agent.mark === 'needs-you'
      ? { kind: 'held', on: null, because: agent.reason }
      : agent.parked
        ? { kind: 'paused', all: false, parked: true }
        : { kind: 'waiting', on: [] }
  return {
    ...paneOf(agent, project),
    state: 'queued',
    queued: { state, after: [], prompt: '', touches: [], at: null },
  }
}

/** What a schedule there does each time, by its kind: all that machine says of it. */
const DOES: Readonly<Record<ScheduleThere['kind'], string>> = {
  agent: 'starts an agent there',
  ask: 'asks the orchestrator there',
  watch: 'looks there',
}

/**
 * A schedule there, as a schedule here: what it said of itself, and nothing
 * invented for what it did not — no runs, no findings it did not send, the
 * next run where it named one.
 */
export function scheduleThere(one: ScheduleThere, machine: string): ScheduleView {
  return { ...scheduleOf(one, machine), id: there(machine, one.id) }
}

/** A schedule there, as `paneOf` draws an agent there: by its id there. */
export function scheduleOf(one: ScheduleThere, machine: string): ScheduleView {
  return {
    id: one.id,
    name: one.name,
    project: one.project,
    said: '',
    kind: one.kind,
    does: DOES[one.kind],
    prompt: '',
    when: one.when,
    once: false,
    next: one.next === null ? [] : [one.next],
    paused: one.paused,
    by: machine,
    missed: 'once',
    runs: [],
    ...(one.watch
      ? {
          watch: {
            id: one.watch.id,
            turnedOnBy: machine,
            found: 'agent' as const,
            // Not sent: `0` is the card's "not said", never drawn as a budget of nought.
            most: 0,
            looks: one.watch.looks.map((look) => ({
              at: look.at ?? 0,
              found: look.found,
              fresh: look.fresh,
              left: 0,
              problem: look.problem,
              trouble: null,
              until: null,
              said: look.said,
              ...(look.on === null ? {} : { on: look.on }),
            })),
            findings: one.watch.found.map((it) => ({
              at: it.at ?? 0,
              key: it.key,
              title: it.title ?? it.key,
              task: it.task,
              // What that machine did with one it started nothing for is its own to
              // say, and it did not: said as its, never as "could not start".
              told: it.task === null ? machine : null,
              problem: null,
            })),
          },
        }
      : {}),
  }
}

/** The schedules of the project a place names, as this machine's are shown. */
export function schedulesThere(machine: Machine, place: Place): ScheduleView[] {
  return (machine.detail.about?.schedules ?? [])
    .filter((one) => one.project === place.project)
    .map((one) => scheduleThere(one, machine.name))
}

/**
 * The away view's verb each item of an agent's menu is, there (`/api/act/<verb>`):
 * the far side's own acts, each with its key, so a press sent twice over a link
 * that dropped is done once.
 */
export const VERB_OF: Readonly<Record<string, string>> = {
  start: 'start',
  stop: 'stop',
  'mark-done': 'done',
  rename: 'rename',
  model: 'model',
  account: 'account',
  park: 'park',
  remove: 'remove',
  'queue-start': 'queue',
  'queue-first': 'queue',
  'queue-pause': 'queue',
  'queue-resume': 'queue',
  'queue-wait': 'queue',
  'queue-drop': 'queue',
  'queue-remove': 'remove',
}

/**
 * What cannot cross the link at all, in the words the item says it with —
 * short, because a menu's note gives way where the menu has no room for it.
 */
function notAcross(item: string, machine: string): string | null {
  switch (item) {
    case 'changes':
      return `read on ${machine}`
    case 'editor':
      return `files on ${machine}`
    case 'copy-branch':
      return `${machine} sent none`
    case 'queue-after':
      return `chosen on ${machine}`
    default:
      return null
  }
}

/**
 * An agent there's menu: the menu an agent here has, item for item
 * (`menuItems`, or `queueMenuItems` for queued work), each carried to that
 * machine — and off, saying why, where its link is down, where it says it
 * cannot be done to it now (its `cannot`), or where the act cannot cross a link at all.
 */
export function thereItems(
  agent: RemoteAgent,
  project: RemoteProject,
  machine: Machine,
): MenuItem[] {
  const listed = agent.queued
    ? queueMenuItems(queuedThere(agent, project, machine).queued)
    : menuItems(
        {
          lane: agent.lane === 'running' ? 'there' : null,
          state: asMarked(agent).state,
          finished: agent.mark === 'done' ? { by: machine.name } : null,
        },
        0,
      )
  const down = machine.link === 'live' ? null : `${machine.name} is not linked right now`
  return listed.map((item) => {
    // Before what is true of it here: `none yet` about changes nobody here can read is not so.
    const across = notAcross(item.id, machine.name)
    if (across !== null) return { ...item, off: across }
    if (item.off) return item
    if (down !== null) return { ...item, off: down }
    // What it says cannot be done to it now is off with its sentence, as an
    // item here is off by what is true of the agent. Everything else is
    // offered as it is here, and that machine answers the press — whether it
    // lets this one ask is its to say at the act, never guessed here.
    const verb = VERB_OF[item.id]
    const why = verb === undefined ? undefined : agent.cannot.find((one) => one.verb === verb)?.why
    return why === undefined ? item : { ...item, off: why }
  })
}

/** A schedule there's menu: a schedule here's, off where its link is down. */
export function thereScheduleItems(one: ScheduleView, machine: Machine): MenuItem[] {
  if (machine.link === 'live') return scheduleMenuItems(one)
  const down = `${machine.name} is not linked right now`
  return scheduleMenuItems(one).map((item) =>
    item.off || item.id === 'schedule-open' ? item : { ...item, off: down },
  )
}

import { type InboxRow, printable } from '@tade/core'
import type { SideAnswer, SideAsk } from '@tade/web'
import type { FileEntry } from './files.ts'
import type { Change, Frame, NoteShown, TaskSpent } from './frame.ts'
import type { Target } from './hits.ts'
import { elsewhereOf, type Machine, type Place, placeIn, type RemoteProject } from './machines.ts'
import type { AgentPane, AppState, ScheduleView } from './model.ts'
import type { AgentOffers, MenuSubject } from './panels/menu/state.ts'
import { paneOf, queuedOf, refOf, scheduleOf, there } from './there.ts'
import type { Drawn } from './ui.ts'

// A project on another machine, drawn by this machine's own views.
//
// **There is no remote layout.** The machine there answers what its own
// window would draw the project from (`/api/side`, `@tade/web`'s `side.ts`):
// its `AgentPane`s, what each spent, its schedules and requests, what changed
// in its checkout, its files, its notes, where its work is, and the header of
// the agent in front of you. Standing in that project, the side and the pane
// are drawn by `renderSidebar` and `renderMain` exactly as for a project here,
// out of a state and a frame in which that project *is* the one here
// (`seenThere`) — so an agent there and an agent here are the same rows, the
// same header and the same controls, and `test/same-there.test.ts` holds the
// two frames equal apart from the machine's name.
//
// **The machine is in the ids of what you press, and nowhere in the drawing.**
// The drawing is handed that machine's ids as they are there, because they are
// also its text (`after tade/fix`), and every target it hands back is carried
// to that machine on the way out (`thereTarget`): a task id becomes
// `@machine␟id` (`there.ts`), which the one place a press becomes an act reads
// with `refOf`. What the pointer is on comes back the other way
// (`hereTarget`), so a row lights under the pointer as one here does.
//
// **Everything here was written on another machine.** `@tade/web` reads the
// answer for its shape; `sideThere` reduces every string in it to text
// (`printable`) before any of it reaches a view.

/** What one project there says of itself, folded for this machine's views. */
export interface SideThere {
  project: string
  looking: boolean
  panes: readonly AgentPane[]
  /** By task id there; null where it has not read its journal yet. */
  spent: Readonly<Record<string, TaskSpent>> | null
  changes: readonly Change[] | null
  base: string | null
  files: readonly FileEntry[] | null
  marks: Readonly<Record<string, string>>
  where: NonNullable<Frame['where']> | null
  notes: readonly NoteShown[]
  retired: readonly NoteShown[]
  schedules: readonly ScheduleView[]
  intake: readonly InboxRow[]
  intakeEmpty: { short: string; long: string }
  /** The header of the agent in front of you there: what it runs on, as its own header says. */
  agent: {
    task: string
    route: NonNullable<Frame['route']>
    vitals: Frame['vitals']
    offers: AgentOffers | null
  } | null
}

/** What the frame holds of the project there you are standing in: the answer, or why none yet. */
export interface SideShown {
  machine: string
  project: string
  /** The last answer about it; kept while a new one is asked, so nothing blinks. */
  there: SideThere | null
  /** Why there is none, where there is none: as text. */
  said: string | null
}

/** Every string in a value, reduced to text: what another machine wrote is never a key. */
function texted<T>(value: T): T {
  if (typeof value === 'string') return printable(value) as T
  if (Array.isArray(value)) return value.map((one) => texted(one)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, one] of Object.entries(value)) out[key] = texted(one)
    return out as T
  }
  return value
}

/**
 * The answer there, as this machine's views take it. Read for its shape by
 * `@tade/web`; here every string becomes text, and the lists the wire carries
 * as pairs become the records the views read.
 */
export function sideThere(answer: SideAnswer): SideThere {
  const said = texted(answer)
  return {
    project: said.project,
    looking: said.looking,
    panes: said.panes.map((pane) => ({
      ...pane,
      lanes: pane.lanes.map((lane) => ({ ...lane })),
      servers: pane.servers,
    })) as AgentPane[],
    spent:
      said.spent === null
        ? null
        : Object.fromEntries(said.spent.map(({ task, ...spent }) => [task, spent])),
    changes: said.changes,
    base: said.base,
    files: said.files,
    marks: Object.fromEntries(said.marks.map((one) => [one.path, one.mark])),
    where: said.where,
    notes: said.notes,
    retired: said.retired,
    schedules: said.schedules as ScheduleView[],
    intake: said.intake.map(requestOf),
    intakeEmpty: said.intakeEmpty,
    agent:
      said.agent === null
        ? null
        : {
            task: said.agent.task,
            route: said.agent.route,
            vitals: said.agent.vitals,
            offers: said.agent.offers as AgentOffers | null,
          },
  }
}

/**
 * A request there as a row of INTAKE here: what the side draws of it, and the
 * rest as nothing — a request opened from it is read from that machine's own
 * answer about it (`machine-there.ts`), never from this.
 */
function requestOf(one: SideAnswer['intake'][number]): InboxRow {
  return {
    ...one,
    grant: '',
    revision: '',
    taken: '',
    hash: '',
    ref: '',
    url: '',
    watch: '',
    schedule: '',
    mode: null,
    tasks: one.work.map((work) => work.task),
    attempts: 0,
    tries: 0,
    replies: 0,
    said: [],
    unsent: [],
  } as InboxRow
}

/** What this machine's window has of one project, for the far half of `/api/side` to answer. */
export interface SideFacts {
  ask: SideAsk
  /** The window's state there: its panes. */
  panes: readonly AgentPane[]
  looking: boolean
  spent: Readonly<Record<string, TaskSpent>> | null
  /** What the side reads of the checkout, as `hereOf` reads it. */
  here: Pick<Frame, 'files' | 'fileMarks' | 'where' | 'changes' | 'base'>
  notes: readonly NoteShown[]
  retired: readonly NoteShown[]
  schedules: readonly ScheduleView[]
  intake: readonly InboxRow[]
  intakeEmpty: { short: string; long: string }
  agent: SideThere['agent']
}

/** How many of a list go: the wire's own bound, so an answer is never refused for its length. */
function most<T>(list: readonly T[], at: number): T[] {
  return list.slice(0, at)
}

/**
 * The answer, out of what the window has: the project's panes, and the rest as
 * its own frame would hold it for that project. Paths are said as they are on
 * this machine — the route is an owner's — and nothing is looked at here.
 */
export function sideAnswerOf(facts: SideFacts): SideAnswer {
  const project = facts.ask.project
  const panes = most(
    facts.panes.filter((pane) => pane.project === project),
    400,
  )
  const ids = new Set(panes.map((pane) => pane.task))
  return {
    project,
    looking: facts.looking,
    panes: panes.map((pane) => ({
      task: pane.task,
      project: pane.project,
      name: pane.name,
      title: pane.title,
      ...(pane.intent === undefined ? {} : { intent: pane.intent }),
      branch: pane.branch,
      lane: pane.lane,
      state: pane.state,
      ...(pane.reason === undefined ? {} : { reason: pane.reason }),
      waiting: pane.waiting,
      approval: pane.approval,
      lanes: pane.lanes.map((lane) => ({ ...lane })),
      ...(pane.finished === undefined ? {} : { finished: pane.finished }),
      ...(pane.done === undefined ? {} : { done: pane.done }),
      ...(pane.by === undefined ? {} : { by: pane.by }),
      ...(pane.queued === undefined
        ? {}
        : {
            queued:
              pane.queued === null
                ? null
                : {
                    state: pane.queued.state,
                    after: [...pane.queued.after],
                    prompt: pane.queued.prompt,
                    touches: [...pane.queued.touches],
                    at: pane.queued.at,
                    ...(pane.queued.placed === undefined ? {} : { placed: pane.queued.placed }),
                  },
          }),
      ...(pane.waitsOn === undefined ? {} : { waitsOn: [...pane.waitsOn] }),
      ...(pane.effort === undefined ? {} : { effort: pane.effort }),
      ...(pane.servers === undefined ? {} : { servers: [...pane.servers] }),
      ...(pane.conflicts === undefined
        ? {}
        : {
            conflicts: pane.conflicts.map((one) => ({
              kind: one.kind,
              with: one.with,
              files: [...one.files],
            })),
          }),
    })) as SideAnswer['panes'],
    spent:
      facts.spent === null
        ? null
        : Object.entries(facts.spent)
            .filter(([task]) => ids.has(task))
            .map(([task, spent]) => ({ task, ...spent })),
    changes: facts.here.changes == null ? null : most(facts.here.changes, 2000),
    base: facts.here.base ?? null,
    files: facts.here.files == null ? null : most(facts.here.files, 5000),
    marks: most(
      Object.entries(facts.here.fileMarks ?? {}).map(([path, mark]) => ({ path, mark })),
      5000,
    ),
    where: facts.here.where ? (facts.here.where as SideAnswer['where']) : null,
    notes: most(facts.notes, 500) as SideAnswer['notes'],
    retired: most(facts.retired, 500) as SideAnswer['retired'],
    schedules: most(
      facts.schedules.filter((one) => one.project === project),
      200,
    ) as SideAnswer['schedules'],
    intake: most(
      facts.intake.filter((one) => one.project === project),
      400,
    ).map((one) => ({
      item: one.item,
      source: one.source,
      externalId: one.externalId,
      requester: one.requester,
      project: one.project,
      state: one.state,
      because: one.because,
      template: one.template,
      work: one.work.map((work) => ({ ...work })),
      at: one.at,
    })),
    intakeEmpty: facts.intakeEmpty,
    agent:
      facts.agent === null || !ids.has(facts.agent.task)
        ? null
        : {
            task: facts.agent.task,
            route: {
              harness: facts.agent.route.harness,
              model: facts.agent.route.model,
              thinking: facts.agent.route.thinking ?? null,
              provider: facts.agent.route.provider,
            },
            vitals: facts.agent.vitals ?? null,
            offers: facts.agent.offers as NonNullable<SideAnswer['agent']>['offers'],
          },
  }
}

/** The lane a pane there is drawn with: the terminal here that is it, or none yet. */
export const NO_LANE_THERE = 'there'

/**
 * The state and the frame the side and the pane are drawn from while you stand
 * in a project on another machine: that project, as if it were this machine's
 * — or null where you are standing here.
 *
 * Its panes are that machine's (`SideShown`), the agent in front of you is the
 * one you pressed there, and its lane is the terminal here that is it
 * (`Place.lane`), which the frame's screen already is. What is this window's
 * own — the folds, the scroll, the pointer, the panel — is kept, with what the
 * pointer is on read back into that machine's ids (`hereTarget`).
 */
export function seenThere(
  state: AppState,
  frame: Frame,
): { state: AppState; frame: Frame; place: Place } | null {
  const place = elsewhereOf(state)
  if (place === null) return null
  const found = placeIn(frame.machines, place)
  const answered =
    frame.side?.machine === place.machine && frame.side.project === place.project
      ? frame.side.there
      : null
  // A Tade there too old to answer for its side is drawn from what its
  // projection says — its agents, its queued work, its schedules — through
  // the same views, every other section as not looked at yet.
  const side = answered ?? (found?.project ? projected(found.machine, found.project) : null)
  const panes = side === null ? [] : lanedPanes(side, place.agent, place.lane)
  const focused =
    place.agent !== undefined && panes.some((pane) => pane.task === place.agent)
      ? place.agent
      : null
  const title = found?.project?.title
  const opened = state.schedule === null ? null : refOf(state.schedule)
  const seen: AppState = {
    ...state,
    panes,
    project: place.project,
    elsewhere: null,
    focused,
    titles: title ? { ...state.titles, [place.project]: title } : state.titles,
    schedule: opened?.machine === place.machine ? opened.id : null,
    hover: hereOf(state.hover, place.machine),
    pressed: hereOf(state.pressed, place.machine),
  }
  // What the agent in front runs on, as that machine's header says it — or,
  // from a Tade there too old to say, as its row in the projection does —
  // never this machine's own route, which is about agents here.
  const ran = found?.project?.agents.find((one) => one.id === focused)
  const agent =
    side?.agent?.task === focused && focused !== null
      ? side.agent
      : focused !== null
        ? {
            task: focused,
            route: { harness: ran?.harness ?? 'agent', model: ran?.model ?? null, provider: null },
            vitals: null,
            offers: null,
          }
        : null
  // Until a terminal here is the agent there, its lane is its screen as that
  // machine last read it (`wire/remote-agent.ts`), drawn where its lane is.
  const read =
    focused !== null && place.lane === undefined && frame.remoteScreen?.task === focused
      ? frame.remoteScreen
      : null
  const seenFrame: Frame = {
    ...frame,
    ...(read === null ? {} : { screen: read.lines.join('\n'), paneScreen: undefined }),
    looking: side === null ? true : side.looking,
    spend: frame.spend
      ? { ...frame.spend, byTask: side?.spent ?? {} }
      : side?.spent
        ? { tokens: 0, usd: 0, hasCost: false, byTask: side.spent }
        : undefined,
    changes: side?.changes ?? null,
    base: side?.base ?? null,
    files: side?.files ?? null,
    fileMarks: side?.marks ?? {},
    where: side?.where ?? null,
    notes: side?.notes ?? [],
    retiredNotes: side?.retired ?? [],
    schedules: side?.schedules ?? [],
    intake: side?.intake ?? [],
    intakeEmpty: side?.intakeEmpty ?? frame.intakeEmpty,
    lists: [],
    queuedThere: [],
    actions: null,
    route: agent?.route ?? frame.route,
    vitals: agent?.vitals ?? null,
    offers: agent?.offers ?? null,
  }
  return { state: seen, frame: seenFrame, place }
}

// What is derived here is drawn every frame, and a region is kept from the
// last frame only where what it read is the same (`view/last-frame.ts`): a
// side folded afresh each time, panes and all, is a sidebar drawn again from
// nothing on every frame a lane prints. So the same inputs hand back the same
// objects — keyed on what they are made of, which is never changed in place.

const PROJECTED = new WeakMap<Machine, WeakMap<RemoteProject, SideThere>>()

/** `fromProjection`, the same object for the same machine and project as folded. */
function projected(machine: Machine, project: RemoteProject): SideThere {
  const of = PROJECTED.get(machine) ?? new WeakMap<RemoteProject, SideThere>()
  PROJECTED.set(machine, of)
  const was = of.get(project)
  if (was !== undefined) return was
  const side = fromProjection(machine, project)
  of.set(project, side)
  return side
}

const LANED = new WeakMap<SideThere, { agent?: string; lane?: string; panes: AgentPane[] }>()

/** The side's panes, the agent in front with its lane here, the same array for the same three. */
function lanedPanes(side: SideThere, agent?: string, lane?: string): AgentPane[] {
  const was = LANED.get(side)
  if (was !== undefined && was.agent === agent && was.lane === lane) return was.panes
  const panes = side.panes.map((pane) => (pane.task === agent ? withLane(pane, lane) : pane))
  LANED.set(side, { agent, lane, panes })
  return panes
}

/** A pane there with the terminal here that is its agent as its lane. */
function withLane(pane: AgentPane, lane: string | undefined): AgentPane {
  const id = lane ?? NO_LANE_THERE
  const agent = pane.lanes.find((one) => one.kind === 'agent')
  const lanes = agent
    ? pane.lanes.map((one) => (one === agent ? { ...one, id } : one))
    : [{ id, kind: 'agent' }, ...pane.lanes]
  return { ...pane, lane: id, lanes }
}

function hereOf(target: Target | null, machine: string): Target | null {
  return target === null ? null : hereTarget(target, machine)
}

/** An id there, carried: `@machine␟id`. Empty stays empty. */
function carried(id: string, machine: string): string {
  return id === '' || refOf(id).machine !== null ? id : there(machine, id)
}

/** An id carried back: the id there, where it is this machine's. */
function uncarried(id: string, machine: string): string {
  const ref = refOf(id)
  return ref.machine === machine ? ref.id : id
}

/**
 * The actions whose name ends in the id of a task or a schedule there
 * (`close-task:<id>`): carried to that machine like a row's own id. The rest
 * name nothing of the project's and are this window's own.
 */
const ID_ACTIONS = [
  'close-task',
  'harness',
  'model',
  'thinking',
  'split',
  'checks-run',
  'schedule-open',
  'schedule-pause',
  'schedule-resume',
  'schedule-run',
  'schedule-remove',
  'schedule-hush',
  'queue-start',
  'queue-pause',
  'queue-resume',
  'queue-wait',
  'queue-drop',
  'queue-remove',
] as const

/**
 * The actions that mean the agent in front of you, and what each is for one
 * there: the card's answer to its approval, and opening its lane — which,
 * there, is a terminal here that is it.
 */
const FOCUSED_THERE: Readonly<Record<string, string>> = {
  approve: 'remote-allow',
  deny: 'remote-deny',
  'open-agent': 'remote-attach',
}
const FOCUSED_HERE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FOCUSED_THERE).map(([here, there]) => [there, here]),
)

function actionCarried(name: string, move: (id: string) => string, out: boolean): string {
  const focused = (out ? FOCUSED_THERE : FOCUSED_HERE)[name]
  if (focused !== undefined) return focused
  const cut = name.indexOf(':')
  if (cut < 0) return name
  const head = name.slice(0, cut)
  if (!(ID_ACTIONS as readonly string[]).includes(head)) return name
  return `${head}:${move(name.slice(cut + 1))}`
}

function subjectCarried(subject: MenuSubject, move: (id: string) => string): MenuSubject {
  switch (subject.kind) {
    case 'task':
    case 'harness':
    case 'account':
    case 'thinking':
    case 'lane':
      return { ...subject, task: move(subject.task) }
    case 'change':
      return subject.task === null ? subject : { ...subject, task: move(subject.task) }
    case 'schedule':
      return { ...subject, id: move(subject.id) }
    default:
      return subject
  }
}

function targetMoved(target: Target, move: (id: string) => string, out: boolean): Target {
  switch (target.kind) {
    case 'task':
    case 'task-menu':
    case 'pane-tab':
    case 'check':
    case 'lane':
      return { ...target, task: move(target.task) }
    case 'change':
      return target.task === null ? target : { ...target, task: move(target.task) }
    case 'action':
      return { ...target, name: actionCarried(target.name, move, out) }
    case 'menu':
      return { ...target, subject: subjectCarried(target.subject, move) }
    default:
      return target
  }
}

/** A request there is opened as that machine's (`remote-request:`), on a page that only reads. */
const OPEN_HERE = 'intake-open:'
const OPEN_THERE = 'remote-request:'

/** A target drawn from a project there, carried to that machine: what a press on it is for. */
export function thereTarget(target: Target, machine: string): Target {
  if (target.kind === 'action' && target.name.startsWith(OPEN_HERE)) {
    return { ...target, name: `${OPEN_THERE}${machine} ${target.name.slice(OPEN_HERE.length)}` }
  }
  return targetMoved(target, (id) => carried(id, machine), true)
}

/** A target carried to a machine, back as that machine's own drawing named it. */
export function hereTarget(target: Target, machine: string): Target {
  const opened = `${OPEN_THERE}${machine} `
  if (target.kind === 'action' && target.name.startsWith(opened)) {
    return { ...target, name: `${OPEN_HERE}${target.name.slice(opened.length)}` }
  }
  return targetMoved(target, (id) => uncarried(id, machine), false)
}

/** What each drawing was carried to, so a region handed back unchanged is carried once. */
const CARRIED = new WeakMap<Drawn, { machine: string; drawn: Drawn }>()

/**
 * A region drawn from a project there, with every target in it carried to
 * that machine (`thereTarget`): the rows are untouched — they are the rows a
 * project here would have — and only what a press on them is for moves.
 */
export function carriedTo(drawn: Drawn, machine: string): Drawn {
  const was = CARRIED.get(drawn)
  if (was?.machine === machine) return was.drawn
  const out: Drawn = {
    ...drawn,
    hits: drawn.hits.map((hit) => ({ ...hit, target: thereTarget(hit.target, machine) })),
  }
  CARRIED.set(drawn, { machine, drawn: out })
  return out
}

/**
 * What a machine's projection says of one of its projects, as the side would
 * have answered it: its agents and its queued work by their ids there, and its
 * schedules — and of its checkout and its notes nothing, which is unknown and
 * drawn as not looked at, never as empty.
 */
function fromProjection(machine: Machine, project: RemoteProject): SideThere {
  return {
    project: project.name,
    looking: !machine.heard,
    panes: project.agents.map((agent) =>
      agent.queued ? queuedOf(agent, project) : paneOf(agent, project),
    ),
    spent: null,
    changes: null,
    base: null,
    files: null,
    marks: {},
    where: null,
    notes: [],
    retired: [],
    schedules: (machine.detail.about?.schedules ?? [])
      .filter((one) => one.project === project.name)
      .map((one) => scheduleOf(one, machine.name)),
    intake: machine.detail.requests
      .filter((one) => one.project === project.name)
      .map((one) =>
        requestOf({
          item: one.item,
          source: one.source,
          externalId: one.externalId,
          requester: one.who ?? '',
          project: one.project,
          state: one.state,
          because: one.because,
          template: one.stamp,
          work: one.work.map((work) => ({ ...work, state: null })),
          at: one.at ?? 0,
        }),
      ),
    intakeEmpty: { short: 'none', long: `${machine.name} has handed this project nothing.` },
    agent: null,
  }
}

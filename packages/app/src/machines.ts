import { AGENT_MARKS, type AgentMark, printable } from '@tade/core'
import type { Held } from '@tade/remotes-core'
import { whereYouWere } from './layout.ts'
import type { AppState } from './model.ts'

// The other machines' projects, as the window draws them (REMOTE-TADE.md §9.4).
//
// A remote's Tade sends its away view's projection over the link
// (`Remotes.held`, `wire/remotes.ts`), and this is the one place that reads it
// for the window: a pure fold from what each link holds to the machines, their
// projects and their agents, in the shapes the top row, the side and the Spend
// page draw.
//
// **Everything in a projection was written on another machine**, and the link
// reads one for its shape and not field by field (`readSnapshot`): a task's
// title, its reason, a project's name — any of it can be anything, escape
// sequences included. So nothing here is handed on as it came. Every string is
// read as a string or not at all, reduced to text by core's one rule
// (`printable`), and bounded; every mark is one this Tade knows or `stopped`.
// The drawing never sees the projection itself, so a remote can never write
// into this machine's terminal. `test/machines.test.ts` holds a title full of
// escapes to that.
//
// **A remote that stopped answering is drawn from what it last said**, with
// when that was (`asOf`), never as nothing: an empty list reads as "nothing is
// running there" about a machine whose agents are working perfectly well.

/** How a machine's link stands, in the one word the window draws it by. */
export type MachineLink = 'linking' | 'live' | 'down' | 'ended'

/** One agent there, as its row is drawn here. */
export interface RemoteAgent {
  /** The remote's own id for it: what tells two rows apart, never drawn. */
  id: string
  name: string
  title: string | null
  /** The mark the remote drew beside it (its `markOf`), or `stopped` for one this Tade does not know. */
  mark: AgentMark
  /** What its project's tab counts it as: its mark, or queued work's own two. */
  counts: AgentMark | 'queued'
  /** It is queued work there, waiting to start. */
  queued: boolean
  /** `deriveState`'s clause, in the remote's words. */
  reason: string
  /** When it last moved, in **this** machine's clock. Null where the remote did not say. */
  movedAt: number | null
  /**
   * What an act on it must still find true there (the row's `rev`), echoed as
   * `was` and never read. Null where the remote sent none, which no act can
   * be made without.
   */
  rev: string | null
  /** The approval it is held on: the harness's id for it, which an answer names, and the tool's name. */
  approval: { id: string; tool: string } | null
  /** Whether somebody set it aside there. */
  parked: boolean
  /** Its own agent's lane, in the remote's one word: running, stopped and kept, or none. */
  lane: 'running' | 'stopped' | 'none'
  /** The verbs that machine says may be asked of it now (its `can`); nothing else is offered. */
  can: readonly string[]
}

export interface RemoteProject {
  name: string
  title: string | null
  agents: readonly RemoteAgent[]
  /** Tasks the remote holds and did not send, inside its own budget: said, never dropped. */
  more: number
}

/**
 * What a machine's agents spent today by **its** clock, as its projection
 * adds up. Its orchestrator's own turns are not on any task there, so they
 * are not in it, and `partial` is a remote that held back some of its tasks.
 */
export interface MachineSpend {
  usd: number
  usdExact: number
  usdEstimated: number
  usdListed: number
  usdOnPlan: number
  tokens: number
  hasCost: boolean
  partial: boolean
}

export interface Machine {
  /** What it is called here: its `remotes.<name>`, which this machine's config gave it. */
  name: string
  link: MachineLink
  /** The revision of its projection what is held is of, which an act echoes. Null before one. */
  rev: number | null
  /** Why it is down or signed out, as text. Null while it is up. */
  said: string | null
  /** When what is held was last known to be current, in this machine's clock. Null before anything. */
  asOf: number | null
  /** Whether it has ever said anything: rows to draw, link up or not. */
  heard: boolean
  projects: readonly RemoteProject[]
  spend: MachineSpend | null
}

/** Every machine the window draws: this one's name in a sentence, and the remotes in config order. */
export interface Machines {
  /** `this Mac`, `this machine`. */
  here: string
  remotes: readonly Machine[]
}

/** Where you are standing when it is on another machine: the remote, and its project there. */
export interface Place {
  machine: string
  project: string
  /** The agent there you are looking at, by its task id there, or none. */
  agent?: string
}

/** How long a name may be here; a title or a reason, a little longer. */
const NAME_MOST = 80
const SAID_MOST = 240

/**
 * How far this machine's clock is ahead of the remote's, from a projection
 * that has just arrived: its `fresh.at` is the remote's moment and `heardAt`
 * ours, set together when the frame was applied. Null where it cannot be told.
 *
 * Asked only when the projection itself is new — a heartbeat moves `heardAt`
 * and leaves `fresh.at`, so asking then would be asking about two moments
 * that were never the same one (`Remotes.facts` keeps the answer by projection).
 */
export function skewOf(held: Held): number | null {
  const at = Date.parse(stringIn(objectIn(held.projection)?.fresh, 'at') ?? '')
  if (held.heardAt === null || !Number.isFinite(at)) return null
  return held.heardAt - at
}

/** One remote, as what its link holds says it is now. `skew` is `skewOf`'s answer, or 0. */
export function machineOf(held: Held, skew: number): Machine {
  const link = held.link
  const word: MachineLink =
    link.kind === 'live' || link.kind === 'down' || link.kind === 'ended' ? link.kind : 'linking'
  const said = link.kind === 'down' || link.kind === 'ended' ? text(link.said, SAID_MOST) : null
  const projection = objectIn(held.projection)
  return {
    name: held.remote,
    link: word,
    rev: numberIn(objectIn(projection?.fresh), 'rev'),
    said: said === '' ? null : said,
    asOf: held.heardAt,
    heard: projection !== null,
    projects: projection === null ? [] : projectsIn(projection, skew),
    spend: projection === null ? null : spendIn(projection),
  }
}

/** A remote no link here has opened yet, or that no link here can reach. */
export function unheard(name: string, said: string | null): Machine {
  return {
    name,
    link: said === null ? 'linking' : 'down',
    rev: null,
    said,
    asOf: null,
    heard: false,
    projects: [],
    spend: null,
  }
}

function projectsIn(projection: Record<string, unknown>, skew: number): RemoteProject[] {
  const paused = new Set<string>()
  for (const row of listIn(projection.queue)) {
    const task = stringIn(row, 'task')
    if (task !== null && stringIn(objectIn(row.state), 'kind') === 'paused') paused.add(task)
  }
  const byName = new Map<string, { title: string | null; agents: RemoteAgent[]; more: number }>()
  const named = (name: string) => {
    const already = byName.get(name)
    if (already) return already
    const made = { title: null, agents: [], more: 0 }
    byName.set(name, made)
    return made
  }
  for (const row of listIn(projection.projects)) {
    // A closed project there is a row so a phone can open it again; it has
    // nothing in it to draw here.
    if (row.open === false) continue
    const name = text(row.name, NAME_MOST)
    if (name === '') continue
    const one = named(name)
    one.title = saidIn(row.title, NAME_MOST)
    const counts = objectIn(row.counts)
    const total = numberIn(counts, 'tasks')
    const shown = numberIn(counts, 'shown')
    if (total !== null && shown !== null) one.more = Math.max(0, total - shown)
  }
  for (const row of listIn(projection.tasks)) {
    const id = stringIn(row, 'id')
    const project = text(row.project, NAME_MOST)
    if (id === null || project === '') continue
    const agent = agentOf(row, id, paused.has(id), skew)
    if (agent !== null) named(project).agents.push(agent)
  }
  return [...byName].map(([name, one]) => ({ name, ...one }))
}

function agentOf(
  row: Record<string, unknown>,
  id: string,
  paused: boolean,
  skew: number,
): RemoteAgent | null {
  const name = text(row.name, NAME_MOST)
  if (name === '') return null
  const raw = stringIn(row, 'mark')
  const mark: AgentMark = AGENT_MARKS.find((one) => one === raw) ?? 'stopped'
  const queued = row.state === 'queued'
  const moved = Date.parse(stringIn(row, 'movedAt') ?? '')
  return {
    id: printable(id),
    name,
    title: saidIn(row.title, NAME_MOST),
    mark,
    // The local tab's rule (`projectMark`, `view/top.ts`): queued work that
    // wants a decision is a decision, set aside is parked, and the rest has
    // not started.
    counts: !queued || mark === 'needs-you' ? mark : paused ? 'parked' : 'queued',
    queued,
    reason: text(row.reason, SAID_MOST),
    movedAt: Number.isFinite(moved) ? moved + skew : null,
    // Echoed and compared there, never drawn: kept only where it is the short
    // token the protocol says it is, so an act carries nothing else back.
    rev: tokenIn(row, 'rev'),
    approval: approvalIn(row.approval),
    parked: row.parked === true,
    lane: LANES.find((one) => one === row.lane) ?? 'none',
    can: listIn(row.can).flatMap((one) => {
      const verb = tokenIn(one, 'verb')
      return verb === null ? [] : [verb]
    }),
  }
}

/** Its own agent's lane, in the words the protocol has for one. */
const LANES = ['running', 'stopped', 'none'] as const

/** An approval as a row carries one: an id to echo, and a tool's name to draw as text. */
function approvalIn(value: unknown): RemoteAgent['approval'] {
  const approval = objectIn(value)
  const id = stringIn(approval, 'id')
  const tool = text(approval?.tool, NAME_MOST)
  if (id === null || id === '' || id.length > 200 || !/^[\x21-\x7e]+$/.test(id)) return null
  return { id, tool: tool === '' ? 'a tool' : tool }
}

/** A short token the protocol echoes or names a verb by: printable, no spaces, bounded. Null otherwise. */
function tokenIn(value: unknown, key: string): string | null {
  const field = stringIn(value, key)
  return field !== null && /^[\x21-\x7e]{1,64}$/.test(field) ? field : null
}

function spendIn(projection: Record<string, unknown>): MachineSpend {
  const total: MachineSpend = {
    usd: 0,
    usdExact: 0,
    usdEstimated: 0,
    usdListed: 0,
    usdOnPlan: 0,
    tokens: 0,
    hasCost: false,
    partial: (numberIn(objectIn(objectIn(projection.pages)?.tasks), 'omitted') ?? 0) > 0,
  }
  for (const row of listIn(projection.tasks)) {
    const spend = objectIn(row.spend)
    if (spend === null) continue
    total.usd += numberIn(spend, 'usd') ?? 0
    total.usdExact += numberIn(spend, 'usdExact') ?? 0
    total.usdEstimated += numberIn(spend, 'usdEstimated') ?? 0
    total.usdListed += numberIn(spend, 'usdListed') ?? 0
    total.usdOnPlan += numberIn(spend, 'usdOnPlan') ?? 0
    total.tokens += numberIn(spend, 'tokens') ?? 0
    total.hasCost ||= spend.hasCost === true
  }
  return total
}

// ── An agent's screen there ──────────────────────────────────────────────────

/**
 * The screen of an agent on another machine, as its away view last answered
 * (`/api/agent/<project>/<task>`): read only while somebody here looks at it.
 */
export interface RemoteScreen {
  /** Its task there: what the answer was asked about. */
  task: string
  /** Its newest rows, oldest first, as text. Empty where `why` says. */
  lines: readonly string[]
  /** When that machine read them, in **this** machine's clock. Null where it did not say. */
  at: number | null
  /** Rows above these it did not send: a screen is sent, never its scrollback. */
  above: number
  /** Why there are no rows, in this window's words. Null where there are. */
  why: string | null
}

/** The most rows of one screen kept, and the widest a row is kept: the protocol's own bound, again. */
const SCREEN_MOST = { lines: 60, width: 240 }

/** What the away view says for having no rows to send (`SCREEN_WHY`), as this window says it. */
const SCREEN_SAYS: Readonly<Record<string, string>> = {
  'not granted': 'this machine may not read its screen there',
  'no agent': 'no agent is running there',
  'not read yet': 'reading its screen…',
  'could not read': 'its screen could not be read there',
  'not here': 'it is not on that machine any more',
}

/**
 * One answer about an agent there, read as a screen: every row reduced to
 * text (`printable` — an agent prints whatever it printed, escapes and all,
 * and that machine's cleaning is that machine's), bounded, and moved into
 * this clock by `skew`. Anything not shaped like an answer is a screen
 * that says so, never a throw.
 */
export function screenOf(task: string, answer: unknown, skew: number): RemoteScreen {
  const body = objectIn(answer)
  const screen = objectIn(body?.screen)
  if (screen === null) {
    const why = stringIn(body, 'why')
    return {
      task,
      lines: [],
      at: null,
      above: 0,
      why: (why === null ? null : SCREEN_SAYS[why]) ?? 'that machine answered with no screen',
    }
  }
  const rows = Array.isArray(screen.lines) ? screen.lines : []
  const lines = rows
    .slice(-SCREEN_MOST.lines)
    .map((row) => (typeof row === 'string' ? cut(printable(row), SCREEN_MOST.width) : ''))
  const at = Date.parse(stringIn(screen, 'at') ?? '')
  return {
    task,
    lines,
    at: Number.isFinite(at) ? at + skew : null,
    above: (numberIn(screen, 'above') ?? 0) + Math.max(0, rows.length - SCREEN_MOST.lines),
    why: null,
  }
}

/** A row cut to so many code points, its trailing blanks gone and its indent kept. */
function cut(row: string, most: number): string {
  const points = [...row]
  return (points.length <= most ? row : points.slice(0, most).join('')).trimEnd()
}

// ── Reading what another machine wrote ───────────────────────────────────────

function objectIn(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The objects in a list, and nothing else that was in it. */
function listIn(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((one) => {
    const row = objectIn(one)
    return row === null ? [] : [row]
  })
}

/** A string field as it was sent — for an id or a moment, which are never drawn as themselves. */
function stringIn(value: unknown, key: string): string | null {
  const field = objectIn(value)?.[key]
  return typeof field === 'string' ? field : null
}

function numberIn(value: Record<string, unknown> | null, key: string): number | null {
  const field = value?.[key]
  return typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : null
}

/** A string to draw: text only, trimmed, bounded. Anything that is not a string is nothing. */
function text(value: unknown, most: number): string {
  if (typeof value !== 'string') return ''
  const plain = printable(value).trim()
  const points = [...plain]
  return points.length <= most ? plain : `${points.slice(0, most - 1).join('')}…`
}

/** Free text the away protocol sends as `{ words, more }` (`said.ts`), to draw, or null. */
function saidIn(value: unknown, most: number): string | null {
  const said = objectIn(value)
  const words = text(said?.words, most)
  if (words === '') return null
  return said?.more === true && !words.endsWith('…') ? `${words}…` : words
}

// ── Standing there ───────────────────────────────────────────────────────────

/**
 * Stand in a project on another machine: the side lists its agents and the
 * pane says how it stands. Where you were here is kept, as leaving any project
 * keeps it (`whereYouWere`), and nothing here is in front — the keyboard goes
 * to the line you talk to Tade on, as in a project with no agents.
 */
export function goElsewhere(state: AppState, place: Place): AppState {
  return {
    ...state,
    spots: whereYouWere(state),
    elsewhere: place,
    focused: null,
    chose: true,
    paneScroll: 0,
    scroll: 0,
    across: 0,
    showingPlan: false,
    schedule: null,
  }
}

/**
 * The project on another machine in front of you, or null where it is this
 * machine's. An agent here in front is always in front — one that asked for
 * you and was raised, say — so standing elsewhere is never a second focus.
 */
export function elsewhereOf(state: AppState): Place | null {
  return state.focused === null ? state.elsewhere : null
}

/** A machine's link in the words its heading says it with, and the shorter ones for a narrow side. */
export function linkWords(
  machine: Machine,
  clock: (at: number) => string,
): { note: string; brief: string } {
  if (machine.link === 'live') return { note: `on ${machine.name}`, brief: machine.name }
  if (machine.link === 'ended')
    return { note: `✕ ${machine.name} · signed out`, brief: '✕ signed out' }
  if (machine.link === 'down' && machine.asOf !== null) {
    const at = clock(machine.asOf)
    return { note: `○ ${machine.name} · as of ${at}`, brief: `○ as of ${at}` }
  }
  if (machine.link === 'down') return { note: `○ ${machine.name} · down`, brief: '○ down' }
  return { note: `${machine.name} · linking…`, brief: 'linking…' }
}

/**
 * The mark a machine wears where its name is drawn: nothing while it is up,
 * because there is nothing to say; `◌` while it is first linking, `○` down
 * and `✕` signed out — each a shape of its own, for the reason every mark is.
 */
export function machineMark(machine: Machine): string {
  if (machine.link === 'live') return ''
  if (machine.link === 'linking') return '◌'
  return machine.link === 'down' ? '○' : '✕'
}

/**
 * How long ago an agent there last moved: from now while the link is up, and
 * from the moment it was last heard from while it is not — a row of ages that
 * kept counting with nothing behind them would be guessing.
 */
export function ageThere(agent: RemoteAgent, machine: Machine, now: number): number | null {
  if (agent.movedAt === null) return null
  const at = machine.link === 'live' ? now : (machine.asOf ?? now)
  return Math.max(0, at - agent.movedAt)
}

/** The machine and project a place names, as the frame has them now, or null where either has gone. */
export function placeIn(
  machines: Machines | undefined,
  place: Place,
): { machine: Machine; project: RemoteProject | null } | null {
  const machine = machines?.remotes.find((one) => one.name === place.machine)
  if (machine === undefined) return null
  return { machine, project: machine.projects.find((one) => one.name === place.project) ?? null }
}

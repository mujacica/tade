import { TaskState } from '@tade/core'
import type { Places } from './command.ts'
import { NOWHERE, type TurnIn, turnsOf } from './conversation.ts'
import { pathIn } from './fields.ts'
import type { TaskIn } from './input.ts'
import type {
  ActivityKind,
  ActivityRow,
  AgentOut,
  CONVERSATION_WHY,
  MomentsPage,
  SCREEN_WHY,
  TurnsPage,
} from './protocol.ts'
import { PROTOCOL_VERSION } from './protocol.ts'
import { has, type Reach, sees } from './reach.ts'
import { cleanScreen, SCREEN, type ScreenBudget } from './screen.ts'

// One agent, as a device that is looking at it may read it.
//
// **Read on a request, never on a beat.** A snapshot is every task for every
// device, and a screen on every row would be forty rows paid for twice a
// second for each of them; this is one task, asked for while somebody has its
// page open, and the window reads the lane behind it only while that is so
// (`packages/app/src/wire/web-lanes.ts`). So the projection here is a function
// of one task's row, what the window held of it, and the device's reach — and
// nothing is built for a device that is not asking.
//
// Three parts with two different rules:
//
// - **What it has been doing** is metadata: a kind out of a closed list
//   (`ACTIVITY_KINDS`) and a name a harness or Tade gave a thing — a tool, a
//   check — each held to looking like a name (`NAME`) before it is put in a
//   sentence. Never a tool's arguments, a command or a summary: `input.ts`'s
//   `ReasonIn` has the argument for why the one-line summary of a call never
//   reaches this package, and it holds here too. It needs no grant, for the
//   reason a task's state does not.
// - **What its screen shows** is the fourth kind of value (`screen.ts`) and
//   rides on `lanes`, which is off with every other grant off. Without it the
//   answer says `not granted` — and never *no agent*, which would be the page
//   blaming the work for the reader's own reach.
// - **What it was told and said, and every call it made** (`conversation`) is
//   the same kind of value on the same grant, out of its harness's own record
//   and cleaned by the screen's rule (`turnsOf`). Sent only when it moved
//   since the revision the page says it holds (`seen`).
//
// Pure: no `node:` import, no clock, nothing awaited.

/** One moment in a task's life, as the window read it out of the journal. */
export interface ActivityIn {
  /**
   * What tells one moment from another, and what the moments before it are
   * asked by (`momentsBefore`): **the window's own cursor, opaque here** —
   * only ever compared, sent, and handed back to the window that made it, as a
   * harness's record cursor is (`CURSOR`).
   */
  id: string
  at: number
  kind: ActivityKind
  /**
   * The name the moment is about, where it is about one: a tool's name, a
   * check's id, a state's word. Metadata **once it passes `NAME`**, and
   * dropped from the sentence where it does not — a harness names its tools,
   * and a name is not a place to carry a path.
   */
  what: string
  /** How it went, where that is a question — a turn, a check. Null where it is not. */
  ok: boolean | null
}

/** What the window holds of one task's lane. */
export type LaneIn =
  /** The rendered screen exactly as the driver handed it over. Untrusted. */
  | { kind: 'read'; text: string; at: number }
  | { kind: 'none'; why: Exclude<(typeof SCREEN_WHY)[number], 'not granted' | 'not here'> }

/**
 * What the window holds of one agent's conversation, out of its harness's own
 * record. Untrusted, like the screen: `turnsOf` is what cleans it.
 */
export type ConversationIn =
  | {
      kind: 'read'
      /** The newest turns, oldest first. */
      turns: readonly TurnIn[]
      /**
       * Where the turns before these end in its record — the harness's own
       * cursor, handed back as `before` for the page before — or null where
       * these reach its beginning.
       */
      before: string | null
      /** Moves exactly when the turns did, so a page that has these is sent nothing. */
      rev: string
    }
  | { kind: 'none'; why: Exclude<(typeof CONVERSATION_WHY)[number], 'not granted'> }

/** Everything the window hands over about one agent. */
export interface AgentIn {
  /** Its newest moments, newest first, as many as the window held of them. */
  activity: readonly ActivityIn[]
  /**
   * The window's cursor the moments before these are read from
   * (`momentsBefore`), or null where these reach its first.
   */
  earlier: string | null
  lane: LaneIn
  /** Its conversation as last read. Absent is not read yet. */
  conversation?: ConversationIn
  /**
   * Every value the window knows to be a key: the config's, the variables
   * they are read from, and the window's own environment's — which is the
   * environment every agent inherits. Taken off the screen exactly.
   */
  known: readonly string[]
  /**
   * Where a path in a call's brief is shortened to (`briefOut`): where the
   * task works, Tade's home and the home directory — the conversation with
   * Tade's own rule. Absent, every path is its last name.
   */
  places?: Places
}

/** How much of one agent an answer carries. */
export interface AgentBudget extends ScreenBudget {
  /**
   * Moments of activity, newest first: the newest stretch, and the page reads
   * the ones before as somebody scrolls down its timeline (`momentsBefore`),
   * a stretch of `MOMENTS` at a time, to its first.
   */
  activity: number
}

export const AGENT: AgentBudget = { ...SCREEN, activity: 40 }

/** How many moments one read further back brings. */
export const MOMENTS = 80

/**
 * What a name has to look like to be put in one of Tade's sentences.
 *
 * A tool (`Bash`, `mcp__tade__checks_run`), a check (`pre-commit`), a state
 * word. Not starting with a separator or a `~`, and never a machine path by
 * `withoutPaths`' own rule, so a harness that one day names a tool after the
 * file it came from does not put that file on a phone.
 */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:@/-]{0,63}$/

const named = (what: string): string => (NAME.test(what) && pathIn(what) === null ? what : '')

const STATES = new Set<string>(TaskState.options)

/** One moment, as Tade says it — or null for one there is nothing honest to say about. */
export function activitySaid(one: Omit<ActivityIn, 'id'>): string | null {
  const name = named(one.what)
  const tool = name === '' ? 'a tool' : name
  switch (one.kind) {
    case 'made':
      return 'was made'
    case 'state':
      return STATES.has(one.what) ? `is ${one.what}` : null
    case 'started':
      return 'its agent started'
    case 'stopped':
      return 'its agent stopped'
    case 'turn':
      return one.ok === false ? 'a turn ended without finishing' : 'finished a turn'
    case 'used':
      return `used ${tool}`
    case 'asked':
      return `asked to use ${tool}`
    case 'allowed':
      return `was let use ${tool}`
    case 'refused':
      return `was refused ${tool}`
    case 'checked':
      if (name === '') return null
      return `${name} ${one.ok === true ? 'passed' : one.ok === false ? 'failed' : 'ran'}`
    case 'committed':
      return 'committed'
    case 'finished':
      return 'was finished'
    case 'told':
      return 'was told more about the work'
    case 'failed':
      return 'stopped on an error'
    default:
      return null
  }
}

/**
 * One agent, for one device, as of what the window held.
 *
 * `held` is null where the window holds nothing about the task — a task that
 * is not in the world, or a window that has not looked yet — which is
 * answered as *not read yet* rather than as an empty screen.
 */
export function agentOf(
  reach: Reach,
  tasks: readonly TaskIn[],
  task: string,
  held: AgentIn | null,
  budget: AgentBudget = AGENT,
  seen: string | null = null,
): AgentOut {
  const row = tasks.find((one) => one.id === task)
  if (row === undefined || !sees(reach, row.project)) {
    // **One answer for a task that is not there and one this device may not
    // read**, for the reason a deep link to either is the same bytes: telling
    // them apart would be a way of finding out which projects exist.
    return {
      v: PROTOCOL_VERSION,
      task,
      here: false,
      activity: [],
      earlier: null,
      screen: null,
      why: 'not here',
      conversation: null,
      unread: null,
    }
  }
  const { activity, earlier } = rowsOf(held?.activity ?? [], held?.earlier ?? null, budget.activity)
  const base = { v: PROTOCOL_VERSION, task, here: true, activity, earlier } as const
  if (!has(reach, 'lanes')) {
    return { ...base, screen: null, why: 'not granted', conversation: null, unread: 'not granted' }
  }
  const talked = conversationOut(held?.conversation, held?.known ?? [], seen, held?.places)
  // Nothing held and nothing running is *no agent*; nothing held and something
  // running is a window that has not read it yet, which the next beat answers.
  const idle = row.agents === 0 && row.lanes === 0
  const lane = held?.lane ?? { kind: 'none', why: idle ? 'no agent' : 'not read yet' }
  if (lane.kind === 'none') return { ...base, screen: null, why: lane.why, ...talked }
  const clean = cleanScreen(lane.text, held?.known ?? [], budget)
  return {
    ...base,
    screen: {
      lines: clean.lines,
      at: new Date(lane.at).toISOString(),
      above: clean.above,
      cut: clean.cut,
      taken: clean.taken,
    },
    why: null,
    ...talked,
  }
}

/**
 * Moments as a device is sent them, at most `most`, and the cursor the ones
 * before are read by: the last one looked at where the budget stopped, else
 * the one the window gave. A cursor that does not look like one is not carried
 * (`CURSOR`), and a moment whose id does not is not sent.
 */
function rowsOf(
  held: readonly ActivityIn[],
  before: string | null,
  most: number,
): { activity: ActivityRow[]; earlier: string | null } {
  const activity: ActivityRow[] = []
  let earlier = before
  for (const [at, one] of held.entries()) {
    if (activity.length >= most) {
      earlier = held[at - 1]?.id ?? earlier
      break
    }
    const said = activitySaid(one)
    if (said !== null && CURSOR.test(one.id)) {
      activity.push({ id: one.id, at: new Date(one.at).toISOString(), kind: one.kind, said })
    }
  }
  return { activity, earlier: cursorOut(earlier) }
}

/** What the window read of a task's moments before a cursor, or why it could not. */
export type MomentsIn = { activity: readonly ActivityIn[]; earlier: string | null } | 'unread'

/**
 * One agent's moments before a cursor its page holds, as
 * `GET /api/agent/:project/:task/moments?before=` answers them: within this
 * device's reach and on no grant, as its newest moments are — Tade's own
 * sentences about metadata — newest first, to its first moment.
 */
export function momentsBefore(task: string, here: boolean, read: MomentsIn | null): MomentsPage {
  const none = (why: MomentsPage['why']): MomentsPage => ({
    v: PROTOCOL_VERSION,
    task,
    activity: [],
    earlier: null,
    why,
  })
  if (!here) return none('not here')
  if (read === null) return none(null)
  if (read === 'unread') return none('unread')
  const rows = rowsOf(read.activity, read.earlier, Number.POSITIVE_INFINITY)
  return { v: PROTOCOL_VERSION, task, ...rows, why: null }
}

/**
 * An agent's conversation as one device is sent it: cleaned, or — where the
 * device said it already holds this one (`seen`) — its revision and no turns,
 * which is what keeps a page that asks every two seconds from being sent forty
 * turns every two seconds.
 */
function conversationOut(
  held: ConversationIn | undefined,
  known: readonly string[],
  seen: string | null,
  places: Places = NOWHERE,
): Pick<AgentOut, 'conversation' | 'unread'> {
  const talk = held ?? { kind: 'none', why: 'not read yet' }
  if (talk.kind === 'none') return { conversation: null, unread: talk.why }
  const before = cursorOut(talk.before)
  if (seen === talk.rev) {
    return { conversation: { rev: talk.rev, turns: null, before, taken: 0 }, unread: null }
  }
  const clean = turnsOf(talk.turns, known, places)
  return {
    conversation: { rev: talk.rev, turns: clean.turns, before, taken: clean.taken },
    unread: null,
  }
}

/**
 * What a record's cursor has to look like to leave the machine, or be asked
 * with: a harness's is a byte offset into its record (`historyIn`), and
 * anything else is answered as the beginning rather than carried.
 */
export const CURSOR = /^\d{1,15}$/

const cursorOut = (cursor: string | null): string | null =>
  cursor !== null && CURSOR.test(cursor) ? cursor : null

/** What the window read of an agent's record before a cursor, or why it could not. */
export type EarlierIn = { turns: readonly TurnIn[]; before: string | null } | 'unread'

/**
 * The turns before a cursor, as `GET /api/agent/:project/:task/earlier`
 * answers them: within this device's reach and under `lanes`, as its
 * conversation is, each whole and cleaned by the same rule.
 */
export function turnsBefore(
  task: string,
  here: boolean,
  reach: Reach,
  read: EarlierIn | null,
  known: readonly string[],
  places: Places = NOWHERE,
): TurnsPage {
  const none = (why: TurnsPage['why']): TurnsPage => ({
    v: PROTOCOL_VERSION,
    task,
    turns: [],
    before: null,
    taken: 0,
    why,
  })
  if (!here) return none('not here')
  if (!has(reach, 'lanes')) return none('not granted')
  if (read === null || read === 'unread') return none('unread')
  const clean = turnsOf(read.turns, known, places)
  return {
    v: PROTOCOL_VERSION,
    task,
    turns: clean.turns,
    before: cursorOut(read.before),
    taken: clean.taken,
    why: null,
  }
}

import { TaskState } from '@tade/core'
import { pathIn } from './fields.ts'
import type { TaskIn } from './input.ts'
import type { ActivityKind, ActivityRow, AgentOut, SCREEN_WHY } from './protocol.ts'
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
// Two halves with two different rules:
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
//
// Pure: no `node:` import, no clock, nothing awaited.

/** One moment in a task's life, as the window read it out of the journal. */
export interface ActivityIn {
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

/** Everything the window hands over about one agent. */
export interface AgentIn {
  /** Newest first, already bounded by the window to `activity` and one more. */
  activity: readonly ActivityIn[]
  lane: LaneIn
  /**
   * Every value the window knows to be a key: the config's, the variables
   * they are read from, and the window's own environment's — which is the
   * environment every agent inherits. Taken off the screen exactly.
   */
  known: readonly string[]
}

/** How much of one agent an answer carries. */
export interface AgentBudget extends ScreenBudget {
  /** Moments of activity, newest first. */
  activity: number
}

export const AGENT: AgentBudget = { ...SCREEN, activity: 30 }

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
export function activitySaid(one: ActivityIn): string | null {
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
      more: false,
      screen: null,
      why: 'not here',
    }
  }
  const activity: ActivityRow[] = []
  for (const one of held?.activity ?? []) {
    if (activity.length >= budget.activity) break
    const said = activitySaid(one)
    if (said !== null) activity.push({ at: new Date(one.at).toISOString(), kind: one.kind, said })
  }
  const more = (held?.activity.length ?? 0) > activity.length
  const base = { v: PROTOCOL_VERSION, task, here: true, activity, more } as const
  if (!has(reach, 'lanes')) return { ...base, screen: null, why: 'not granted' }
  // Nothing held and nothing running is *no agent*; nothing held and something
  // running is a window that has not read it yet, which the next beat answers.
  const idle = row.agents === 0 && row.lanes === 0
  const lane = held?.lane ?? { kind: 'none', why: idle ? 'no agent' : 'not read yet' }
  if (lane.kind === 'none') return { ...base, screen: null, why: lane.why }
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
  }
}

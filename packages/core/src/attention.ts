import { CHATS, isChatTask } from './chat.ts'
import type { TadeEvent } from './events.ts'

// What is worth interrupting you for.
//
// Agents produce orders of magnitude more events than anyone can absorb
// through an earbud, so this decides which of them reach which surface, and
// how loudly. Pure, like the state machine: no I/O, no clock reads, no async.
//
// Channels only ever move down. Nothing here can make something louder than
// its urgency earned, which is what stops a chatty agent from shouting.

export const Channel = { speak: 'speak', earcon: 'earcon', silent: 'silent' } as const
export type Channel = (typeof Channel)[keyof typeof Channel]

const LOUDNESS: Record<Channel, number> = { speak: 2, earcon: 1, silent: 0 }

/**
 * Where an interruption would land.
 *
 * `push` is a phone that is not in the room, and it is a surface here rather
 * than a rule of its own so that the budget, the quiet hours and the presence
 * window are read out of the one table every surface is read out of. What is
 * *different* about it — that a notification nobody is there to read is kept
 * until somebody swipes it — is in its row below and in `@tade/web`'s
 * `noticed.ts`, never in a second copy of this decision.
 */
export type Surface = 'voice' | 'watch' | 'tui' | 'push'

export interface AttentionSettings {
  /** The most this surface will ever do. */
  ceiling: Channel
  /** Spoken items per hour. Beyond it, things wait for the next summary. */
  budget: number
  /** Local quiet hours. Null disables them. */
  quiet: { from: number; to: number } | null
  /** While you're typing in a task's own lane, drop that task to earcons. */
  focusWindowMs: number
}

/**
 * Read quiet hours written the way a person writes them: `22:00-08:00`.
 *
 * Only the hour is kept, because a spoken interruption at 21:58 and one at
 * 22:00 are the same interruption, and a policy that pretends to minute
 * precision invites people to tune it instead of trusting it. Anything
 * unreadable means no quiet hours rather than an error: it is a preference,
 * not a boundary, and nobody should be unable to open the window over one.
 */
export function parseQuietHours(
  text: string | null | undefined,
): { from: number; to: number } | null {
  if (!text) return null
  const found = /^\s*(\d{1,2})(?::\d{2})?\s*-\s*(\d{1,2})(?::\d{2})?\s*$/.exec(text)
  const from = Number(found?.[1])
  const to = Number(found?.[2])
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > 23 || to > 23) return null
  // Equal bounds would mean either always or never; neither is what anybody
  // means by writing the same hour twice.
  return from === to ? null : { from, to }
}

export const DEFAULT_ATTENTION: Record<Surface, AttentionSettings> = {
  voice: { ceiling: 'speak', budget: 6, quiet: { from: 22, to: 8 }, focusWindowMs: 30_000 },
  watch: { ceiling: 'speak', budget: 12, quiet: null, focusWindowMs: 30_000 },
  // A screen you are looking at should never talk to you.
  tui: { ceiling: 'silent', budget: 0, quiet: null, focusWindowMs: 0 },
  // **A lower budget than voice, and that is not timidity.** A sentence that
  // was spoken is gone; a notification is kept until somebody swipes it, so
  // six an hour is six things to clear rather than six things that went by.
  // Quiet hours are voice's, because the two interrupt the same evening — and
  // the presence window is wider: a phone is for somebody who is not here, so
  // *here at all* is the question rather than which lane has their attention
  // (`noticed.ts` has the argument).
  push: { ceiling: 'speak', budget: 4, quiet: { from: 22, to: 8 }, focusWindowMs: 120_000 },
}

/**
 * The settings for one surface, with the two halves a person writes put over
 * the top.
 *
 * **One spelling of the overlay, because the two halves are facts about the
 * person rather than about the surface.** `surfaces.voice.attention` is where
 * quiet hours and the hourly budget are written — voice was first and the keys
 * stayed where they were — and they mean the same thing to a phone in another
 * room as they do to an earbud: *not between these hours*, and *not more than
 * this many times*. A second copy of that reading, with its own fallbacks, is
 * exactly the drift this file is kept in one piece to prevent.
 *
 * Anything unwritten falls back to the surface's own row, which is why `push`
 * keeps its lower budget and its wider presence window unless somebody says
 * otherwise.
 */
export function attentionFor(
  surface: Surface,
  written: { budget?: number | undefined; quiet?: string | undefined } = {},
): AttentionSettings {
  const own = DEFAULT_ATTENTION[surface]
  return {
    ...own,
    ...(written.budget === undefined ? {} : { budget: written.budget }),
    quiet: parseQuietHours(written.quiet) ?? own.quiet,
  }
}

export interface AttentionContext {
  now: number
  surface: Surface
  /** How much has been spoken in the last hour, for the budget. */
  spokenInLastHour: number
  /** The task whose lane has your attention. */
  focusedTask?: string | null
  /** When you last typed in it. */
  lastKeyboardInputAt?: number | null
  /**
   * Local hour, 0–23. Passed in rather than derived, so the same inputs give
   * the same answer on every machine.
   */
  localHour?: number
}

export interface AttentionDecision {
  channel: Channel
  /** Why it came out this way: for the journal, and for tuning this later. */
  reason: string
}

/** Task states worth saying out loud when a task reaches them. */
const SPOKEN_STATES = new Set(['blocked', 'review', 'failed'])

export function decideAttention(
  event: TadeEvent,
  context: AttentionContext,
  settings: AttentionSettings = DEFAULT_ATTENTION[context.surface],
): AttentionDecision {
  let channel = baseChannel(event)
  let reason = baseReason(event)

  const lower = (next: Channel, why: string) => {
    if (LOUDNESS[next] < LOUDNESS[channel]) {
      channel = next
      reason = why
    }
  }

  lower(settings.ceiling, `${context.surface} never goes above ${settings.ceiling}`)

  if (channel === Channel.speak && isQuiet(context, settings)) {
    lower(Channel.earcon, 'quiet hours')
  }
  if (channel === Channel.speak && isFocused(event, context, settings)) {
    lower(Channel.earcon, 'you are at the keyboard')
  }
  if (channel === Channel.speak && context.spokenInLastHour >= settings.budget) {
    lower(Channel.earcon, `hourly budget of ${settings.budget} reached`)
  }

  return { channel, reason }
}

/**
 * Money is worth saying out loud.
 *
 * A warning that a project is near what it may spend today is the one kind of
 * `warning` nobody should be able to miss: an earcon says "something
 * happened", and by the time you go and look the budget is spent. Everything
 * else about a warning is ordinary.
 */
function aboutSpending(event: TadeEvent): boolean {
  return event.type === 'warning' && String(event.detail.message ?? '').includes('near its budget')
}

function baseChannel(event: TadeEvent): Channel {
  if (event.urgency === 'blocking') return Channel.speak
  if (aboutSpending(event)) return Channel.speak
  if (event.type === 'state_change' && SPOKEN_STATES.has(String(event.detail.state))) {
    return Channel.speak
  }
  if (event.urgency === 'notable') return Channel.earcon
  return Channel.silent
}

function baseReason(event: TadeEvent): string {
  if (event.urgency === 'blocking') return 'waiting on you'
  if (aboutSpending(event)) return 'close to what it may spend today'
  if (event.type === 'state_change' && SPOKEN_STATES.has(String(event.detail.state))) {
    return `task is ${String(event.detail.state)}`
  }
  if (event.urgency === 'notable') return 'worth knowing'
  return 'routine'
}

function isQuiet(context: AttentionContext, settings: AttentionSettings): boolean {
  return inQuietHours(settings.quiet, context.localHour ?? new Date(context.now).getHours())
}

/**
 * Whether an hour is inside somebody's quiet hours.
 *
 * Exported because a second surface asks it — a notification is held back by
 * the same evening a spoken sentence is — and the wrap over midnight is the
 * part a second implementation gets wrong. `isQuiet` above is its one other
 * caller, so there is one rule rather than one rule and a copy.
 */
export function inQuietHours(quiet: { from: number; to: number } | null, hour: number): boolean {
  if (!quiet) return false
  // Quiet hours normally wrap midnight.
  return quiet.from <= quiet.to
    ? hour >= quiet.from && hour < quiet.to
    : hour >= quiet.from || hour < quiet.to
}

function isFocused(
  event: TadeEvent,
  context: AttentionContext,
  settings: AttentionSettings,
): boolean {
  if (!context.focusedTask || context.focusedTask !== event.task) return false
  if (context.lastKeyboardInputAt === null || context.lastKeyboardInputAt === undefined)
    return false
  return context.now - context.lastKeyboardInputAt <= settings.focusWindowMs
}

/**
 * Everything that was held back, collapsed into one thing to say. Three
 * announcements played back to back is how people turn a feature off.
 */
export function summarise(events: TadeEvent[]): string {
  if (events.length === 0) return ''
  const byTask = new Map<string, TadeEvent[]>()
  for (const event of events) {
    const key = event.task ?? 'elsewhere'
    byTask.set(key, [...(byTask.get(key) ?? []), event])
  }
  const clauses = [...byTask.entries()].map(([task, group]) => {
    const worst = [...group].sort((a, b) => LOUDNESS[baseChannel(b)] - LOUDNESS[baseChannel(a)])[0]!
    // A task's own slug is the name somebody knows it by; a chat's last
    // segment is a number, and "1 finished" names nothing anybody can place.
    const last = task.split('/').at(-1)
    const name = task === 'elsewhere' ? 'something' : isChatTask(task) ? `${CHATS} ${last}` : last
    return `${name} ${describeEvent(worst)}`
  })
  const count = events.length
  const lead = count === 1 ? 'One thing happened' : `${count} things happened`
  return `${lead}. ${joinClauses(clauses)}.`
}

/** One event, said the way you would say it out loud. */
export function describeEvent(event: TadeEvent): string {
  switch (event.type) {
    case 'permission_request':
      return `is waiting on ${event.detail.summary ?? 'a decision'}`
    case 'failed':
      return 'failed'
    case 'turn_done':
      return 'finished'
    case 'state_change':
      return `is ${String(event.detail.state ?? 'changed')}`
    case 'run_started':
      return 'started'
    case 'agent_continued':
      return 'was told to carry on after the machine slept'
    default:
      return event.type.replace(/_/g, ' ')
  }
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0]!
  return `${clauses.slice(0, -1).join(', ')} and ${clauses.at(-1)}`
}

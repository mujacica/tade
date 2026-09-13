import type { WilcoEvent } from './events.ts'

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

export type Surface = 'voice' | 'watch' | 'tui'

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
  event: WilcoEvent,
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

function baseChannel(event: WilcoEvent): Channel {
  if (event.urgency === 'blocking') return Channel.speak
  if (event.type === 'state_change' && SPOKEN_STATES.has(String(event.detail.state))) {
    return Channel.speak
  }
  if (event.urgency === 'notable') return Channel.earcon
  return Channel.silent
}

function baseReason(event: WilcoEvent): string {
  if (event.urgency === 'blocking') return 'waiting on you'
  if (event.type === 'state_change' && SPOKEN_STATES.has(String(event.detail.state))) {
    return `task is ${String(event.detail.state)}`
  }
  if (event.urgency === 'notable') return 'worth knowing'
  return 'routine'
}

function isQuiet(context: AttentionContext, settings: AttentionSettings): boolean {
  if (!settings.quiet) return false
  const hour = context.localHour ?? new Date(context.now).getHours()
  const { from, to } = settings.quiet
  // Quiet hours normally wrap midnight.
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to
}

function isFocused(
  event: WilcoEvent,
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
export function summarise(events: WilcoEvent[]): string {
  if (events.length === 0) return ''
  const byTask = new Map<string, WilcoEvent[]>()
  for (const event of events) {
    const key = event.task ?? 'elsewhere'
    byTask.set(key, [...(byTask.get(key) ?? []), event])
  }
  const clauses = [...byTask.entries()].map(([task, group]) => {
    const worst = [...group].sort((a, b) => LOUDNESS[baseChannel(b)] - LOUDNESS[baseChannel(a)])[0]!
    const name = task === 'elsewhere' ? 'something' : task.split('/').at(-1)
    return `${name} ${describeEvent(worst)}`
  })
  const count = events.length
  const lead = count === 1 ? 'One thing happened' : `${count} things happened`
  return `${lead}. ${joinClauses(clauses)}.`
}

/** One event, said the way you would say it out loud. */
export function describeEvent(event: WilcoEvent): string {
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
    default:
      return event.type.replace(/_/g, ' ')
  }
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0]!
  return `${clauses.slice(0, -1).join(', ')} and ${clauses.at(-1)}`
}

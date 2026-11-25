import type { TadeEvent } from './events.ts'

// Which of the person's machines are up, and which are not, as this machine
// has seen them: the shape every machine draws "mac: closed 14:02" from, and
// the one later sharing builds on rather than inventing again.
//
// **Transitions, written by whoever saw them.** A machine's state is a
// `machine_seen` line in the journal of the machine that saw it change, and
// only on a change — never a sample per beat, for `remote_linked`'s reason.
// Two ways of seeing one:
//
// - `to`: a machine this one links to (`remotes.<name>`). Its link is the
//   evidence: up while the stream is live, `closed` where it said goodbye as
//   its Tade closed (the `closing` notice every stream is sent), `lost` where
//   it went with no word.
// - `from`: a machine that links to this one, as an owner device. Its link
//   beats here every few seconds while its window is open (`/api/seen`), says
//   goodbye as that window quits, and says on waking that it had been asleep;
//   past `LOST_AFTER_MS` of nothing with no goodbye it is `lost` — which this
//   machine writes, because the machine that went silent cannot.
//
// **A sleep is said when it is over.** Nothing on a laptop tells a program the
// lid is closing in time to say so — the wake is the one of the two that is
// free to notice (`sleep.ts`) — so a machine that slept is `lost` while it is
// away, and on waking says when it went: the line it causes is `asleep` with
// that moment, followed by `up`. Read back, the record says what happened;
// read live, it never claimed to know more than it did.
//
// Pure: events in, states out. No clock reads, no I/O.

/** What a machine is, as seen: its link up, asleep, its Tade closed, or gone without a word. */
export const MACHINE_STATES = ['up', 'asleep', 'closed', 'lost'] as const
export type MachineState = (typeof MACHINE_STATES)[number]

/** `to`: a machine this one links to. `from`: one that links to this one. */
export const MACHINE_WAYS = ['to', 'from'] as const
export type MachineWay = (typeof MACHINE_WAYS)[number]

/**
 * How long a machine that links here may say nothing before it is `lost`: one
 * missed beat of its link and the away view's own slack (`STALE_AFTER_MS`,
 * which a test holds this to). Its link beats every `SEEN_EVERY_MS`.
 */
export const LOST_AFTER_MS = 20_000

/** How often a link says its machine is still up, while its window is open. */
export const SEEN_EVERY_MS = 10_000

/** The longest ago a machine may say it went to sleep: a week, so a wrong clock cannot write a year. */
export const SLEPT_MOST_MS = 7 * 86_400_000

/** One machine as last seen, by one way. */
export interface MachineSeen {
  /** Its name here: `remotes.<name>` for `to`; for `from`, what it last said it is called, else the label its link paired with. */
  machine: string
  way: MachineWay
  state: MachineState
  /** When this machine saw it change, in this machine's clock. */
  at: number
  /**
   * Since when, where that is not `at`: the moment a machine that slept says it
   * went, in this machine's clock. Null where the state began when it was seen.
   */
  since: number | null
}

/** Whether a word out of the journal is a state. A line is a line somebody wrote. */
export function machineStateOf(value: unknown): MachineState | null {
  return typeof value === 'string' && (MACHINE_STATES as readonly string[]).includes(value)
    ? (value as MachineState)
    : null
}

/** The `machine_seen` line's detail for one change. */
export function seenDetail(seen: MachineSeen): Record<string, string> {
  return {
    machine: seen.machine,
    way: seen.way,
    state: seen.state,
    ...(seen.since === null ? {} : { since: new Date(seen.since).toISOString() }),
  }
}

/**
 * Every machine as last seen, each way, out of the journal: one entry per
 * machine and way, in the order each was first seen. A line that is not one
 * (an unknown state, no name) is skipped, never guessed at. A line that says
 * `was` is a machine that links here saying a name of its own: what it was
 * called until then is forgotten, never drawn as a second machine gone lost.
 */
export function machinesSeenFrom(events: readonly TadeEvent[]): MachineSeen[] {
  const last = new Map<string, MachineSeen>()
  for (const event of events) {
    if (event.type !== 'machine_seen') continue
    const seen = seenOf(event)
    if (seen === null) continue
    const was = event.detail.was
    if (seen.way === 'from' && typeof was === 'string' && was !== seen.machine) {
      last.delete(`from ${was}`)
    }
    const key = `${seen.way} ${seen.machine}`
    // Re-set keeps the first-seen order a Map already has.
    last.set(key, seen)
  }
  return [...last.values()]
}

function seenOf(event: TadeEvent): MachineSeen | null {
  const { machine, way, state, since } = event.detail
  const read = machineStateOf(state)
  if (typeof machine !== 'string' || machine === '' || read === null) return null
  if (way !== 'to' && way !== 'from') return null
  const at = Date.parse(event.ts)
  if (!Number.isFinite(at)) return null
  const went = typeof since === 'string' ? Date.parse(since) : Number.NaN
  return { machine, way, state: read, at, since: Number.isFinite(went) ? went : null }
}

/**
 * A machine as said wherever one is drawn or told: `closed 14:02`, `lost 14:02
 * — no goodbye: asleep, or off the network`, `up since 14:02`. `clock` draws a
 * moment in this machine's time.
 */
export function seenSaid(
  seen: Pick<MachineSeen, 'state' | 'at' | 'since'>,
  clock: (at: number) => string,
): string {
  const from = clock(seen.since ?? seen.at)
  if (seen.state === 'up') return `up since ${from}`
  if (seen.state === 'closed') return `closed ${from}, said goodbye`
  if (seen.state === 'asleep') return `asleep since ${from}`
  return `lost ${from} — no goodbye: asleep, or off the network`
}

// ── A machine that links here ────────────────────────────────────────────────

/** What a machine that links here said of itself, as its link carries it (`/api/seen`). */
export type SeenWord =
  | { state: 'up'; slept: number | null }
  | { state: 'asleep'; slept: number | null }
  | { state: 'closed' }

/** How one machine that links here stands, as the window holds it between lines. */
export interface Inbound {
  state: MachineState
  /** When it was last heard from, in this machine's clock. */
  heardAt: number
}

/** What a word or a beat came to: how it stands now, and the lines to write, oldest first. */
export interface InboundMoved {
  now: Inbound | null
  lines: MachineSeen[]
}

/**
 * A machine that links here said something of itself. `slept` is how long ago
 * it says it went to sleep, where it is waking from one: the `asleep` line is
 * written then, with that moment, before it is `up` again. A word that changes
 * nothing writes nothing — an `up` every few seconds is a heartbeat, not news.
 */
export function inboundSaid(
  machine: string,
  was: Inbound | null,
  word: SeenWord,
  now: number,
): InboundMoved {
  const lines: MachineSeen[] = []
  const line = (state: MachineState, since: number | null = null) =>
    lines.push({ machine, way: 'from', state, at: now, since })
  if (word.state !== 'closed' && word.slept !== null) {
    const went = now - Math.min(SLEPT_MOST_MS, Math.max(0, word.slept))
    line('asleep', went)
    if (word.state === 'up') line('up')
    return { now: { state: word.state, heardAt: now }, lines }
  }
  if (was?.state !== word.state) line(word.state)
  return { now: { state: word.state, heardAt: now }, lines }
}

/**
 * The window's beat, for one machine that links here: one that was up and has
 * said nothing for longer than `LOST_AFTER_MS` is `lost`. One that said
 * goodbye stays what it said; one already lost is not lost again.
 */
export function inboundBeat(machine: string, was: Inbound | null, now: number): InboundMoved {
  if (was === null || was.state !== 'up' || now - was.heardAt <= LOST_AFTER_MS) {
    return { now: was, lines: [] }
  }
  return {
    now: { ...was, state: 'lost' },
    lines: [{ machine, way: 'from', state: 'lost', at: now, since: was.heardAt }],
  }
}

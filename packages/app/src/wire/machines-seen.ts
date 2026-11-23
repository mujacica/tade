import {
  type Inbound,
  type InboundMoved,
  inboundBeat,
  inboundSaid,
  type MachineSeen,
  type MachineState,
  machinesSeenFrom,
  printable,
  type SeenWord,
  seenDetail,
} from '@tade/core'
import type { Held } from '@tade/remotes-core'
import type { MachineIn } from '@tade/web'
import { notify, type Wiring } from './context.ts'

// Which of the person's machines are up, as this window has seen them, and the
// `machine_seen` lines that say when each changed (`@tade/core`'s
// `machines-seen.ts` has the rules and why).
//
// **The heart's, not the face's**: a machine that links here beats at this
// one's away view (`/api/seen`), and the VPS that answers it is usually a
// `tade serve` with no window at all — so what holds the machines that link
// here is made with the heart, beside the away view, and the window's links
// (`wire/remotes.ts`) hand it the machines this one links to.
//
// **Seeded from the journal, then told.** At open it reads its own last lines
// back, so a machine that closed yesterday is still drawn closed, and a line
// is written only where a state moves. A machine that links here and was up
// when this window last closed is not assumed still up: until it beats again
// it is drawn as that line said, as of then.

/** What the window writes and says, named once so a test can hand it over. */
export interface MachinesSeenDeps {
  /** The journal: one line, appended, and the lines of one type read back. */
  append(line: { type: 'machine_seen'; detail: Record<string, string> }): Promise<void>
  read(): Promise<readonly MachineSeen[]>
  now(): number
  /** Said in the strip where a line would not go in: never swallowed. */
  say(said: string): void
  /** Something moved: a frame, and a beat of the away view. */
  draw(): void
}

export class MachinesSeen {
  private readonly deps: MachinesSeenDeps
  /** The last state each machine was written down as, by `${way} ${machine}`. */
  private readonly last = new Map<string, MachineSeen>()
  /** The machines that link here, as their beats stand, by name. */
  private readonly inbound = new Map<string, Inbound>()
  private seeded: Promise<void> | null = null

  constructor(deps: MachinesSeenDeps) {
    this.deps = deps
  }

  /** Read this machine's own last lines back, once. Safe twice; never throws. */
  seed(): Promise<void> {
    this.seeded ??= this.deps.read().then(
      (seen) => {
        const now = this.deps.now()
        for (const one of seen) {
          const key = keyOf(one.way, one.machine)
          // Anything already said in this window is newer than the journal.
          if (this.last.has(key)) continue
          this.last.set(key, one)
          // One that links here and was up when this machine last looked is
          // given its slack from now: beating again it stays up without a
          // line, and silent it is lost — never up for ever on an old word.
          if (one.way === 'from' && one.state === 'up' && !this.inbound.has(one.machine)) {
            this.inbound.set(one.machine, { state: 'up', heardAt: now })
          }
        }
        this.deps.draw()
      },
      (err: unknown) =>
        this.deps.say(`which machines were up could not be read back: ${String(err)}`),
    )
    return this.seeded
  }

  /** A machine that links here said something of itself (`/api/seen`), at `at` in this clock. */
  heard(machine: string, word: SeenWord, at: number): void {
    const name = seenName(machine)
    const was = this.inbound.get(name) ?? this.fromLine(name)
    this.moved(name, inboundSaid(name, was, word, at))
  }

  /** The beat: a machine that links here and has said nothing past its slack is lost. */
  beat(): void {
    const now = this.deps.now()
    for (const [name, was] of this.inbound) this.moved(name, inboundBeat(name, was, now))
  }

  /**
   * A machine this one links to, as its link stands: up while live, `closed`
   * where it said goodbye as it went, `lost` where it went without a word.
   * Nothing is written for a link still being dialled or signed out — neither
   * says what the machine is — nor for one the window gave up on as it woke,
   * which is this machine having slept rather than that one having gone.
   */
  linked(held: Held): void {
    const state = linkedState(held)
    if (state === null) return
    const key = keyOf('to', held.remote)
    const was = this.last.get(key)?.state
    // One that closed and still does not answer is still closed — a window
    // opened since has heard no goodbye of its own, and none was owed.
    if (was === state || (state === 'lost' && was === 'closed')) return
    const since = state === 'lost' && held.heardAt !== null ? held.heardAt : null
    this.write({ machine: held.remote, way: 'to', state, at: this.deps.now(), since })
  }

  /** Every machine as last seen, each way, oldest-seen first. */
  all(): readonly MachineSeen[] {
    return [...this.last.values()]
  }

  /** What the away view projects: every machine, each way, since when. */
  rows(): MachineIn[] {
    return this.all().map((one) => ({
      name: one.machine,
      way: one.way,
      state: one.state,
      since: one.since ?? one.at,
    }))
  }

  /** How a machine that links here last stood, from its last line, as the beat reads it. */
  private fromLine(name: string): Inbound | null {
    const line = this.last.get(keyOf('from', name))
    // A line from before this window is how it stood then, not a beat heard now.
    return line === undefined ? null : { state: line.state, heardAt: line.at }
  }

  private moved(name: string, moved: InboundMoved): void {
    if (moved.now === null) this.inbound.delete(name)
    else this.inbound.set(name, moved.now)
    for (const line of moved.lines) this.write(line)
  }

  private write(seen: MachineSeen): void {
    this.last.set(keyOf(seen.way, seen.machine), seen)
    this.deps.draw()
    this.deps.append({ type: 'machine_seen', detail: seenDetail(seen) }).catch((err: unknown) => {
      this.deps.say(
        `that ${seen.machine} is ${seen.state} could not be written down: ${String(err)}`,
      )
    })
  }
}

function keyOf(way: string, machine: string): string {
  return `${way} ${machine}`
}

/**
 * A machine's label as it may be written down and drawn: text only, bounded —
 * the name its `machine_seen` lines carry, and its sync state is kept under.
 */
export function seenName(label: string): string {
  const plain = printable(label).trim().slice(0, 60)
  return plain === '' ? 'a machine' : plain
}

/** What a link's state says of the machine at its other end, or null where it says nothing. */
export function linkedState(held: Held): MachineState | null {
  if (held.link.kind === 'live') return 'up'
  if (held.link.kind !== 'down') return null
  return held.bye === 'closed' ? 'closed' : 'lost'
}

/** The window's own, out of its wiring: the journal it holds, and the strip. */
export function machinesSeenFor(wire: Wiring): MachinesSeen {
  return new MachinesSeen({
    append: async (line) => {
      await wire.opts.client.log.append(line)
    },
    read: async () =>
      machinesSeenFrom(await wire.opts.client.log.read({ types: ['machine_seen'] })),
    now: () => wire.now(),
    say: (said) => {
      notify(wire, said)
      wire.draw()
    },
    draw: () => wire.draw(),
  })
}

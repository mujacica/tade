import { isDeepStrictEqual } from 'node:util'
import { type Config, findSecret } from '@tade/core'
import { LaneClosedError, LaneNotFoundError } from '@tade/drivers-core'
import {
  type ConversationIn,
  inTime,
  KNOWN_FLOOR,
  type LaneIn,
  SCREEN,
  TURNS,
  type TurnIn,
} from '@tade/web'
import type { Wiring } from './context.ts'

// What the away view holds of agents' screens, and the one rule that decides
// when it reads one: **somebody granted `lanes` is looking at that agent now.**
//
// A lane's screen lives on the emulator thread (`drivers/pty`), and the window
// reads one only for the pane it is drawing. The away view is a second reader
// and it must not become a second always-on one: forty rows of every agent,
// twice a second, for a phone in a pocket, is exactly the per-frame work
// nobody watching should cost. So:
//
// - **A watch is made by asking**, on `/api/agent/...`, by a device granted
//   `lanes`, and it runs out on its own (`WATCH_MS`) unless the page asks
//   again. There is no "stop" to forget to send: a page that navigated away, a
//   phone that slept and a tab somebody closed all stop renewing, and the
//   reading stops a beat or two later.
// - **The read happens on the window's beat**, never in a request: a handler
//   answers out of what is held (`web.ts`'s rule — *no handler does any
//   work*), and the first answer for an agent nobody was watching says `not
//   read yet` rather than awaiting a driver.
// - **One read in flight per lane, each with a deadline** (`READ_MS`). A
//   driver that stopped answering keeps the last screen it gave rather than
//   piling up promises, and the window's thread never waits on one.
// - **With no watch, `beat` is one comparison and a return.**
//   `test/wire/web-lanes.test.ts` counts the reads.
//
// Nothing here cleans anything: what is held is the driver's text, as it came,
// and `cleanScreen` in `@tade/web` is the boundary that decides what of it may
// leave the machine — the same split `fresh.warnings` has. A conversation's
// long turns are made ready by the window's `ready` before they are held.

/** How long one ask keeps a lane being read, without another. */
export const WATCH_MS = 6_000

/** How long one read may take before the last one known is kept instead. */
export const READ_MS = 1_500

/**
 * How many agents one device may have the window reading at once.
 *
 * A page looks at one agent; a person with a few tabs open looks at a few. A
 * device asking about forty is not a person reading, and without a bound it
 * would be forty reads a beat that one session could buy — so past this the
 * device's oldest ask is let go, and the newest is what it gets.
 */
export const MOST_PER_DEVICE = 4

/** What reading a lane needs of the window. */
export interface LaneReading {
  /**
   * The rendered rows of one lane, unstyled — the driver's own capture.
   * Throws for a lane that is not there, which is an answer: no agent.
   */
  capture(lane: string, lines: number): Promise<string>
  /**
   * The newest turns of a task's agent's conversation, out of its harness's
   * own record (`Workbench.agentHistory`): at least `limit` of them, and
   * where the turns before them end in it — null where these reach its
   * beginning. Throws for a record that is there and could not be read.
   * Absent, no conversation is read.
   */
  history?(task: string, limit: number): Promise<{ turns: TurnIn[]; before: string | null }>
  /**
   * Turns just read, made ready to cross before they are held: the long ones
   * cleaned off the window's thread (`turnsAway`), so the ask that sends them
   * finds them made. Throws where that could not be done, which is said as a
   * record that could not be read. Absent, every turn is cleaned when asked.
   */
  ready?(task: string, turns: readonly TurnIn[]): Promise<void>
  /**
   * A conversation's record could not be read: said where somebody reads it,
   * once each time it goes from read to not, never once a beat.
   */
  trouble?(task: string, err: unknown): void
  now(): number
  /** How long a read may take. `READ_MS` but in a test, which has no second to spend. */
  deadline?: number
}

const LATE = Symbol('late')

/** Every agent somebody is looking at from away, and what was last read of each. */
export class Lanes {
  private readonly reading: LaneReading
  /** task → device → until when that device's ask keeps it watched. */
  private readonly watching = new Map<string, Map<string, number>>()
  private readonly held = new Map<string, LaneIn>()
  private readonly flying = new Set<string>()
  /** What was last read of each watched agent's conversation. */
  private readonly talks = new Map<string, ConversationIn>()
  private readonly talking = new Set<string>()
  /** Counts every conversation that moved, so a revision is never one a page already holds. */
  private moved = 0
  /** The keys a screen is scrubbed of: worked out at most once a beat, and only if asked. */
  private known: string[] | null = null
  /** How many reads were started, which is what a test counts. */
  started = 0

  constructor(reading: LaneReading) {
    this.reading = reading
  }

  /** A device granted `lanes` asked about this task: keep reading it for a while. */
  watch(device: string, task: string, now: number): void {
    const who = this.watching.get(task) ?? new Map<string, number>()
    who.set(device, now + WATCH_MS)
    this.watching.set(task, who)
    const mine = [...this.watching]
      .filter(([, by]) => by.has(device))
      .sort(([, a], [, b]) => (a.get(device) ?? 0) - (b.get(device) ?? 0))
    for (const [old, by] of mine.slice(0, Math.max(0, mine.length - MOST_PER_DEVICE))) {
      by.delete(device)
      if (by.size === 0) this.drop(old)
    }
  }

  /** What was last read of this task's agent, or null for nothing yet. */
  heldFor(task: string): LaneIn | null {
    return this.held.get(task) ?? null
  }

  /** What was last read of this task's agent's conversation; absent for nothing yet. */
  talkFor(task: string): ConversationIn | undefined {
    return this.talks.get(task)
  }

  /**
   * The keys a screen is scrubbed of, made by `make` at most once a beat.
   *
   * Once a beat rather than once: a key pasted into Settings a second ago is
   * a key that has to come off the next screen, and the config is the
   * window's to change under this. Not on every ask, because asking every
   * extension for its keys is not free and a page asks every two seconds.
   */
  keys(make: () => string[]): string[] {
    this.known ??= make()
    return this.known
  }

  /** How many agents are being watched now. */
  get watched(): number {
    return this.watching.size
  }

  /**
   * A device that is no longer one: nothing it asked for is read any more.
   *
   * Called where `web.ts` forgets a device's projector and streams, so a
   * revoked phone's last ask does not go on costing a read for six seconds.
   */
  forget(device: string): void {
    for (const [task, who] of this.watching) {
      who.delete(device)
      if (who.size === 0) this.drop(task)
    }
  }

  /**
   * One beat: let go of what nobody renewed, and read what is still watched.
   *
   * Nothing is awaited — the window draws on this thread. A read lands in
   * `held` when it comes back, and the next ask answers from it.
   */
  beat(now: number): void {
    this.known = null
    if (this.watching.size === 0) return
    for (const [task, who] of this.watching) {
      for (const [device, until] of who) if (until <= now) who.delete(device)
      if (who.size === 0) {
        this.drop(task)
        continue
      }
      if (!this.flying.has(task)) void this.read(task)
      if (this.reading.history !== undefined && !this.talking.has(task)) void this.readTalk(task)
    }
  }

  /**
   * A read that did not come back as a screen. **Late or failed is not gone**:
   * the last screen known stays, with the moment it was read on it, and only
   * an agent nothing was ever read of says it could not be read.
   */
  private couldNot(task: string): void {
    const was = this.held.get(task)
    if (was === undefined || was.kind === 'none') {
      this.held.set(task, { kind: 'none', why: 'could not read' })
    }
  }

  private drop(task: string): void {
    this.watching.delete(task)
    // **What nobody is looking at is not kept**, so a screen read an hour ago
    // is never the first thing a page is shown when it opens the agent again:
    // that answer is `not read yet`, which is true, and the next beat reads it.
    this.held.delete(task)
    this.talks.delete(task)
  }

  /**
   * One read of an agent's conversation: the same rules as its screen — one in
   * flight, a deadline, and a late or failed read keeps the last one known.
   * Its revision moves only when the turns did, so a page that already holds
   * them is sent nothing (`?seen=`).
   */
  private async readTalk(task: string): Promise<void> {
    const history = this.reading.history
    if (history === undefined) return
    this.talking.add(task)
    try {
      const page = await inTime<{ turns: TurnIn[]; before: string | null } | typeof LATE>(
        history(task, TURNS.turns),
        this.reading.deadline ?? READ_MS,
        LATE,
      )
      if (!this.watching.has(task)) return
      if (page === LATE) {
        this.talkCouldNot(task)
        return
      }
      // Compared with the turns held, never serialized: a call's input crosses
      // uncut, so a string of the whole page was megabytes made on the thread
      // that draws, every beat, to find out that nothing moved.
      const was = this.talks.get(task)
      if (
        was?.kind === 'read' &&
        was.before === page.before &&
        isDeepStrictEqual(was.turns, page.turns)
      ) {
        return
      }
      // Not under `READ_MS`: that is the record's deadline, and cleaning a long
      // turn has its own. The turns are held only once they are ready.
      await this.reading.ready?.(task, page.turns)
      if (!this.watching.has(task)) return
      this.moved += 1
      this.talks.set(task, {
        kind: 'read',
        turns: page.turns,
        before: page.before,
        rev: String(this.moved),
      })
    } catch (problem) {
      // A record that is there and could not be read is said as that, never
      // as a conversation with nothing in it — to the page, and to the person
      // at the machine the first time it happens.
      if (!this.watching.has(task)) return
      const was = this.talks.get(task)
      if (was === undefined || was.kind === 'read') this.reading.trouble?.(task, problem)
      this.talkCouldNot(task)
    } finally {
      this.talking.delete(task)
    }
  }

  private talkCouldNot(task: string): void {
    const was = this.talks.get(task)
    if (was === undefined || was.kind === 'none') {
      this.talks.set(task, { kind: 'none', why: 'could not read' })
    }
  }

  private async read(task: string): Promise<void> {
    this.flying.add(task)
    this.started += 1
    try {
      const text = await inTime<string | typeof LATE>(
        // The agent's own lane, by the name every agent's lane has. A screen's
        // rows and one more — never the scrollback (`cleanScreen` cuts again).
        this.reading.capture(`${task}/agent`, SCREEN.lines + 1),
        this.reading.deadline ?? READ_MS,
        LATE,
      )
      // A read that came back after the watch ended is a read nobody asked for
      // any more, and keeping it would be keeping a screen nobody is looking at.
      if (!this.watching.has(task)) return
      if (text === LATE) {
        this.couldNot(task)
        return
      }
      this.held.set(task, { kind: 'read', text, at: this.reading.now() })
    } catch (problem) {
      if (!this.watching.has(task)) return
      // **Two answers, never one.** A lane the driver says is not there — or
      // is closed — is an agent that is not running, which is a fact about the
      // work. Anything else is the *reading* going wrong, and a page told *no
      // agent is running* about an agent that is would be the one lie this
      // pane must not tell: it says it could not read the screen instead, and
      // the driver's own trouble is the driver's to report.
      const gone = problem instanceof LaneNotFoundError || problem instanceof LaneClosedError
      if (gone) this.held.set(task, { kind: 'none', why: 'no agent' })
      else this.couldNot(task)
    } finally {
      this.flying.delete(task)
    }
  }
}

/**
 * Names an environment gives a credential.
 *
 * The window's environment is the one every agent inherits, so a variable
 * named like a key is a value an agent that runs `env` prints — and that is
 * the single most likely way a key ends up on a screen.
 */
const NAMED_LIKE_A_KEY =
  /(?:secret|token|passw(?:or)?d|pwd|api_?key|access_?key|private_?key|credential|auth|dsn|cookie|session)/i

/** One declared key: what the config holds, and the variables read before it. */
export interface DeclaredKey {
  value: string
  variables: readonly string[]
}

/**
 * Every value the window knows to be a key, to be taken off a screen exactly.
 *
 * Three sources, all of them things this process already holds: the keys the
 * loaded extensions declare (as written, and as their variables hold them —
 * the environment wins, so both can be live), the notification signing key,
 * and every variable of the environment named like one. Values shorter than
 * `KNOWN_FLOOR` are left out by `cleanScreen` itself.
 */
export function knownKeys(
  declared: readonly DeclaredKey[],
  web: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const out = new Set<string>()
  const add = (value: string | undefined): void => {
    const kept = value?.trim() ?? ''
    if (kept.length >= KNOWN_FLOOR) out.add(kept)
  }
  for (const one of declared) {
    add(one.value)
    for (const variable of one.variables) add(env[variable])
  }
  add(findSecret({ settings: web, key: 'push_key', env, variables: ['TADE_PUSH_KEY'] })?.value)
  for (const [name, value] of Object.entries(env)) {
    if (NAMED_LIKE_A_KEY.test(name)) add(value)
  }
  return [...out]
}

/** Every key Tade knows of here: the config's, their variables, the environment's credentials. */
export function knownHere(wire: Wiring, config: Config): string[] {
  const web = config.surfaces.web as unknown as Record<string, unknown>
  return knownKeys(wire.opts.extensions?.secrets() ?? [], web, process.env)
}

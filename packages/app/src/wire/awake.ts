import { spawn } from 'node:child_process'
import {
  awakeArgs,
  awakeSaid,
  CAFFEINATE,
  NO_HOLD_HERE,
  resolveCommand,
  stringEnv,
} from '@tade/core'
import type { Frame } from '../frame.ts'
import { notice } from '../model.ts'
import { type Actions, type Subject, type Wiring, why } from './context.ts'

// Holding the machine awake while Tade is open, and the button that says so.
//
// The second of the two halves of one answer. `wire/sleep.ts` is the
// fallback — the machine went, and the agents it cut off are told to carry on
// — and this is the prevention. Neither replaces the other: a lid that closes
// may sleep whatever is held, so the wake is still what catches it, and the
// two are said together wherever either is described (`KEEP_AWAKE_MEANS`).
//
// **What is held is the assertion, never a setting of the machine's.** Tade
// takes it while it is open and drops it when it closes, so nothing is left
// behind to find later and no power preference is edited. That is also why
// `release()` is called from the window's own stop and why `awakeArgs` waits
// on this pid: the two together mean there is no way of leaving this machine
// awake that does not end when Tade does, a crash included.
//
// **Whether it is held is read from the hold, not from the setting.** The
// setting is a wish and this is what came of it: a machine with no
// `caffeinate` has the wish and no hold, and drawing the wish would be a
// button claiming the machine is awake because somebody asked for it to be.

/**
 * Taking and dropping the hold, as the window reaches the machine for it.
 *
 * A port in the small sense: a test hands its own rather than asking the
 * machine the suite runs on to stay awake, which is not a thing a test may do
 * and not a thing anybody could assert about afterwards.
 */
export interface Hold {
  /** Where the program that takes it is, or null when there is none here. */
  program(): string | null
  /** Take it. What comes back drops it; throws when it could not be taken. */
  start(program: string): () => void
}

/**
 * The real one: `caffeinate`, wherever PATH has it.
 *
 * Looked for rather than decided by platform. The question is whether the
 * program is here, which is what `resolveCommand` answers, and a machine that
 * has it can hold sleep off whatever it calls itself.
 */
export function caffeineHold(env: NodeJS.ProcessEnv = process.env): Hold {
  return {
    program: () => resolveCommand(CAFFEINATE, stringEnv(env)),
    start: (program) => {
      // Detached and unreferenced, like everything else Tade starts: it is in
      // its own process group and never holds the event loop open. What ends
      // it is the `-w` on its own arguments and the drop below — never the
      // shape of Node's process tree, which says nothing about assertions.
      const child = spawn(program, [...awakeArgs(process.pid)], {
        stdio: 'ignore',
        detached: true,
      })
      // A spawn that fails does so asynchronously, and an unhandled `error` on
      // a child takes the window down with it. What it means is that sleep is
      // not being held, which the next look reads off the process being gone.
      child.once('error', () => {})
      child.unref()
      return () => {
        try {
          child.kill()
        } catch {
          // Already gone — which is the state this was asking for.
        }
      }
    },
  }
}

/** What this subject needs from the rest of the window. */
export interface AwakeDeps {
  /**
   * Write the setting, through the one door every setting is written by — so
   * pressing the button and typing it in Settings are the same act, and both
   * are written down as `config_changed`. Off takes the key away rather than
   * writing `false`: off is the default, and a preference that stops being one
   * stops being written.
   */
  keep(on: boolean): Promise<void>
}

/**
 * The anti-sleep hold, as the window holds it.
 *
 * Its whole job is to make one boolean in the config true of the machine, and
 * to say plainly where it cannot be. Nothing here is on a timer: the hold is
 * taken and dropped on the edges — the window opening, the setting changing,
 * the window closing — because a machine that is already not sleeping has
 * nothing to do four times a second.
 */
export class Awake implements Subject {
  private readonly wire: Wiring
  private readonly deps: AwakeDeps
  private readonly hold: Hold
  /**
   * Where the program is, looked for once when the window opened.
   *
   * Once, because `facts()` is a draw away from being read four times a second
   * and a PATH walk is a syscall per directory on it. A program installed
   * while Tade is open is found the next time Tade opens, which is the same
   * answer every other declared program gets.
   */
  private readonly found: string | null
  /** How to drop the assertion, while one is held. Null is the whole of "not held". */
  private drop: (() => void) | null = null
  /** Why there is no hold, when there is none and somebody asked for one. */
  private problem: string | null

  constructor(wire: Wiring, deps: AwakeDeps, hold: Hold = caffeineHold()) {
    this.wire = wire
    this.deps = deps
    this.hold = hold
    this.found = hold.program()
    this.problem = this.found === null ? NO_HOLD_HERE : null
  }

  /** Whether sleep is being held off now, and why it is not where it cannot be. */
  facts(): Partial<Frame> {
    return { awake: { held: this.drop !== null, problem: this.problem } }
  }

  actions(): Actions {
    return { awake: () => this.toggle() }
  }

  /**
   * Take the hold or drop it, to match what the config now says.
   *
   * Called from the one door a setting is written by, so a change made in
   * Settings, by the button, or by the orchestrator on somebody's word all
   * reach the machine the same way. Idempotent: applying what is already true
   * does nothing, which is what lets it be called from every config change
   * rather than only from the ones about it.
   */
  apply(): void {
    const want = this.wire.opts.config.agents.keep_awake
    if (want === (this.drop !== null)) return
    if (!want) {
      this.release()
      return
    }
    if (this.found === null) return
    try {
      this.drop = this.hold.start(this.found)
      this.problem = null
    } catch (err) {
      // Said rather than retried: what it means is that this machine will
      // sleep, and the wake is what puts the agents back to work.
      this.problem = `could not hold sleep off: ${why(err)}`
    }
  }

  /**
   * Drop it, if one is held. The window's own stop, and safe to call twice —
   * the same rule the terminal's `restore()` obeys, and for the same reason:
   * an exit path that gives up half way leaves the machine awake with nobody
   * left to notice.
   */
  release(): void {
    const drop = this.drop
    this.drop = null
    drop?.()
  }

  /**
   * The button: hold sleep off, or let the machine sleep as usual.
   *
   * Where it cannot be held at all, pressing says so and writes nothing — a
   * setting Tade accepts and ignores is worse than one it does not have, and
   * the sentence carries the other half, which is still true.
   */
  private async toggle(): Promise<void> {
    if (this.found === null) {
      this.say(NO_HOLD_HERE)
      return
    }
    const want = !this.wire.opts.config.agents.keep_awake
    try {
      await this.deps.keep(want)
    } catch (err) {
      this.say(why(err))
      return
    }
    // What is said is what came of it, never what was asked for: writing the
    // setting went through `apply`, so by here the hold is taken or it is not.
    this.say(this.problem ?? awakeSaid(this.drop !== null))
  }

  private say(said: string): void {
    this.wire.put(notice(this.wire.state, said))
    this.wire.draw()
  }
}

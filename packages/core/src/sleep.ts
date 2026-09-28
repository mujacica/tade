import { duration } from './runtime.ts'

// The machine going away under a running agent, and coming back.
//
// A laptop that sleeps over lunch takes every agent's turn down with it. The
// harness is still there when the lid opens — Claude Code prints `API Error:
// Your computer went to sleep mid-response. The response above may be
// incomplete.` and hands you back the prompt — so what is lost is not the
// agent, the conversation or the work: it is the *turn*, and nothing tells
// the agent to pick it back up. Four agents sit at a prompt until somebody
// comes back and types into each of them.
//
// This is the other side of being offline (`network.ts`). There, connectivity
// became one answer the scheduler holds, so a watch that needs a network
// simply does not look while there is none. Here the machine itself went
// away, and the same two halves apply: **one fact, held in one place** — the
// wake, not a dozen timers each discovering it — and **the edge is what is
// worth acting on**, because a machine that is awake has nothing to continue.
//
// What it is built around:
//
//   1. **The wake is what matters, not the sleep.** Nothing can be done while
//      the machine is away, so there is nothing to detect until it is back.
//      Which is lucky: the wake is the one of the two that is free to notice.
//      The window beats four times a second, so a beat that arrives an hour
//      after the last one is the machine having been away in between —
//      exact, costing nothing, asking nobody, and true on every platform.
//      `pmset -g log` would be a child process on a timer, macOS only, to
//      learn something the clock has already said.
//   2. **Only what was interrupted.** An agent idle at a prompt was not doing
//      anything when the machine went; it needs nothing, and telling it
//      something is a turn it did not ask for. `unknown` is not `running`
//      either — an agent whose channel was never opened has not said it was
//      mid-turn, and nudging every one of those on every wake is exactly the
//      retry storm this is meant not to be.
//   3. **A nudge, never the instruction again.** What goes is `CONTINUE` and
//      nothing else, for the reason an opening prompt is said at launch and
//      never on a reattach (`LaunchSpec.opening`): an agent told its first
//      instruction a second time does the work twice.
//   4. **Once per wake per agent.** One sleep is one continue. An agent that
//      dies again after being told is failed, and a person is told so — it is
//      not nudged again, because a laptop that sleeps nightly would otherwise
//      be a loop with a long period rather than no loop at all.
//
// Pure: beats and agents in, what to do out. Nothing here reads a clock,
// starts anything or knows what a harness is.

/**
 * What the window knows about the machine having been away.
 *
 * `beat` is the clock at the last beat that was believed, and null before the
 * first, which is compared to nothing: a window opening is not a machine
 * waking, and every agent it finds is one it is adopting rather than one it
 * interrupted. Null rather than nought, because a clock that a test drives
 * from zero is a real clock, and a sentinel that is also a value is the kind
 * of bug that only shows up on somebody else's machine.
 */
export interface Waking {
  beat: number | null
  /**
   * How many times the machine has come back. The id a continue is counted
   * against, so "once per wake" is a comparison rather than a set that has to
   * be emptied at the right moment.
   */
  wakes: number
  /** How long it was away, on the beat that noticed; null on every other. */
  slept: number | null
}

/** Awake, having beaten nothing: what a window starts with. */
export const AWAKE: Waking = { beat: null, wakes: 0, slept: null }

/**
 * Past this, two beats are not two beats.
 *
 * The window beats four times a second and a look it already calls slow is
 * two seconds (`SLOW_LOOK_MS`), so this is 45 times a look nobody would
 * defend — far past a stalled event loop or a machine swapping, and far
 * under the shortest nap anybody takes a laptop away for. The cost of being
 * wrong is asymmetric, and that is what picked it: too low and a busy machine
 * nudges agents that were never interrupted, a turn each and a transcript
 * full of them; too high and a short sleep goes unnoticed, which is exactly
 * where the person was before any of this.
 */
export const AWAY_AFTER_MS = 90_000

/**
 * The window beat: the same `Waking` back, or one that has noticed a wake.
 *
 * A clock that went backwards is not a wake — an NTP correction, or a test
 * driving its own — and neither is the first beat of a window.
 */
export function beat(was: Waking, now: number): Waking {
  const gap = was.beat === null ? 0 : now - was.beat
  const away = gap >= AWAY_AFTER_MS
  return { beat: now, wakes: was.wakes + (away ? 1 : 0), slept: away ? gap : null }
}

/** An agent, as the wake rule reads it. Nothing about how it is run. */
export interface Napping {
  task: string
  run: string
  /**
   * Whether it was in the middle of a turn, as it last said. `unknown` is a
   * first-class answer and is never read as `running`: an agent that has not
   * said is not an agent that said yes.
   */
  turn: 'running' | 'idle' | 'unknown'
  /** Whether its lane is still there. One that is not is `reopenStopped`'s. */
  alive: boolean
  /** Whether its harness picks a cut-off turn back up (`capabilities.continues`). */
  continues: boolean
}

/**
 * The agents this wake is worth telling to carry on, and only those.
 *
 * `told` is what each run was last told about, by wake, so an agent already
 * continued for this wake is passed over however many beats go by — which is
 * what makes one sleep one continue rather than four a second.
 */
export function toContinue(
  agents: readonly Napping[],
  told: ReadonlyMap<string, number>,
  wake: number,
): readonly Napping[] {
  return agents.filter(
    (one) => one.alive && one.turn === 'running' && one.continues && told.get(one.run) !== wake,
  )
}

/**
 * The whole of what an interrupted agent is told.
 *
 * Small on purpose, and about the machine rather than about Tade: what the
 * agent needs to know is that the gap in its own transcript is a sleeping
 * laptop and not something it did, and that the work is where it left it.
 * Anything longer is an instruction, and the instruction it already has is
 * the one it was started with.
 */
export const CONTINUE =
  'This machine went to sleep and your last turn was cut off part way through — that is the error above, and nothing you did. Carry on from where you stopped, and do not start the task over.'

/**
 * The one line a person reads when a wake put agents back to work.
 *
 * Said only when something was actually continued: a wake that interrupted
 * nothing changed nothing, and a line every morning for a laptop that sleeps
 * every night is the noise `WATCHES_PAUSED` exists to avoid. Names them,
 * because which agents were told is the part somebody may want to undo.
 */
export function wokeSaid(slept: number, continued: readonly string[]): string {
  const told =
    continued.length === 1
      ? `${continued[0]} told to carry on where it stopped`
      : `${continued.length} agents told to carry on where they stopped`
  return `back after ${duration(slept)} asleep — ${told}`
}

/** Why an agent that could not be told is a person's problem rather than another nudge. */
export function couldNotContinue(task: string, why: string): string {
  return `${task} was cut off when the machine slept and could not be told to carry on: ${why}`
}

// Holding the sleep off in the first place, which is the other half of the
// same answer.
//
// Everything above is the fallback: the machine went, and the agents it cut
// off are told to carry on. This is the prevention — an assertion held while
// Tade is open, so there is nothing to recover from. They are one feature and
// are said as one wherever somebody reads about either (`KEEP_AWAKE_MEANS`),
// because two half-answers competing for the same question is how somebody
// ends up choosing between them.
//
// **Held, never set.** The assertion lives and dies with the window: nothing
// is written into the machine's power settings, so closing Tade gives the
// machine straight back and there is no state left behind to find later.
// `-w` is what makes that true even when Tade is not given the chance to let
// go — a crash, a kill -9 — because caffeinate exits when the pid it is
// waiting on does.
//
// **Off by default, and it stays a choice.** An anti-sleep hold is somebody
// deciding their laptop should not sleep; it is not a thing to turn on for
// them because it happens to suit the agents.

/** The program that takes the assertion. Nothing else here knows its name. */
export const CAFFEINATE = 'caffeinate'

/**
 * What to ask `caffeinate` for, waiting on Tade's own process.
 *
 * **`-s` and `-i`, and neither `-d` nor `-u`.** The display is deliberately
 * left alone: the screen dims and locks on its usual timer, so holding the
 * machine up to work changes nothing about who can walk past and read it.
 * Both of the two that are asked for are needed, because each covers what the
 * other cannot — `-s` is the stronger assertion and is valid **only on AC
 * power**, and `-i` holds idle sleep off wherever it runs. `-s` alone is a
 * hold that quietly does nothing the moment somebody unplugs, which is a
 * button that says it is holding and is not.
 *
 * **`-w` and not a timeout.** Tied to the pid rather than to a clock, so the
 * hold lasts exactly as long as this Tade does and not a second past it. A
 * timeout would have to be renewed by something on a timer, and the failure
 * of a renewal nobody watched is a machine that never sleeps again.
 */
export function awakeArgs(pid: number): readonly string[] {
  return ['-s', '-i', '-w', String(pid)]
}

/**
 * What the hold does, in the one sentence that says both halves of it.
 *
 * Said wherever the toggle is described — the setting, the button's answer —
 * because the question somebody actually has is "what happens if I leave this
 * off", and the answer is not "nothing".
 */
export const KEEP_AWAKE_MEANS =
  'agents keep running while Tade is open; off, they are picked up when the machine wakes'

/**
 * Why there is no hold on this machine, where there is none.
 *
 * A button that cannot do what it says is worse than one that is not there,
 * so this is what pressing it answers: what is missing, and what happens
 * instead — which is the whole of the other half, still true.
 */
export const NO_HOLD_HERE = `nothing here holds sleep off — ${CAFFEINATE} is macOS's and is not on this machine, so an agent a sleep cuts off is told to carry on when it wakes instead`

/** What a person is told the moment they press it, in the terms the press changed. */
export function awakeSaid(held: boolean): string {
  return held
    ? 'holding sleep off: the machine stays awake while Tade is open, and the screen still locks as usual'
    : 'sleep as usual again — agents a sleep cuts off are told to carry on when the machine wakes'
}

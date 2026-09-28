import {
  AWAKE,
  beat,
  couldNotContinue,
  type Napping,
  toContinue,
  type Waking,
  wokeSaid,
} from '@tade/core'
import { withTranscript } from '../model.ts'
import { tadeDid } from '../transcript.ts'
import { type Wiring, why } from './context.ts'

// The machine going to sleep under the agents, and what the window does when
// it comes back.
//
// The rules are `core/src/sleep.ts`, which carries the reasoning; this is the
// half that has a clock and agents to tell. Its shape is `wire/network.ts`'s,
// deliberately: one fact about the machine, held in one place, with the
// watches — here, the agents — reading it rather than each finding it out.
//
// **What is remembered, and why it has to be.** What decides is whether an
// agent was mid-turn *when the machine went away*, and that cannot be asked
// afterwards. On the wake the harness's process resumes, discovers its
// request died, and says `turn_done` — so by the time anything here looks,
// the agent that was interrupted may already look idle, and which of the two
// happens first is a race between a laptop's power management and a 250ms
// timer. So every beat writes down what each agent was doing, and the wake
// reads the beat *before* it. A run that was not there at that beat is
// `unknown`, never `running`: an agent started since the machine came back
// cannot have been interrupted by it.
//
// **Why the supervisor and not the orchestrator.** What was asked for was the
// orchestrator instructing each agent to continue, and it is the wrong half
// of Tade for it. An agent told something by another agent is a message in
// its conversation and a turn it pays for, decided by a model that may decide
// differently on Tuesday — where this is a rule, and a rule can be tested.
// The orchestrator is also an agent whose own turn the same sleep cut off, so
// making it the thing that wakes everybody puts the recovery behind the one
// conversation the outage just broke. So: Tade continues the lanes, and the
// orchestrator is *told* it happened, the way it is told an agent closed.
// Which is the standing rule anyway — Tade tells the orchestrator, it never
// talks over it.

/** What a wake needs of the agents: who they are, and telling one to carry on. */
export interface Napped {
  /** Every supervised agent, as the wake rule reads one. */
  agents(): readonly Napping[]
  /** Tell one to carry on where it stopped. Throws when it could not be told. */
  continue(agent: Napping, slept: number): Promise<void>
}

/**
 * What the window knows about its machine having been away, and the only
 * thing allowed to have an opinion about it.
 *
 * Its whole job is to turn a gap between two beats into one wake, and one
 * wake into at most one nudge per agent. Everything about who gets one is in
 * `toContinue`; everything about when there was a wake at all is in `beat`.
 */
export class Waker {
  private readonly napped: Napped
  private readonly say: (said: string) => void
  private waking: Waking = AWAKE
  /**
   * By run: the wake each agent was last told about, so one sleep is one
   * continue however many beats go by — and an agent that dies again after
   * being told is left alone rather than nudged into a loop with a long
   * period. A new wake is a genuinely new event and gets its own.
   */
  private readonly told = new Map<string, number>()
  /** By run: what each agent was doing at the last beat, which is what a wake reads. */
  private before = new Map<string, Napping['turn']>()

  constructor(napped: Napped, say: (said: string) => void) {
    this.napped = napped
    this.say = say
  }

  /**
   * The window's beat. Cheap, synchronous in everything that decides, and
   * asynchronous only in the telling: two beats must never read one wake as
   * two, and the state that stops that is settled before anything is awaited.
   */
  beats(now: number): void {
    const agents = this.napped.agents()
    this.waking = beat(this.waking, now)
    const { slept, wakes } = this.waking
    if (slept !== null) void this.wake(agents, wakes, slept)
    this.before = new Map(agents.map((one) => [one.run, one.turn]))
  }

  private async wake(agents: readonly Napping[], wake: number, slept: number): Promise<void> {
    // Alive and continuable as they are now; mid-turn as they were before the
    // machine went. Only the last of the three can go stale on a wake.
    const napping = agents.map((one) => ({ ...one, turn: this.before.get(one.run) ?? 'unknown' }))
    const cut = toContinue(napping, this.told, wake)
    if (cut.length === 0) return
    const told: string[] = []
    for (const one of cut) {
      // Written down before it is sent, not after: a nudge that throws is a
      // nudge this agent has had for this wake, and the thing that must never
      // happen is a second one on the next beat, and a third on the one after.
      this.told.set(one.run, wake)
      try {
        await this.napped.continue(one, slept)
        told.push(one.task)
      } catch (err) {
        this.say(couldNotContinue(one.task, why(err)))
      }
    }
    if (told.length > 0) this.say(wokeSaid(slept, told))
  }
}

/**
 * The window's waker, reading the agents off the workbench and saying what it
 * did where a person who has just come back reads it: in Tade's own voice,
 * because a sleeping laptop is nothing going wrong with Tade, and in the
 * transcript rather than as a notice, because the whole point is that nobody
 * was at the keyboard when it happened.
 *
 * The orchestrator is told separately and not from here: `agent_continued` is
 * in the journal, and `eventNews` is the channel it already hears about
 * agents through.
 */
export function wakerOf(wire: Wiring): Waker {
  const { client } = wire.opts
  return new Waker(
    {
      agents: () =>
        client.runs().map((handle) => ({
          task: handle.task,
          run: handle.run,
          turn: client.turnOf(handle.run),
          // A run with no lane is one Tade draws itself, which is the
          // orchestrator's shape and is not supervised here anyway.
          alive: handle.lane !== null && client.lane(handle.lane)?.alive === true,
          // Declared by the harness, never read off its name: one that cannot
          // pick a cut-off turn back up is told nothing and said instead.
          continues: client.capabilitiesOf(handle.harness ?? '')?.continues === true,
        })),
      continue: (agent, slept) => client.continueRun(agent.run, slept),
    },
    (said) => {
      wire.put(withTranscript(wire.state, tadeDid(wire.state.transcript, said, wire.now())))
      wire.draw()
    },
  )
}

import type { ThereLine } from '../transcript.ts'
import { withThere } from '../transcript.ts'
import type { Wiring } from './context.ts'

// One orchestrator strip on every machine: another machine's turns of the one
// conversation, drawn here as they run there.
//
// **The conversation is already one** (`conversation.ts`, `one-conversation.ts`):
// one record, exchanged between turns, one turn at a time under the hub's
// lease. What was not one was the *drawing* — a turn the hub ran reached this
// window's strip only once its record was exchanged, and the Mac drew the hub
// on a tab of its own. What each machine is doing is already here as it
// happens, though, in its projection: the Mac follows the hub's stream, and
// tells the hub its own every two seconds (`projection-shared.ts`). So each
// heart folds the lines of every machine whose turns are this conversation's
// into its own transcript (`withThere`), marked with that machine's name, and
// everything that draws the transcript — this strip, the log of a `tade serve`,
// the away page through `chatLines` — draws one conversation.
//
// **Showing is reading, not acting**: nothing folded is a `said` line, nothing
// reaches the orchestrator from here (its record carries the turn), and a name
// or a word another machine wrote is drawn as text and nothing else.
//
// **Never an echo**: a line another machine folded in from somewhere else, or
// read back out of its own record, is left out (`ThereLine.there`, `read`) —
// it may be this machine's own turn coming back. And only what was said since
// this heart opened: what came before is this machine's record to draw.

/** One machine whose turns are turns of this conversation, and its lines as its projection carries them now. */
export interface TalkThere {
  machine: string
  /** Oldest first; the same array while that machine's projection has not moved. */
  lines: readonly ThereLine[]
  /** This machine's device there, as that machine names who asked (`device <id>`), or null. */
  own: string | null
}

export interface FleetTalkDeps {
  /** Every machine whose turns are this conversation's, as of now. Cheap: read on every beat. */
  sources(): readonly TalkThere[]
}

export class FleetTalk {
  private readonly wire: Wiring
  private readonly deps: FleetTalkDeps
  /** The lines each machine's fold was last made from, so a beat that moved nothing does nothing. */
  private readonly folded = new Map<string, readonly ThereLine[]>()

  constructor(wire: Wiring, deps: FleetTalkDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * Fold in what moved: on the beat, and whenever a machine's projection
   * arrives. Never throws, never waits: it is the transcript and a few lines.
   */
  fold(): void {
    const before = this.wire.state.transcript
    let transcript = before
    const seen = new Set<string>()
    for (const one of this.deps.sources()) {
      seen.add(one.machine)
      if (this.folded.get(one.machine) === one.lines) continue
      this.folded.set(one.machine, one.lines)
      transcript = withThere(transcript, one.machine, one.lines, this.wire.openedAt, one.own)
    }
    // A machine no longer sharing this conversation: looked at afresh if it comes back.
    for (const name of [...this.folded.keys()]) if (!seen.has(name)) this.folded.delete(name)
    if (transcript === before) return
    this.wire.put({ ...this.wire.state, transcript })
    this.wire.draw()
  }
}

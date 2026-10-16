import { withTranscript } from '../model.ts'
import { tadeDid } from '../transcript.ts'
import { type Wiring, why } from './context.ts'

// A document handed over, told to the orchestrator now (`eventTell`).
//
// A free function over the wiring rather than a method on `Orchestrator`,
// which is at its budget, and because what it decides is small: told now,
// or kept as news — while there is no orchestrator yet to tell, and when a
// tell did not reach it — so the document goes with the next thing somebody
// says rather than nowhere. A tell that failed is said on screen too:
// nothing goes wrong silently, and a document waiting on the person is the
// last thing that may.

/** What telling needs of the orchestrator: whether it is there, and its two channels. */
export interface Tellable {
  readonly started: boolean
  tell(text: string): Promise<void>
  note(text: string): void
}

/**
 * Tell it now, or keep it as news where it cannot be told, saying why on
 * screen. `what` is what was being told, in a clause: a document, a schedule
 * that came due, what a watch found.
 */
export function tellOrKeep(
  wire: Wiring,
  orchestrator: Tellable,
  text: string,
  what = 'a document was handed over',
): void {
  if (!orchestrator.started) {
    orchestrator.note(text)
    return
  }
  void orchestrator.tell(text).catch((err) => {
    orchestrator.note(text)
    const said = `Could not tell the orchestrator ${what} (${why(err)}), so it goes with the next thing you say.`
    wire.put(withTranscript(wire.state, tadeDid(wire.state.transcript, said, wire.now())))
  })
}

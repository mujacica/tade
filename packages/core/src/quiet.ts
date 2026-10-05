// A turn that ended with nothing said.
//
// The worst failure the conversation has, because it looks exactly like
// thinking. The orchestrator calls a tool, the tool answers, the turn ends —
// and the spinner is still turning over a model that has stopped, so the
// person waits, gives up, and asks again for something that already happened.
// It was reported ten times before any of this existed, every time as "it went
// quiet", and every time the turn had in fact finished.
//
// Both halves are here together on purpose, because they are one rule. The
// first is what the orchestrator is told, and it is the actual fix: the only
// turn that can say what a tool answered is the turn that called it. The
// second is what Tade says when it happens anyway — a net under the rule, not
// the rule — and it names the tool the turn ended on rather than announcing
// "done", because a "done" that fires after every tool call is a sentence
// nobody can trust, and that is worse than silence.
//
// Pure: words. No clock, no I/O.

/**
 * Said in the prompt, because this is the half that can be done properly.
 *
 * Nothing outside the turn knows what a tool told it or what the turn decided
 * on reading it, so nothing outside the turn can write the missing sentence —
 * it can only report that the sentence is missing. The last clause matters as
 * much as the first: a turn with genuinely nothing to say has a wrong tool
 * call in it, and the honest answer is to say so.
 */
export const NEVER_GO_QUIET =
  'Never end a turn with nothing said. A turn that ends on a tool call and says nothing after it ' +
  'looks exactly like thinking: the person waits on a spinner, then asks again for what has ' +
  'already happened. So once the last tool has answered, say what it answered and what you ' +
  'decided; if you are finished, say you are finished. A turn with genuinely nothing to say is a ' +
  'turn whose last tool call was the wrong one, and saying that is the answer — "I ran X, and it ' +
  'says nothing about Y" is worth far more than silence.'

/**
 * What Tade says where the person was waiting, when a turn ended on a tool
 * call and said nothing after it.
 *
 * It names the tool and then stops. What the tool answered is the model's to
 * say and Tade would be inventing it from a one-line summary; what Tade can
 * say is the one thing a spinner cannot — that this is over. The tool is
 * spelled the way the surface saying it spells tools everywhere else.
 */
export function wentQuiet(tool: string): string {
  return (
    `The orchestrator ran ${tool} and ended the turn without saying anything: ` +
    'it has finished, and is not still thinking.'
  )
}

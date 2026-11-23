import type { ConversationPlace } from '@tade/app/wire/conversation'
import { conversationCopies, OneConversation, SharedConversation } from '@tade/harnesses-core'
import { ORCHESTRATOR_TASK, type Orchestrator } from '@tade/orchestrator'

// The orchestrator's conversation made one on every machine, once it has
// started (`@tade/harnesses-core`'s `one-conversation.ts`): its record, the
// copies this home keeps of the other machines', and the gate around each of
// its turns. For whatever holds the home — the window or `tade serve` — the
// same, so the two can never keep the conversation in two ways.
//
// Only on a harness that can (`capabilities.conversation.replicate`); on any
// other each machine keeps a conversation of its own, as it always did.

/**
 * Its conversation shared, or nothing where its harness keeps one per machine.
 * What it could not open is written down and it runs as a conversation of
 * this machine's alone.
 */
export async function shareConversation(
  started: Orchestrator,
  place: ConversationPlace,
  cwd: string,
): Promise<OneConversation | null> {
  const replica = started.replica
  if (!replica) return null
  const shared = new SharedConversation({
    home: place.home,
    me: place.me(),
    harness: started.harness,
    format: replica.format,
    record: await replica.recordFor(ORCHESTRATOR_TASK, cwd),
    take: (lines, leaf) => replica.take(ORCHESTRATOR_TASK, cwd, lines, leaf),
    warn: (text) => place.warn(text),
  })
  // The machines it already keeps a copy of, so a hub that restarted takes
  // their turns in before anybody asks it anything.
  await shared.known(await conversationCopies(place.home))
  const one = new OneConversation({
    shared,
    hub: () => place.hub(),
    reload: () => started.reload(),
    say: (text) => place.say(text),
    warn: (text) => place.warn(text),
    took: () => place.took(),
    now: () => place.now(),
    clock: (at) => place.clock(at),
  })
  started.useTurns(one)
  place.use(one)
  return one
}

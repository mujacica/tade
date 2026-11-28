import { BUDGET } from './page.ts'
import type { ChatPage } from './protocol.ts'
import type { Reach } from './reach.ts'
import { inTime } from './request.ts'
import type { ServerOptions } from './serving.ts'

// The route that reads further back than a page holds: the conversation with
// Tade (`GET /api/chat?before=`). **Everything said can be read on the
// phone**, so a page scrolled to the end of what it holds asks for what came
// before, and nothing is only in the window. A line's id is only ever
// compared, and one that does not look like one is answered as nothing.

/**
 * How long reading a conversation's record further back may take before the
 * page is told it could not be read now. A page of a record is milliseconds;
 * this is for a disk that has stopped answering.
 */
export const EARLIER_MS = 5_000

/**
 * What a line's id may look like to be compared: the window's are the moment
 * it was said and its place in it (`chatLines`), and only ever compared.
 */
const LINE_ID = /^[\w:.#-]{1,64}$/

/** The window's half: reading a conversation's record further back than it holds. */
export interface WebEarlier {
  /**
   * Hold at least `want` lines of the conversation with Tade from before the
   * line `before` names, reading the orchestrator's record further back where
   * the window does not hold that many — the window's own scrollback
   * (`Earlier`), so what is read is the window's too. `false` is a record that
   * could not be read; the window says where it happened.
   */
  talk(before: string, want: number): Promise<boolean>
}

/** The lines before `before`, after the window was asked to hold them. */
export async function chatHere(
  before: string | null,
  reach: Reach,
  opts: Pick<ServerOptions, 'readingFor' | 'earlier'>,
): Promise<ChatPage> {
  const reading = opts.readingFor(reach)
  const at = before ?? ''
  // Never echoed back as it came: a name that is not a line's is answered as
  // the beginning, which asks the window for nothing.
  if (!LINE_ID.test(at)) return { ...reading.chat(''), earlier: false }
  if (opts.earlier === undefined) return reading.chat(at)
  const read = await inTime(opts.earlier.talk(at, BUDGET.chat), EARLIER_MS, false)
  const page = reading.chat(at)
  // What was held is answered all the same, and the page asks again.
  return read || page.why !== null ? page : { ...page, why: 'unread', earlier: true }
}

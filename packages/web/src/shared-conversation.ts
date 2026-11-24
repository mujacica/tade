import type { IncomingMessage } from 'node:http'
import { type ConversationAsk, ConversationBody } from '@tade/core'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs } from './surface.ts'

// One orchestrator conversation on every machine of the person's: the machine
// that holds the link asks, because this machine can never call it, and each
// request gives conversation entries this machine lacks, asks for ones that
// one lacks, and may take, renew, look at or let go of the turn lease this
// machine keeps as the hub. The heart's half (`@tade/harnesses-core`'s
// `one-conversation.ts`, wired in `@tade/app`'s `wire/conversation.ts`) checks
// each count against the chain over the lines up to it, keeps the copy apart
// from this machine's own record under `<home>/machines/<id>/`, and answers.
//
// **An owner's, and only at this machine's own door** (`here` in `routes.ts`),
// like the journal beside it — **and the person's own device too** (`theirs`):
// what is written is a copy in this home, which the SSH key could write, and
// what is read is the conversation the person's phone already reads.
//
// **Bounded, and checked as text before anything reads it** — by the schema
// beside the other bodies two machines exchange (`@tade/core`'s
// `ConversationBody`). The body is the server's 64 KB at most, so a line
// longer than one request comes in pieces.

/** What `POST /api/conversation` answers: the heart's `ConversationAnswer`. */
export interface ConversationShareAnswer {
  machine: { id: string; name: string }
  harness: string
  held: unknown
  after: number
  lines: unknown[]
  more: boolean
  entries: number
  lease?: unknown
  refused?: string
}

/**
 * What the heart answers while its orchestrator is still coming up: not
 * trouble, and answered as `starting` (503, with a wait) rather than `broke`.
 */
export const STARTING = 'starting'

/**
 * The heart's half: take what was given, ask the lease, and answer —
 * `STARTING` while there is no orchestrator yet to answer for. Throws the reason.
 */
export type WebConversation = (
  body: ConversationAsk,
) => Promise<ConversationShareAnswer | typeof STARTING>

/** How long a machine that asked while the orchestrator here was starting waits, in seconds. */
const STARTING_AFTER = 5

/** The route: an owner's body read once, checked, and handed to the heart. */
export async function conversationHere(
  req: IncomingMessage,
  device: Device,
  conversation: WebConversation | undefined,
): Promise<{ body: ConversationShareAnswer } | { refusal: Refusal }> {
  if (conversation === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = ConversationBody.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  const answer = await conversation(parsed.data)
  if (answer === STARTING) return { refusal: refuse('starting', { after: STARTING_AFTER }) }
  return { body: answer }
}

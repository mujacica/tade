import { z } from 'zod'
import { MACHINE_ID } from './feeds.ts'

// One orchestrator conversation on every machine (`@tade/orchestrator`'s
// `one-conversation.ts`): what one request of its exchange may say, as the far
// side's door reads it before anything else does (`@tade/web`'s
// `shared-conversation.ts`). Here, beside the other bodies two machines
// exchange, because the away view's own package keys nothing to a record's
// numbers.
//
// A request gives the asking machine's canonical entries after what the far
// side said it holds of them, asks for the far side's after what this side
// holds, and may take, renew, look at or let go of the turn lease the hub
// keeps. Every count travels with the chain over the lines up to it, so a
// count that does not mean what it meant is caught rather than trusted. A line
// too long for one request goes in pieces, like a journal's.

/** The most of one line one request carries; a longer line goes in pieces. */
export const SHARE_LINE = 48 * 1024

const Count = z.int().nonnegative()
const Hash = z.string().regex(/^[0-9a-f]{64}$/)

/** What a lease request asks of the hub. */
export const LEASE_OPS = ['take', 'renew', 'release', 'look'] as const
export type LeaseOp = (typeof LEASE_OPS)[number]

export const ConversationBody = z.strictObject({
  from: z.strictObject({ id: z.string().regex(MACHINE_ID), name: z.string().min(1).max(120) }),
  /** Which harness the asking machine's orchestrator runs on: every machine must run the same. */
  harness: z.string().min(1).max(64),
  give: z
    .strictObject({
      after: Count,
      h: Hash,
      lines: z.array(z.string().max(SHARE_LINE)).max(2_000),
      piece: z
        .strictObject({ text: z.string().max(SHARE_LINE), from: Count, done: z.boolean() })
        .optional(),
    })
    .optional(),
  want: z.strictObject({ after: Count, h: Hash, piece: Count.optional() }).optional(),
  lease: z.strictObject({ op: z.enum(LEASE_OPS), key: z.string().min(1).max(64) }).optional(),
})

export type ConversationAsk = z.infer<typeof ConversationBody>

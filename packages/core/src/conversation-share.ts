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
//
// Beside the entries go the files a harness keeps beside its record that an
// entry names — Claude Code's large tool results — by their name there: what
// the asking machine lacks of the far side's, a piece of one the far side
// lacks of its, and the ones it was asked for and has nowhere.

/** The most of one line one request carries; a longer line goes in pieces. */
export const SHARE_LINE = 48 * 1024

/**
 * A file kept beside a record, by its name there: one folder and one file,
 * neither beginning with a dot, so no name a far machine sends can lead out
 * of the folder it is written into.
 */
export const BESIDE_NAME = /^[a-z][a-z-]{0,31}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/

/** How many names one request says it wants, or has nowhere. */
export const BESIDE_ASKED = 8

const Count = z.int().nonnegative()
const Hash = z.string().regex(/^[0-9a-f]{64}$/)
const BesideName = z.string().regex(BESIDE_NAME)

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
  files: z
    .strictObject({
      /** What the asker lacks of the far side's files, each from the bytes it holds of it. */
      want: z.array(z.strictObject({ name: BesideName, from: Count })).max(BESIDE_ASKED),
      /** A piece of one the far side said it lacks, in base64. */
      give: z
        .strictObject({
          name: BesideName,
          from: Count,
          data: z.base64().max(SHARE_LINE),
          done: z.boolean(),
        })
        .optional(),
      /** The ones the far side said it lacks that the asker has nowhere. */
      gone: z.array(BesideName).max(BESIDE_ASKED),
    })
    .optional(),
  lease: z.strictObject({ op: z.enum(LEASE_OPS), key: z.string().min(1).max(64) }).optional(),
})

export type ConversationAsk = z.infer<typeof ConversationBody>

/** The most one answer of the far side carries, in entries and in a file's piece. */
export const SHARE_ANSWER = 512 * 1024

/**
 * What the far side answers, as the asking machine reads it before anything
 * else does: whatever another machine's door sends back is text from that
 * machine, so nothing of it is trusted for its shape. A field this does not
 * name is dropped rather than refused, so a newer Tade there still answers.
 */
export const ConversationReply = z.object({
  machine: z.object({ id: z.string().regex(MACHINE_ID), name: z.string().min(1).max(120) }),
  harness: z.string().min(1).max(64),
  held: z.object({ after: Count, h: Hash, piece: Count.optional() }),
  after: Count,
  // Every line is at least one character of the answer's bytes, so there are never more.
  lines: z.array(z.string().max(SHARE_LINE)).max(SHARE_ANSWER),
  piece: z.object({ text: z.string().max(SHARE_LINE), from: Count, done: z.boolean() }).optional(),
  more: z.boolean(),
  entries: Count,
  lease: z
    .object({
      granted: z.boolean(),
      holder: z.object({ name: z.string().min(1).max(120), since: z.number() }).optional(),
    })
    .optional(),
  refused: z.string().max(4_096).optional(),
  files: z
    .object({
      lacks: z.array(z.object({ name: BesideName, from: Count })).max(BESIDE_ASKED),
      piece: z
        .object({
          name: BesideName,
          from: Count,
          data: z.base64().max(SHARE_ANSWER),
          done: z.boolean(),
        })
        .optional(),
      gone: z.array(BesideName).max(BESIDE_ASKED),
    })
    .optional(),
})

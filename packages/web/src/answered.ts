import { z } from 'zod'
import { PROTOCOL_VERSION } from './protocol.ts'
import { cleanText } from './screen.ts'

// One tool call's answer, whole, for the page that opened it.
//
// **Never cut.** A row of a conversation carries whether its call answered and
// nothing of what it said (`CallSchema.answered`); opening it asks for this,
// and what comes back is the whole of what the harness's own record kept —
// five lines or five thousand, no bound and no line saying how much more there
// was, because there is none. The window reads it from that record when it is
// asked (`WebAnswers`), so a conversation of a hundred test runs is not held
// in memory for a page somebody may never open.
//
// **The same reach as the conversation it is part of**: an agent's on `lanes`
// for a task the device reads, the conversation with Tade's on `talk` and
// `lanes` together (`withCalls`) — and the same rule at the boundary, every
// path, key and credential taken out (`cleanText`). A device out of reach is
// told only that, never whether the call is there.
//
// Pure: no `node:` import, no clock, nothing awaited.

/** What a call's id has to look like to be asked for: a harness's own, never a path. */
export const CALL_ID = /^[\w.:-]{1,120}$/

export const ANSWER_SAYS = [
  /** `text` is the whole of what it answered. */
  'words',
  /** It answered, and what it answered was nothing. */
  'nothing',
  /** No answer to it was recorded: cut short, still going, or the harness kept none. */
  'unrecorded',
  /** The record is there and could not be read. */
  'unread',
  /** Not a task this device reads, or no such task. One answer, so neither is told apart. */
  'not here',
  /** This device was not granted an agent's own bytes. */
  'not granted',
] as const

export const CallAnswerSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  /** The call, as it was asked for. */
  call: z.string(),
  says: z.enum(ANSWER_SAYS),
  /** The whole of what it answered, cleaned. Null for every `says` but `words`. */
  text: z.string().nullable(),
  /** How many things were taken out of it. A count, never what. */
  taken: z.int().nonnegative(),
})
export type CallAnswer = z.infer<typeof CallAnswerSchema>

/**
 * What the window read of one call: its whole answer, or null where none was
 * recorded. `unread` is a record that is there and could not be read.
 */
export type AnswerIn = { result: string } | null | 'unread'

/**
 * The window's half: one call's answer, out of the record of the conversation
 * it is in. Each throws, or answers `unread`, for a record it could not read.
 */
export interface WebAnswers {
  /** One call an agent made, out of its harness's record for that task. */
  agent(task: string, call: string): Promise<AnswerIn>
  /** One call the orchestrator made, out of its own harness's record. */
  talk(call: string): Promise<AnswerIn>
  /** Every value the window knows to be a key, taken out exactly (`knownKeys`). */
  known(): readonly string[]
}

/** One call's answer as a device is sent it. */
export function answerOut(
  call: string,
  read: AnswerIn | 'not here' | 'not granted',
  known: readonly string[],
): CallAnswer {
  const base = { v: PROTOCOL_VERSION, call, text: null, taken: 0 } as const
  if (read === 'not here' || read === 'not granted' || read === 'unread') {
    return { ...base, says: read }
  }
  if (read === null) return { ...base, says: 'unrecorded' }
  if (read.result === '') return { ...base, says: 'nothing' }
  const clean = cleanText(read.result, known)
  return { ...base, says: 'words', text: clean.text, taken: clean.taken }
}

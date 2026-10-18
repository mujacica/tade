import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { type Reach, sees } from './reach.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs, reachOf } from './surface.ts'

// One document this machine's work produced, as text, for another machine of
// the person's to read (REMOTE-TADE.md §9.6: documents stay the truth on the
// machine that made them, and the other one reads them). The list of them is
// `machine.ts`'s; this is the reading of one.
//
// **An owner's, and only at this machine's own door** (`here`): the document is
// a file in this machine's Tade home, which whoever holds the SSH key can
// already `cat` over the same connection — and a phone's session is refused it
// however much it was granted, **but the person's own** (`Route.theirs`), on
// any door, whom the person decided may do what they can. Within what the device reads: a document of a
// project the window took back from it is the `404` of one that is not there.
//
// **Asked by what the list named it**: its task and its file's name, never a
// path — the window looks the pair up among the documents its journal says
// were written and reads only that file, so no name can walk anywhere else.
// What an agent wrote is not scrubbed and not reworded, the way a note is not;
// the machine that reads it draws it as text. Past `DOCUMENT_MOST` it is cut and
// says so. It changes nothing and writes nothing.

/** The most of one document one answer carries, in characters. */
export const DOCUMENT_MOST = 256 * 1024

/** A task id, as core's `TaskId` shapes one. */
const TASK = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/
/** A file's name, and nothing that walks: no separator, and not `.` or `..`. */
const NAME = /^(?!\.\.?$)[^/\\\0]{1,200}$/

export const DocumentAskSchema = z.strictObject({
  task: z.string().max(200).regex(TASK),
  name: z.string().regex(NAME),
})
export type DocumentAsk = z.infer<typeof DocumentAskSchema>

/** The answer, read for its shape by the machine that asked. */
export const DocumentAnswerSchema = z.object({
  task: z.string().max(200),
  name: z.string().max(200),
  /** When it finished, as this machine's journal says. */
  at: z.string().max(40),
  text: z.string().max(DOCUMENT_MOST),
  /** How big the file is, in bytes. */
  bytes: z.int().nonnegative(),
  /** It is longer than `text`: what is here is its start. */
  cut: z.boolean(),
})
export type DocumentAnswer = z.infer<typeof DocumentAnswerSchema>

/**
 * The window's half: the one document its journal says this task produced
 * under this name, read, or null where there is no such document to read.
 */
export type WebDocument = (
  ask: DocumentAsk,
) => Promise<{ at: string; text: string; bytes: number } | null>

/** The route. `document` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function documentHere(
  req: IncomingMessage,
  device: Device,
  document: WebDocument | undefined,
): Promise<{ body: DocumentAnswer } | { refusal: Refusal }> {
  if (document === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const asked = DocumentAskSchema.safeParse(got.body)
  if (!asked.success) return { refusal: refuse('malformed') }
  if (!documentReadable(asked.data, reachOf(device))) return { refusal: refuse('no_such') }
  const read = await document(asked.data)
  if (read === null) return { refusal: refuse('no_such') }
  const cut = read.text.length > DOCUMENT_MOST
  return {
    body: {
      task: asked.data.task,
      name: asked.data.name,
      at: read.at.slice(0, 40),
      text: cut ? read.text.slice(0, DOCUMENT_MOST) : read.text,
      bytes: read.bytes,
      cut,
    },
  }
}

/** Whether a device may read a document of this task: its project is one it reads. */
export function documentReadable(ask: DocumentAsk, reach: Reach): boolean {
  return sees(reach, ask.task.slice(0, ask.task.indexOf('/')))
}

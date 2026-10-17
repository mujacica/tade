import type { IncomingMessage } from 'node:http'
import { MACHINE_NAMED } from '@tade/core'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// Notes shared between this machine and another of the person's
// (REMOTE-TADE.md §4.5, §9.6): the person's words reach both orchestrators and
// every agent, whichever machine they were said to. The window that holds the
// link asks, because this machine can never call it; each request gives lines
// this machine lacks and asks for lines that one lacks, and the window's half
// (`@tade/workbench`'s `notes-shared.ts`) takes them into this home's own
// `memory.jsonl` and answers.
//
// **An owner's, and only at this machine's own door** (`here` in
// `routes.ts`), like the carry beside it: the person's notes are written here,
// and every agent here is told them, so only the SSH key that could already
// append to the file may add to it. A phone's session is refused it however
// much it was granted, and the public listener answers the `404` of a path
// nobody built.
//
// **Bounded, and checked as text before anything reads it.** Each line is a
// string the window's half parses and refuses unless it is one of the file's
// own kinds; where a note was taken is a name `MACHINE_NAMED` allows, because
// it is drawn; a digest is sixteen hex digits. The body is the server's 64 KB
// at most, so the far side gives in rounds.

/** The longest line one request may give: a note longer than this stays where it was taken. */
const LINE_MOST = 32_000

const Named = z.string().regex(MACHINE_NAMED)

const Digest = z.string().regex(/^[0-9a-f]{16}$/)

const NotesBody = z.strictObject({
  /** What the machine asking calls itself: where a note it took down was taken. */
  from: Named,
  /** Opens an exchange: the sum of the asker's lines, to be told every digest here where it differs. */
  sum: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  give: z
    .array(z.strictObject({ line: z.string().min(2).max(LINE_MOST), from: Named.optional() }))
    .max(2_000),
  want: z.array(Digest).max(1_000),
})

export type NotesBody = z.infer<typeof NotesBody>

/** What `POST /api/notes/share` answers: the window's half's `NotesAnswer`. */
export interface NotesShareAnswer {
  machine: string
  sum: string
  have?: string[]
  lines: { line: string; from?: string }[]
  took: number
  refused: number
}

/** Who a share is from, as the window writes it down. */
export interface SharedBy {
  device: string
  /** What the machine that asked calls itself. */
  from: string
}

/** The window's half: take what was given into this home's notes, and answer. Throws the reason. */
export type WebNotes = (body: NotesBody, by: SharedBy) => Promise<NotesShareAnswer>

/**
 * The route: an owner's body read once, checked, and handed to the window.
 * `notes` absent is a window that did not wire it, which is the `404` of a
 * path nobody built.
 */
export async function shareHere(
  req: IncomingMessage,
  device: Device,
  notes: WebNotes | undefined,
): Promise<{ body: NotesShareAnswer } | { refusal: Refusal }> {
  if (notes === undefined) return { refusal: refuse('no_such') }
  if (!device.owner) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = NotesBody.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  return { body: await notes(parsed.data, { device: device.id, from: parsed.data.from }) }
}

import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs } from './surface.ts'

// Another machine of the person's telling this one its whole projection, so
// this machine's page can draw it — live while that machine is up, and as of
// its last word while it is not (ONE-AWAY-VIEW step 2).
//
// **Only the Mac can dial** (it is behind a NAT and sleeps), so ipax would
// otherwise hold the Mac's journal and conversation but no picture of what it
// is doing. The Mac follows ipax's stream for ipax's projection; this is the
// same thing the other way, posted over the one connection the Mac already
// holds, because ipax can never call it.
//
// **An owner's, at this machine's own door** (`here`), like the feeds and the
// notes beside it — and the person's own device's (`theirs`), as every route
// in `OWNED` is: what is written is a copy in this home, which the SSH key
// could write, and a phone telling one is telling this machine about itself.
//
// **The cursor is `(epoch, rev)`**, the away protocol's own, minted by the
// machine that sends: another epoch is a whole projection, and a change says
// the revision it was made from, which this machine must be at or answer
// `gap` (and is then sent it whole). Nothing reads `seq` or a byte offset.
//
// **In pieces, because a body is 64 KB** (`BODY_MAX`) and a projection is
// several hundred: each piece is text, the pieces of one revision put back
// together here in order (`Pieces`), and only a whole one handed on. What
// they put together is another machine's text, read for its shape by the
// window's half before anything draws it (`readSnapshot`, `readDelta`).

/** How many pieces one revision may come in: 64 of at most `PIECE` characters, a few megabytes. */
export const PIECES = 64

/** How many characters of a projection one piece carries at most. */
export const PIECE = 40_000

/** How much of a body a piece may weigh, under the server's 64 KB with room for the envelope. */
const BODY_ROOM = 60_000

const EPOCH = /^[0-9a-fA-F-]{8,64}$/

const Told = z.strictObject({
  kind: z.enum(['whole', 'change']),
  epoch: z.string().regex(EPOCH),
  rev: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** The revision a change was made from. */
  from: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  piece: z
    .int()
    .nonnegative()
    .max(PIECES - 1),
  of: z.int().positive().max(PIECES),
  text: z.string().max(PIECE),
})
export type ProjectionPiece = z.infer<typeof Told>

/** One revision, put back together: a whole projection's text, or a change's. */
export type ProjectionTold =
  | { kind: 'whole'; epoch: string; rev: number; text: string }
  | { kind: 'change'; epoch: string; rev: number; from: number; text: string }

/**
 * What a piece came to: `piece` is one more of a revision still arriving,
 * `kept` is a revision taken, `gap` is a change this machine is not at the
 * revision of — send it whole — and `refused` is text that did not read.
 */
export const ProjectionAnswerSchema = z.object({
  kept: z.enum(['piece', 'kept', 'gap', 'refused']),
})
export type ProjectionAnswer = z.infer<typeof ProjectionAnswerSchema>

/** The window's half: take one revision of what that machine said, by the name it is seen by. */
export type WebProjectionTold = (
  told: ProjectionTold,
  device: string,
  label: string,
) => Promise<'kept' | 'gap' | 'refused'>

/**
 * The pieces of one revision per device, put back together in order.
 *
 * One revision in flight per device and no more: a piece of another revision
 * starts over, a piece out of order starts over, and so the memory this holds
 * is at most `PIECES × PIECE` characters per device that may tell one. Pure,
 * in the sense this repository holds: no clock, nothing to await.
 */
export class Pieces {
  private readonly held = new Map<string, { key: string; parts: string[] }>()

  /** One piece taken: the whole revision once its last piece has come, else null. */
  take(device: string, piece: ProjectionPiece): ProjectionTold | null {
    if (piece.piece >= piece.of) return null
    if (piece.kind === 'change' && piece.from === undefined) return null
    const key = `${piece.kind} ${piece.epoch} ${piece.rev} ${piece.from ?? ''} ${piece.of}`
    const was = this.held.get(device)
    if (piece.piece === 0) this.held.set(device, { key, parts: [piece.text] })
    else if (was === undefined || was.key !== key || was.parts.length !== piece.piece) {
      this.held.delete(device)
      return null
    } else was.parts.push(piece.text)
    const now = this.held.get(device)
    if (now === undefined || now.parts.length < piece.of) return null
    this.held.delete(device)
    const text = now.parts.join('')
    return piece.kind === 'whole'
      ? { kind: 'whole', epoch: piece.epoch, rev: piece.rev, text }
      : { kind: 'change', epoch: piece.epoch, rev: piece.rev, from: piece.from ?? 0, text }
  }

  /** Whether a revision is part way here for this device. */
  arriving(device: string): boolean {
    return this.held.has(device)
  }
}

/**
 * One revision as the bodies that carry it, each under the server's bound.
 *
 * Cut by characters and then measured as the body would be written, because a
 * projection's text is JSON and a quote in it is two characters once it is a
 * string inside another — and a piece that does not fit is cut smaller.
 * Throws where the revision would take more than `PIECES`: a projection that
 * large is said by the sender, never sent in part.
 */
export function piecesOf(told: ProjectionTold): ProjectionPiece[] {
  const envelope = {
    kind: told.kind,
    epoch: told.epoch,
    rev: told.rev,
    ...(told.kind === 'change' ? { from: told.from } : {}),
  }
  const texts: string[] = []
  let at = 0
  while (at < told.text.length || texts.length === 0) {
    let size = Math.min(PIECE, told.text.length - at)
    for (;;) {
      const text = told.text.slice(at, at + size)
      const body = { ...envelope, piece: PIECES - 1, of: PIECES, text }
      if (Buffer.byteLength(JSON.stringify(body)) <= BODY_ROOM || size <= 1) break
      size = Math.floor(size / 2)
    }
    texts.push(told.text.slice(at, at + size))
    at += size
    if (texts.length > PIECES) {
      throw new Error(`a projection of ${told.text.length} characters is more than one may send`)
    }
    if (size === 0) break
  }
  return texts.map((text, piece) => ({ ...envelope, piece, of: texts.length, text }))
}

/** The route. `told` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function projectionHere(
  req: IncomingMessage,
  device: Device,
  told: { pieces: Pieces; take: WebProjectionTold } | undefined,
): Promise<{ body: ProjectionAnswer } | { refusal: Refusal }> {
  if (told === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const piece = Told.safeParse(got.body)
  if (!piece.success) return { refusal: refuse('malformed') }
  const whole = told.pieces.take(device.id, piece.data)
  if (whole === null) {
    // A piece that was not the next of what is arriving started nothing:
    // answered as a gap, so the sender starts that revision over whole.
    return { body: { kept: told.pieces.arriving(device.id) ? 'piece' : 'gap' } }
  }
  return { body: { kept: await told.take(whole, device.id, device.label) } }
}

import type { IncomingMessage } from 'node:http'
import { FeedsBody as FeedsSchema } from '@tade/core'
import type { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs } from './surface.ts'

// Every machine's journal on every machine of the person's: the window
// that holds the link asks, because this machine can never call it, and each
// request gives lines of journals this machine lacks and asks for lines that
// one lacks. The window's half (`@tade/workbench`'s `feeds.ts`) checks each
// line against the hash chain, keeps the copies apart from this machine's own
// journal under `<home>/machines/<id>/`, and answers.
//
// **An owner's, and only at this machine's own door** (`here` in `routes.ts`),
// like the notes beside it — **but the person's own device too** (`theirs`):
// what is written is a copy in this home, which the SSH key could write, and
// what is read is a journal the person's phone already reads the gist of.
//
// **Bounded, and checked as text before anything reads it** — by the schema
// beside the rules that make its cursor safe (`@tade/core`'s `FeedsBody`): a
// machine id is a UUID, an epoch sixteen hex digits, a chain link sixty-four,
// a line a string. Nothing in this package keys anything to a journal's
// numbers (`test/protocol.test.ts`); the feeds' own cursor carries its epoch
// and chain, which is what makes one safe there. The body is the server's 64
// KB at most, so a line longer than one request comes in pieces.

export type FeedsBody = z.infer<typeof FeedsSchema>

/** What `POST /api/feeds/share` answers: the window's half's `FeedsAnswer`. */
export interface FeedsShareAnswer {
  machine: { id: string; name: string }
  have?: unknown[]
  sync?: unknown
  lines: unknown[]
  took: unknown[]
  state?: unknown
}

/**
 * The window's half: take what was given into the copies here, and answer.
 * Throws the reason. `label` is what the device paired as — what a machine
 * that links here is seen by (`/api/seen`) — and attacker-controlled text.
 */
export type WebFeeds = (body: FeedsBody, device: string, label: string) => Promise<FeedsShareAnswer>

/**
 * The route: an owner's body read once, checked, and handed to the window.
 * `feeds` absent is a window that did not wire it, which is the `404` of a
 * path nobody built.
 */
export async function feedsHere(
  req: IncomingMessage,
  device: Device,
  feeds: WebFeeds | undefined,
): Promise<{ body: FeedsShareAnswer } | { refusal: Refusal }> {
  if (feeds === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = FeedsSchema.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  return { body: await feeds(parsed.data, device.id, device.label) }
}

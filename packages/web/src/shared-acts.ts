import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs } from './surface.ts'

// One orchestrator on every machine of the person's, acting on any of them
// (`tade_remote_act`): what it does on this machine it does through this
// machine's own gate — the window's half (`@tade/app`'s `acts.ts`) runs the
// call by `ToolHost.act` under an owner's arm, with the person's words it
// carried read beside this machine's own.
//
// Two doors, because only one machine of a pair can dial:
// - `POST /api/acts` — a machine that links here asks this one to do
//   something, now, and is answered;
// - `POST /api/acts/outbox` — a machine that links here hands in what it did
//   for this one and takes what this one's orchestrator wants done there,
//   which this machine can never call to ask.
//
// **An owner's, and only at this machine's own door** (`here`), **and the
// person's own device too** (`theirs`): what it reaches is what this
// machine's own orchestrator reaches, which the SSH key to this box reaches
// already. Bodies are read as text first: a key, a method name, its
// parameters as an object, and the person's lines as strings.

const Line = z.string().max(4_000)

const ActText = z.strictObject({
  key: z.string().min(1).max(200),
  method: z.string().regex(/^[a-z]+\/[a-z-]+$/),
  params: z.record(z.string().max(200), z.unknown()),
  quoted: z.array(Line).max(80),
  from: z.string().max(120),
})

const AnswerText = z.strictObject({
  key: z.string().min(1).max(200),
  ok: z.boolean(),
  text: z.string().max(256 * 1024),
})

const OutboxText = z.strictObject({ answers: z.array(AnswerText).max(64) })

/** What a hub's outbox answers with: what waits there, read by the same rule as an act here. */
const OutboxAnswerText = z.strictObject({ acts: z.array(ActText).max(64) })

export type ActBody = z.infer<typeof ActText>
export type ActDone = z.infer<typeof AnswerText>

/**
 * The acts in a hub's answer to the outbox ask, or `null` where it is not one.
 *
 * Read on the machine that asks, because the hub is the one machine of a pair
 * that holds no credential for the other: what it hands back is read exactly
 * as an act sent to this machine's own door is, and nothing in it is taken on
 * the strength of a cast.
 */
export function readOutboxAnswer(body: unknown): ActBody[] | null {
  const parsed = OutboxAnswerText.safeParse(body)
  return parsed.success ? parsed.data.acts : null
}

/** The window's half: an act run here, and the outbox for a machine that links here. Throws the reason. */
export interface WebActs {
  take(act: ActBody, device: string, label: string): Promise<ActDone>
  outbox(answers: readonly ActDone[], device: string, label: string): Promise<{ acts: ActBody[] }>
}

/** `POST /api/acts`: one act, run here through this machine's own gate. */
export async function actHere(
  req: IncomingMessage,
  device: Device,
  acts: WebActs | undefined,
): Promise<{ body: ActDone } | { refusal: Refusal }> {
  if (acts === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = ActText.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  return { body: await acts.take(parsed.data, device.id, device.label) }
}

/** `POST /api/acts/outbox`: what was done for this machine handed in, and what waits here taken. */
export async function outboxHere(
  req: IncomingMessage,
  device: Device,
  acts: WebActs | undefined,
): Promise<{ body: { acts: ActBody[] } } | { refusal: Refusal }> {
  if (acts === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = OutboxText.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  return { body: await acts.outbox(parsed.data.answers, device.id, device.label) }
}

import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// Signing the orchestrator in from the person's own phone: `/login` typed on
// the away view's line, carried out there rather than pointed back at the
// machine.
//
// **The harness's own sign-in, run on this machine, driven from the phone.**
// Every harness signs in in a terminal (`WorkerAdapter.signIn`), and every one
// has a way for a machine nobody is at — a link to open on any device and a
// code to give back (`{ browser: false }`). So the window runs exactly that in
// a lane of its own (`wire/web-sign-in.ts`), and this route is the phone's
// hands on it: what its screen says, the link it printed, a line typed back
// and the few keys a sign-in's menu is moved with. When it ends signed in, the
// orchestrator starts again on it, as `/login` at the machine does.
//
// **A paired device's and an owner's, as `/api/orchestrator/restart` is**
// (`here` in `routes.ts`): typing into a sign-in on this machine is what the
// SSH key that reaches it may do, and every paired device is the person's own.
// Off this machine's door it is asked a trusted origin and the passkey.
//
// **What goes back is never a credential.** The screen is cleaned as an
// agent's is (`cleanScreen`), and the link is the page the person signs in on.
// What is typed goes to the sign-in and nowhere else — never the journal,
// which says only that a device typed (`web_did`) — and the token the harness
// gets for it is kept where the harness keeps it, as at the machine.
//
// **A press answers what is held, and does no work.** Starting, typing and
// cancelling are handed to the window and answered at once with where the
// sign-in stands; the screen is read on the window's beat while somebody asks.

/** The keys a sign-in's own menu is moved with: pi's provider list, a confirm. */
export const SIGN_IN_KEYS = ['enter', 'up', 'down', 'escape', 'tab'] as const
export type SignInKey = (typeof SIGN_IN_KEYS)[number]

/** The most one typed line may be: a code, a key pasted from a page. */
export const SIGN_IN_TEXT_MAX = 4096

/** Where the orchestrator's sign-in from away stands. */
export interface SignInStanding {
  /** None started; starting or waiting on the person; over. */
  state: 'idle' | 'running' | 'ended'
  /** Who the orchestrator runs as, in the window's words; null where nothing could say. */
  who: string | null
  /** The harness's own words for a sign-in nobody is at the machine for; null before one starts. */
  how: string | null
  /** Its screen as it may leave the machine (`cleanScreen`), oldest row first. */
  rows: string[]
  /** The first `https` link it printed: the page to sign in on. Null until it prints one. */
  link: string | null
  /** How it ended, or why one cannot start, in the window's words; null otherwise. */
  said: string | null
}

/** The window's half. Every method answers at once with what is held. */
export interface WebSigningIn {
  /** Where it stands now, and a reason to go on reading its screen for a while. */
  look(device: string): SignInStanding
  /** Start the sign-in, written down as this device's; one running already is answered as it is. */
  start(device: string): SignInStanding
  /** Type a line into it and press enter. */
  type(device: string, text: string): SignInStanding
  /** Press one key in it. */
  key(device: string, key: SignInKey): SignInStanding
  /** End it, leaving the orchestrator as it was. */
  cancel(device: string): SignInStanding
}

/** What a press asks for: one of five things, and nothing else. */
const SignInBody = z.discriminatedUnion('do', [
  z.strictObject({ do: z.literal('look') }),
  z.strictObject({ do: z.literal('start') }),
  z.strictObject({ do: z.literal('type'), text: z.string().min(1).max(SIGN_IN_TEXT_MAX) }),
  z.strictObject({ do: z.literal('key'), key: z.enum(SIGN_IN_KEYS) }),
  z.strictObject({ do: z.literal('cancel') }),
])

/** `POST /api/orchestrator/sign-in`: look at, start, type into or end the orchestrator's sign-in. */
export async function signInHere(
  req: IncomingMessage,
  device: Device,
  signing: WebSigningIn | undefined,
): Promise<{ body: SignInStanding } | { refusal: Refusal }> {
  if (signing === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = SignInBody.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  const call = parsed.data
  if (call.do === 'look') return { body: signing.look(device.id) }
  if (call.do === 'start') return { body: signing.start(device.id) }
  if (call.do === 'type') return { body: signing.type(device.id, call.text) }
  if (call.do === 'key') return { body: signing.key(device.id, call.key) }
  return { body: signing.cancel(device.id) }
}

/**
 * The first `https` link in a sign-in's screen, read across the rows a
 * terminal wrapped it over: the page the person signs in on. Null for none.
 *
 * Rows that fill the width are joined to the row under them first, as
 * `cleanScreen` joins them, so a link wider than the terminal is one link.
 */
export function signInLink(text: string, cols: number): string | null {
  const rows = text.replace(/\r\n?/g, '\n').split('\n')
  let joined = ''
  for (const row of rows) joined += row.length >= cols ? row : `${row}\n`
  const found = /https:\/\/[^\s"'<>`]+/.exec(joined)
  if (found === null) return null
  // A sentence's full stop or a bracket around the link is not part of it.
  const link = found[0].replace(/[).,;:!?\]]+$/, '')
  return link.length > SIGN_IN_TEXT_MAX ? null : link
}

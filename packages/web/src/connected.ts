import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CONNECT_SOURCES,
  CONNECT_STATE_MS,
  type ConnectPage,
  type ConnectPress,
  type ConnectSource,
} from '@tade/core'
import { z } from 'zod'
import { connectHome, installedPage, madePage, nothingPage, PAGE_CSP } from './connect-page.ts'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { headersFor } from './headers.ts'
import { queryOf, readBody } from './request.ts'
import type { Route } from './routes.ts'

// The guided pages that connect a source (REMOTE-TADE.md §6.4): who may use
// them, the one-time word each press mints, and what a source sending the
// browser back is answered with.
//
// **Turning a source on is `never`-tier** (`surfaces.intake` in `reach.ts`):
// never the orchestrator's, never a paired phone's. So the page and its presses
// answer **on this machine alone** (`Route.here`: the loopback listener and a
// loopback `Host`), which from anywhere else is a person over SSH — the reach
// that can already edit `config.yaml` — and to an owner device asking the same
// over its own door (`/api/connect`, the Mac's window for a remote). Nothing a
// phone holds gets here: the public listener refuses this machine's names at
// the door, and a `lan` bind is public.
//
// **On this door no session is asked**, and that is the one new thing here.
// What a session would prove — that this is the person — is what reaching this
// door already is; what it would add on top is the cross-site layers, and those
// are asked anyway: a press is a `POST` with an exact `Origin`, JSON only and
// `Sec-Fetch-Site: same-origin` where sent, so no page in a browser here can
// make one for somebody. What an account of another person on this machine
// could do through a loopback port is replace the App with one of its own,
// which reads nothing of yours until somebody with admin on your repositories
// installs it there.
//
// **The callbacks are on the public name** (GitHub sends the browser there, and
// Slack's and Linear's must be public HTTPS), and nothing but the word answers
// them: one this machine minted at a press, for the host it is answered at,
// within ten minutes, and burned at the first use — before the code is
// exchanged, so a replay, a race and a failure all find nothing. A stranger who
// reaches one has nothing to present, and is told there is nothing here. The
// page that answers never shows a secret: it says what was made and what is
// next.

/** How many words may be outstanding at once: a page pressed again and again forgets its oldest. */
export const STATES_HELD = 16

/** One word, as it was minted. */
interface Minted {
  source: ConnectSource
  press: ConnectPress
  /** The `Host` the source will send the browser back to, exactly. */
  host: string
  until: number
}

/**
 * The one-time words, in this window's memory and nowhere else.
 *
 * In memory because the press and the callback are one person's next few
 * minutes in front of one window, and a word on disk would be one more thing
 * an agent here could read. A window that closed in between has forgotten it,
 * which is the press asked for again.
 */
export class ConnectStates {
  private readonly held = new Map<string, Minted>()

  mint(what: Omit<Minted, 'until'>, now: number): string {
    this.forget(now)
    const state = randomBytes(24).toString('base64url')
    this.held.set(state, { ...what, until: now + CONNECT_STATE_MS })
    while (this.held.size > STATES_HELD) {
      const oldest = this.held.keys().next().value
      if (oldest === undefined) break
      this.held.delete(oldest)
    }
    return state
  }

  /**
   * Whether this word was minted for this source, press and host, and is still
   * good — and it is burned whatever the answer, **before** anything is done
   * with it, so a second try with the same word finds nothing.
   */
  take(state: string, what: Omit<Minted, 'until'>, now: number): boolean {
    const found = this.held.get(state)
    this.held.delete(state)
    if (found === undefined || found.until <= now) return false
    return (
      found.source === what.source &&
      found.press === what.press &&
      found.host.toLowerCase() === what.host.toLowerCase()
    )
  }

  clear(): void {
    this.held.clear()
  }

  private forget(now: number): void {
    for (const [state, one] of this.held) if (one.until <= now) this.held.delete(state)
  }
}

/** What a press makes: where the browser goes, and — to make an app — what it posts there. */
export interface ConnectForm {
  url: string
  fields?: Readonly<Record<string, string>>
}

/** What making the app is asked with: where it lives and answers. Built here, from the door. */
export interface ConnectWant {
  home: string
  hook: string | null
  made: string
  installed: string
  state: string
  name: string
  organisation?: string
}

/** The window's half: what is true of a source now, and the two things only it can do. */
export interface WebConnecting {
  /**
   * A source's page as it stands now, with what making its app asks for and
   * why. Answers within its own deadline, a source that could not be asked
   * being a step that says so.
   */
  page(source: ConnectSource): Promise<{
    page: ConnectPage
    asks: readonly { what: string; why: string }[]
    events: readonly string[]
  }>
  /** What the browser posts to make the app, through the forge. Pure. */
  form(source: ConnectSource, want: ConnectWant): ConnectForm
  /** Where the browser goes to install it, carrying `state`; null where no app is kept to install. */
  installUrl(source: ConnectSource, state: string): string | null
  /**
   * The code the source sent the browser back with, exchanged and kept through
   * the one write path: what was made, or why not — in Tade's words, never a
   * secret.
   */
  made(source: ConnectSource, code: string): Promise<{ name: string } | { problem: string }>
  /** The source said it was installed: whatever holds what the page reads, reads again. */
  installed(source: ConnectSource): void
}

/** What a request to these routes is answered by, from the server. */
export interface Connecting {
  connecting: WebConnecting | undefined
  states: ConnectStates
  /** This machine's public name, where it has one: where callbacks are answered. */
  publicName: string | null
  /** The request's `Host`, as the guard accepted it. */
  host: string
  now: number
}

/** The page and its presses, and a source sending the browser back: one of `CONNECTS`. */
export async function carryConnect(
  route: Route,
  req: IncomingMessage,
  res: ServerResponse,
  at: Connecting,
  json: (body: unknown, status?: number) => void,
  answer: (refusal: Refusal) => void,
): Promise<void> {
  const connecting = at.connecting
  if (connecting === undefined) return answer(refuse('no_such'))
  if (route.connects === 'page') {
    const pages = await Promise.all(CONNECT_SOURCES.map((one) => connecting.page(one)))
    return html(res, 200, connectHome(pages, at.publicName))
  }
  const source = route.source
  if (source === undefined) return answer(refuse('no_such'))
  if (route.connects === 'press') {
    const got = await readBody(req)
    if (!got.read) return answer(got.refusal)
    const press = pressOf(route)
    const asked = PressSchema.safeParse(got.body)
    if (press === null || !asked.success) return answer(refuse('malformed'))
    const made = pressed(connecting, at, source, press, asked.data)
    return 'refusal' in made ? json(made.said, made.refusal.status) : json(made.form)
  }
  // The source sending the browser back: the word, and nothing else, decides.
  const query = queryOf(req.url ?? '/')
  const state = query.get('state') ?? ''
  const press: ConnectPress = route.name.endsWith(' made') ? 'make' : 'install'
  if (!at.states.take(state, { source, press, host: at.host }, at.now)) {
    return html(res, 404, nothingPage())
  }
  if (press === 'install') {
    connecting.installed(source)
    return html(res, 200, installedPage())
  }
  // What was kept is written down where it was written: a `config_changed`
  // line a key, by the window's one write path, each said as `set`.
  const kept = await connecting.made(source, query.get('code') ?? '')
  if ('problem' in kept) return html(res, 502, madePage({ problem: kept.problem }))
  // The next press is offered on the same page, with a word of its own: the
  // browser that just made the app is the one that installs it, and the page
  // it came from is on a door it may not be at now (`here`).
  const next = at.states.mint({ source, press: 'install', host: at.host }, at.now)
  const install = connecting.installUrl(source, next)
  return html(res, 200, madePage({ name: kept.name, install }))
}

/** What a press may carry: making an app under an organisation, and its name. Nothing else. */
export const PressSchema = z.strictObject({
  organisation: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)
    .optional(),
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,33}$/)
    .optional(),
})

function pressOf(route: Route): ConnectPress | null {
  if (route.name.endsWith(' make')) return 'make'
  if (route.name.endsWith(' install')) return 'install'
  return null
}

/**
 * One press: a word minted for the host the source will send the browser back
 * to, and the form or address that carries it. **That host is this machine's
 * public name where it has one**; without one it is the door the press came
 * in at — `localhost:<port>`, which a browser here, or at the end of an
 * `ssh -L`, reaches and GitHub then cannot deliver to, so the app is made with
 * no webhook.
 */
export function pressed(
  connecting: WebConnecting,
  at: Pick<Connecting, 'states' | 'publicName' | 'host' | 'now'>,
  source: ConnectSource,
  press: ConnectPress,
  asked: z.infer<typeof PressSchema>,
): { form: ConnectForm } | { refusal: Refusal; said: { error: string; said: string } } {
  const back = at.publicName ?? at.host
  const home = at.publicName === null ? `http://${at.host}` : `https://${at.publicName}`
  const state = at.states.mint({ source, press, host: back }, at.now)
  if (press === 'install') {
    const url = connecting.installUrl(source, state)
    if (url === null) {
      const refusal = refuse('no_such')
      return {
        refusal,
        said: { error: refusal.error, said: 'there is no App kept here to install yet' },
      }
    }
    return { form: { url } }
  }
  const form = connecting.form(source, {
    home,
    hook: at.publicName === null ? null : `${home}/hooks/${source}`,
    made: `${home}/connect/${source}/made`,
    installed: `${home}/connect/${source}/installed`,
    state,
    name: asked.name ?? defaultName(at.publicName),
    ...(asked.organisation === undefined ? {} : { organisation: asked.organisation }),
  })
  return { form }
}

/**
 * A name to suggest: GitHub wants every App's name unique across GitHub and at
 * most 34 characters, so it carries the machine's public name where there is
 * one, cut to fit. The person may change it before the press.
 */
export function defaultName(publicName: string | null): string {
  const named = publicName === null ? 'Tade' : `Tade ${publicName.split('.')[0] ?? ''}`
  return named.slice(0, 34).trim()
}

function html(res: ServerResponse, status: number, page: string): void {
  res.writeHead(status, {
    ...headersFor('api', 'text/html; charset=utf-8'),
    'content-security-policy': PAGE_CSP,
  })
  res.end(page)
}

/**
 * The owner's ask (`OWNED`'s `connect`): a source's page as it stands, and —
 * pressed — the form that carries a word minted here, for another machine of
 * the person's whose browser cannot reach this one's loopback door. **Only
 * where this machine has a public name**, because that is where GitHub will
 * send that browser back to; without one the way in is `ssh -L` to this
 * machine's own `/connect`, and the answer says so.
 */
export async function connectHere(
  req: IncomingMessage,
  device: Device,
  at: Pick<Connecting, 'connecting' | 'states' | 'publicName' | 'host' | 'now'>,
): Promise<{ body: ConnectAnswer } | { refusal: Refusal }> {
  const connecting = at.connecting
  if (connecting === undefined) return { refusal: refuse('no_such') }
  if (!device.owner) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const asked = OwnerAskSchema.safeParse(got.body)
  if (!asked.success) return { refusal: refuse('malformed') }
  const { source, press, ...rest } = asked.data
  const seen = await connecting.page(source)
  if (press === undefined) return { body: { ...seen, publicName: at.publicName, form: null } }
  if (at.publicName === null) {
    return {
      body: {
        ...seen,
        publicName: null,
        form: null,
        cannot:
          'this machine has no public name, so GitHub cannot send a browser elsewhere back to it: give it one with `tade host domain`, or open /connect here through `ssh -L`',
      },
    }
  }
  const made = pressed(connecting, at, source, press, rest)
  if ('refusal' in made)
    return { body: { ...seen, publicName: at.publicName, form: null, cannot: made.said.said } }
  return { body: { ...seen, publicName: at.publicName, form: made.form } }
}

/** What an owner may ask: one source's page, and one press on it. */
export const OwnerAskSchema = PressSchema.extend({
  source: z.enum(CONNECT_SOURCES),
  press: z.enum(['make', 'install']).optional(),
})

const Said = z.string().max(600)
const StepSchema = z.object({
  id: z.enum(['make', 'install', 'deliveries']),
  title: z.string().max(80),
  done: z.boolean(),
  said: Said,
  press: z.object({ act: z.enum(['make', 'install']), label: z.string().max(40) }).optional(),
})

/** The answer, as this machine gives it and another reads it: for its shape, every value bounded. */
export const ConnectAnswerSchema = z.object({
  page: z.object({
    source: z.enum(CONNECT_SOURCES),
    title: z.string().max(40),
    steps: z.array(StepSchema).max(8),
  }),
  asks: z.array(z.object({ what: z.string().max(80), why: Said })).max(16),
  events: z.array(z.string().max(64)).max(32),
  publicName: z.string().max(253).nullable(),
  /** The form a press made: where the browser goes, and what it posts there. */
  form: z
    .object({
      url: z.string().max(2048),
      fields: z.record(z.string(), z.string().max(16_384)).optional(),
    })
    .nullable(),
  /** Why a press made nothing. */
  cannot: Said.optional(),
})
export interface ConnectAnswer {
  page: ConnectPage
  asks: readonly { what: string; why: string }[]
  events: readonly string[]
  publicName: string | null
  form: ConnectForm | null
  cannot?: string
}

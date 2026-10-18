import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CONNECT_FIELDS,
  CONNECT_FLOWS,
  CONNECT_SOURCES,
  CONNECT_STATE_MS,
  type ConnectFieldName,
  type ConnectPage,
  type ConnectPress,
  type ConnectSource,
} from '@tade/core'
import { z } from 'zod'
import {
  connectHome,
  installedPage,
  madePage,
  nothingPage,
  notInstalledPage,
  PAGE_CSP,
} from './connect-page.ts'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { headersFor } from './headers.ts'
import { queryOf, readBody } from './request.ts'
import type { Route } from './routes.ts'
import { ownsOrTheirs } from './surface.ts'

// The guided pages that connect a source (REMOTE-TADE.md §6.4): who may use
// them, the one-time word each press mints, and what a source sending the
// browser back is answered with.
//
// **Turning a source on is `never`-tier** (`surfaces.intake` in `reach.ts`):
// never the orchestrator's, never a paired phone's. So the page and its presses
// answer **on this machine alone** (`Route.here`: the loopback listener and a
// loopback `Host`), which from anywhere else is a person over SSH — the reach
// that can already edit `config.yaml` — and to an owner device asking the same
// over its own door (`/api/connect`, the Mac's window for a remote), or the
// person's own phone asking it from any door (`Route.theirs`), which already
// turns a `never`-tier setting on from Settings. Nothing else a phone holds
// gets to the pages or presses: the public listener refuses this machine's
// names at the door, and a `lan` bind is public.
//
// **On this door no session is asked**, and that is the one new thing here.
// What a session would prove — that this is the person — is what reaching this
// door already is; what it would add on top is the cross-site layers, and those
// are asked anyway: a press is a `POST` with an exact `Origin`, JSON only and
// `Sec-Fetch-Site: same-origin` where sent, so no page in a browser here can
// make one for somebody. What an account of another person on this machine
// could do through a loopback port is replace the App with one of its own,
// which reads nothing of yours until somebody with admin on your repositories
// installs it there — and, for Slack, keep a signing secret or a token of its
// own choosing: deliveries it signs then only make the watch look sooner, and
// a token of another workspace's reads that workspace, where nobody on your
// `from` list asks anything. What it costs you is your own app's working,
// which the page then says is broken.
//
// **What a source's own page shows the person and hands over no other way** —
// Slack's signing secret, its client's id and secret, or with no public name
// its bot token; Linear's client id and its webhook's signing secret — is
// pasted into the page and kept by its `keep` press: shape-checked here, per
// source (`KEEP_SCHEMAS`), written by the window's one write path, never
// answered back and never drawn again.
//
// **Where a source installs with a proof key** (`CONNECT_FLOWS.pkce`, Linear),
// the press mints a verifier beside its word and sends the source only its
// digest; the verifier stays in this window's memory with the word, and the
// code that comes back is exchanged with it. A code that leaked — a browser's
// history, a proxy's log — is worth nothing without it.
//
// **The callbacks are on the public name** where there is one (GitHub and
// Linear send the browser there, and Slack's must be public HTTPS), and
// nothing but the word answers them: one this machine minted at a press, for
// the host it is answered at, within ten minutes, and burned at the first use
// — before the code is exchanged, so a replay, a race and a failure all find
// nothing. A stranger who reaches one has nothing to present, and is told
// there is nothing here. The page that answers never shows a secret: it says
// what was made and what is next.

/** How many words may be outstanding at once: a page pressed again and again forgets its oldest. */
export const STATES_HELD = 16

/** One word, as it was minted. */
interface Minted {
  source: ConnectSource
  press: ConnectPress
  /** The `Host` the source will send the browser back to, exactly. */
  host: string
  until: number
  /** The proof key's verifier, where the source installs with one: never sent anywhere but its exchange. */
  verifier?: string
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
   * good — what it was minted with where it is, else null — and it is burned
   * whatever the answer, **before** anything is done with it, so a second try
   * with the same word finds nothing.
   */
  take(
    state: string,
    what: Omit<Minted, 'until' | 'verifier'>,
    now: number,
  ): { verifier: string | null } | null {
    const found = this.held.get(state)
    this.held.delete(state)
    if (found === undefined || found.until <= now) return null
    const same =
      found.source === what.source &&
      found.press === what.press &&
      found.host.toLowerCase() === what.host.toLowerCase()
    return same ? { verifier: found.verifier ?? null } : null
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
  /** The one-time word the source brings back, or '' where it brings nothing back. */
  state: string
  name: string
  organisation?: string
}

/** What a source sending the browser back after an install brought with it. */
export interface ConnectReturn {
  /** The code to exchange, where the source sends one (Slack's OAuth, Linear's); null where none came. */
  code: string | null
  /** The source's own word for why it did not install, where it said one (`access_denied`). */
  error: string | null
  /** The address the browser came back to: what the code's exchange must name again. */
  home: string
  /** The proof key's verifier the press minted with its word, where the source installs with one. */
  verifier?: string | null
}

/** The window's half: what is true of a source now, and the things only it can do. */
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
  /** Where the browser goes to make the app, and what it posts there where it posts anything. Pure. */
  form(source: ConnectSource, want: ConnectWant): ConnectForm
  /**
   * Where the browser goes to install it, carrying `state`, coming back to
   * `home` — and, where the source installs with a proof key, the verifier's
   * digest (`challenge`); null where no app is kept to install.
   */
  installUrl(
    source: ConnectSource,
    state: string,
    home: string,
    challenge: string | null,
  ): string | null
  /**
   * The code the source sent the browser back with, exchanged and kept through
   * the one write path: what was made, or why not — in Tade's words, never a
   * secret.
   */
  made(source: ConnectSource, code: string): Promise<{ name: string } | { problem: string }>
  /**
   * The source said it was installed: whatever holds what the page reads,
   * reads again — and where it sent a code (Slack, Linear), the code exchanged
   * for the token and kept. Where it is installed now (a workspace), or why not.
   */
  installed(
    source: ConnectSource,
    back: ConnectReturn,
  ): Promise<{ where: string | null } | { problem: string }>
  /**
   * What the person pasted from the source's own page, kept through the one
   * write path: the names of what was kept, or why nothing was.
   */
  keep(
    source: ConnectSource,
    fields: Partial<Record<ConnectFieldName, string>>,
  ): Promise<{ kept: readonly string[] } | { problem: string }>
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
    return html(res, 200, connectHome(pages))
  }
  const source = route.source
  if (source === undefined) return answer(refuse('no_such'))
  if (route.connects === 'press') {
    const got = await readBody(req)
    if (!got.read) return answer(got.refusal)
    const press = route.press
    if (press === undefined) return answer(refuse('malformed'))
    if (press === 'keep') {
      const kept = await keptFrom(connecting, source, got.body)
      return 'refusal' in kept ? json(kept.said, kept.refusal.status) : json(kept)
    }
    const asked = PressSchema.safeParse(got.body)
    if (!asked.success) return answer(refuse('malformed'))
    const made = pressed(connecting, at, source, press, asked.data)
    return 'refusal' in made ? json(made.said, made.refusal.status) : json(made.form)
  }
  // The source sending the browser back: the word, and nothing else, decides.
  const query = queryOf(req.url ?? '/')
  const state = query.get('state') ?? ''
  const press: ConnectPress = route.back === 'made' ? 'make' : 'install'
  const minted = at.states.take(state, { source, press, host: at.host }, at.now)
  if (minted === null) return html(res, 404, nothingPage())
  if (press === 'install') {
    // Where the browser came back to is where the code's exchange says it was
    // sent, which Slack and Linear hold to the redirect the install was asked with.
    const home =
      at.publicName !== null && at.publicName.toLowerCase() === at.host.toLowerCase()
        ? `https://${at.publicName}`
        : `http://${at.host}`
    const installed = await connecting.installed(source, {
      code: query.get('code'),
      error: query.get('error'),
      home,
      verifier: minted.verifier,
    })
    if ('problem' in installed) return html(res, 502, notInstalledPage(source, installed.problem))
    return html(res, 200, installedPage(source, installed.where))
  }
  // What was kept is written down where it was written: a `config_changed`
  // line a key, by the window's one write path, each said as `set`.
  const kept = await connecting.made(source, query.get('code') ?? '')
  if ('problem' in kept) return html(res, 502, madePage({ problem: kept.problem }))
  // The next press is offered on the same page, with a word of its own: the
  // browser that just made the app is the one that installs it, and the page
  // it came from is on a door it may not be at now (`here`).
  const next = mintInstall(at, source, at.host)
  const install = connecting.installUrl(source, next.state, `https://${at.host}`, next.challenge)
  return html(res, 200, madePage({ name: kept.name, install }))
}

/**
 * A word for an install, for the host the source will send the browser back
 * to — with a proof key's verifier beside it where the source installs with
 * one (`CONNECT_FLOWS.pkce`), of which only the digest leaves this window.
 */
function mintInstall(
  at: Pick<Connecting, 'states' | 'now'>,
  source: ConnectSource,
  host: string,
): { state: string; challenge: string | null } {
  if (!CONNECT_FLOWS[source].pkce) {
    return { state: at.states.mint({ source, press: 'install', host }, at.now), challenge: null }
  }
  // 32 random bytes are 43 characters of base64url: the verifier OAuth's
  // proof key asks for, from its unreserved alphabet.
  const verifier = randomBytes(32).toString('base64url')
  const state = at.states.mint({ source, press: 'install', host, verifier }, at.now)
  return { state, challenge: createHash('sha256').update(verifier).digest('base64url') }
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

/** What Slack's `keep` may carry: see `KEEP_SCHEMAS`. */
const SlackKeepSchema = z.strictObject({
  signing_secret: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{16,128}$/)
    .optional(),
  client_id: z
    .string()
    .trim()
    .regex(/^\d{1,20}\.\d{1,20}$/)
    .optional(),
  client_secret: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{16,128}$/)
    .optional(),
  token: z
    .string()
    .trim()
    .regex(/^xoxb-[A-Za-z0-9-]{10,250}$/)
    .optional(),
}) satisfies z.ZodType<Partial<Record<ConnectFieldName, string>>>

/** What Linear's `keep` may carry: see `KEEP_SCHEMAS`. Never a client secret, which it does not need. */
const LinearKeepSchema = z.strictObject({
  client_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{16,128}$/)
    .optional(),
  signing_secret: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{16,256}$/)
    .optional(),
}) satisfies z.ZodType<Partial<Record<ConnectFieldName, string>>>

/**
 * What a `keep` press may carry, per source, each held to its shape here so a
 * paste into the wrong box is said before anything is written. Slack's signing
 * secret and client secret are letters and digits, its client id two numbers
 * with a dot, a bot token `xoxb-`; Linear's client id is letters and digits,
 * and its webhook's signing secret may carry Linear's own `_` and `-` — so a
 * `lin_…` key pasted as the client id is refused. Only these, and none of
 * them answered back; a source that hands its app over itself takes nothing.
 */
export const KEEP_SCHEMAS: Readonly<
  Record<ConnectSource, z.ZodType<Partial<Record<ConnectFieldName, string>>> | null>
> = {
  github: null,
  slack: SlackKeepSchema,
  linear: LinearKeepSchema,
}

/** What each box should have held, per source, said where a paste was not that. */
const KEEP_SHAPES: Readonly<Record<ConnectSource, Partial<Record<ConnectFieldName, string>>>> = {
  github: {},
  slack: {
    signing_secret: 'the Signing Secret is the letters and digits under App Credentials',
    client_id: 'the Client ID is two numbers with a dot between, under App Credentials',
    client_secret: 'the Client Secret is the letters and digits under App Credentials',
    token: 'the Bot User OAuth Token starts xoxb-, on the app’s Install App page',
  },
  linear: {
    client_id: 'the Client ID is the letters and digits on the app’s page in Linear’s API settings',
    signing_secret: 'the webhook’s signing secret is on the same page, under Webhooks',
  },
}

/**
 * One `keep` press: what was pasted, held to its shape and kept by the
 * window's one write path — or why not, naming the box. A box left empty is
 * left as it is; all of them empty keeps nothing and says so.
 */
async function keptFrom(
  connecting: WebConnecting,
  source: ConnectSource,
  body: unknown,
): Promise<{ said: string } | { refusal: Refusal; said: { error: string; said: string } }> {
  const no = (said: string) => {
    const refusal = refuse('malformed')
    return { refusal, said: { error: refusal.error, said } }
  }
  const schema = KEEP_SCHEMAS[source]
  if (!CONNECT_FLOWS[source].presses.includes('keep') || schema === null) {
    return no('there is nothing to keep here')
  }
  const read = schema.safeParse(dropEmpty(body))
  if (!read.success) {
    const box = read.error.issues[0]?.path[0]
    const shape =
      typeof box === 'string' && (CONNECT_FIELDS as readonly string[]).includes(box)
        ? KEEP_SHAPES[source][box as ConnectFieldName]
        : undefined
    return no(
      shape === undefined ? 'only what the page asks for may be kept' : `that is not it: ${shape}`,
    )
  }
  const fields = read.data
  if (Object.values(fields).every((one) => one === undefined)) return no('nothing was pasted')
  const kept = await connecting.keep(source, fields)
  if ('problem' in kept) return no(kept.problem)
  return { said: `kept: ${kept.kept.join(', ')}` }
}

/** A body's empty boxes left out, so an untouched one is not a malformed one. */
function dropEmpty(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(
      ([, value]) => !(typeof value === 'string' && value.trim() === ''),
    ),
  )
}

/**
 * One press: a word minted for the host the source will send the browser back
 * to, and the form or address that carries it. **That host is this machine's
 * public name where it has one**; without one it is the door the press came
 * in at — `localhost:<port>`, which a browser here, or at the end of an
 * `ssh -L`, reaches and GitHub then cannot deliver to, so the app is made with
 * no webhook. A source that sends a browser back only to a public name
 * (`publicBack`, Slack) is refused that press without one, and a press nothing
 * comes back from (Slack's making) mints no word at all.
 */
export function pressed(
  connecting: WebConnecting,
  at: Pick<Connecting, 'states' | 'publicName' | 'host' | 'now'>,
  source: ConnectSource,
  press: ConnectPress,
  asked: z.infer<typeof PressSchema>,
): { form: ConnectForm } | { refusal: Refusal; said: { error: string; said: string } } {
  const flow = CONNECT_FLOWS[source]
  const back = at.publicName ?? at.host
  const home = at.publicName === null ? `http://${at.host}` : `https://${at.publicName}`
  const returns = flow.backs.includes(press === 'make' ? 'made' : 'installed')
  if (press === 'install' && flow.publicBack && at.publicName === null) {
    const refusal = refuse('no_such')
    return {
      refusal,
      said: {
        error: refusal.error,
        said: 'this machine has no public name, so Slack cannot send the browser back to it: install the app from its own page and keep its token here',
      },
    }
  }
  if (press === 'install') {
    const minted = mintInstall(at, source, back)
    const url = connecting.installUrl(source, minted.state, home, minted.challenge)
    if (url === null) {
      const refusal = refuse('no_such')
      return {
        refusal,
        said: { error: refusal.error, said: 'there is no app kept here to install yet' },
      }
    }
    return { form: { url } }
  }
  const state = returns ? at.states.mint({ source, press, host: back }, at.now) : ''
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
 * send that browser back to; without one the way in is this machine's own
 * `/connect`, which `tade remote connect` there serves to its browser over the
 * link (`RemoteLink.pages`), and the answer says so.
 */
export async function connectHere(
  req: IncomingMessage,
  device: Device,
  at: Pick<Connecting, 'connecting' | 'states' | 'publicName' | 'host' | 'now'>,
): Promise<{ body: ConnectAnswer } | { refusal: Refusal }> {
  const connecting = at.connecting
  if (connecting === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
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
        cannot: `this machine has no public name, so ${seen.page.title} cannot send a browser elsewhere back to it: give it one with \`tade host domain\`, or open /connect here with \`tade remote connect\` on the machine asking`,
      },
    }
  }
  const made = pressed(connecting, at, source, press, rest)
  if ('refusal' in made)
    return { body: { ...seen, publicName: at.publicName, form: null, cannot: made.said.said } }
  return { body: { ...seen, publicName: at.publicName, form: made.form } }
}

/**
 * What an owner may ask: one source's page, and one press on it that opens a
 * browser. **Not `keep`**: what Slack's own page shows the person is pasted
 * into this machine's own page, never carried here from another machine's
 * window, which has nowhere to type it but a terminal it would echo in.
 */
export const OwnerAskSchema = PressSchema.extend({
  source: z.enum(CONNECT_SOURCES),
  press: z.enum(['make', 'install']).optional(),
})

const Said = z.string().max(600)
const StepSchema = z.object({
  id: z.enum(['make', 'keep', 'install', 'deliveries']),
  title: z.string().max(80),
  done: z.boolean(),
  said: Said,
  press: z
    .object({
      act: z.enum(['make', 'keep', 'install']),
      label: z.string().max(40),
      fields: z
        .array(
          z.object({
            name: z.enum(CONNECT_FIELDS),
            label: z.string().max(80),
            secret: z.boolean(),
            placeholder: z.string().max(80).optional(),
          }),
        )
        .max(8)
        .optional(),
      replaces: Said.optional(),
    })
    .optional(),
})

/** The answer, as this machine gives it and another reads it: for its shape, every value bounded. */
export const ConnectAnswerSchema = z.object({
  page: z.object({
    source: z.enum(CONNECT_SOURCES),
    title: z.string().max(40),
    steps: z.array(StepSchema).max(8),
    // An older Tade's answer says nothing of what its app may write.
    writes: Said.default(''),
  }),
  asks: z.array(z.object({ what: z.string().max(80), why: Said })).max(16),
  events: z.array(z.string().max(64)).max(32),
  publicName: z.string().max(253).nullable(),
  /** The form a press made: where the browser goes, and what it posts there. */
  form: z
    .object({
      // Slack's carries the whole manifest in its query.
      url: z.string().max(8192),
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

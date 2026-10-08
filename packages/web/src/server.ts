import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type Asset, assetFor, matchesEtag, readAssets } from './assets.ts'
import { appendDevice, type Device, readDevices } from './devices.ts'
import { bodyOf, type Refusal, refuse } from './errors.ts'
import {
  type Asking,
  allowed,
  type Guarding,
  hostOf,
  PAIR_TRIES,
  PAIR_WINDOW_MS,
  REFUSAL_WINDOW_MS,
  REFUSALS_BEFORE_SAYING,
  Window,
} from './guard.ts'
import { headersFor } from './headers.ts'
import { type Grant, type Reach, readsOf } from './reach.ts'
import type { WebReading } from './reading.ts'
import { type Route, routeFor } from './routes.ts'
import { clearCookie, mint, renewal, SESSION_MS, sessionOf, setCookie } from './sessions.ts'
import { listenOn, reachOf, type Surface, scopesOn } from './surface.ts'
import { couldBeTicket, type Tickets } from './tickets.ts'

// The away view's own HTTP server: `node:http`, one handler, the table in
// `routes.ts`, and nothing else listening.
//
// **This is not the `ToolHost`, and the two must never become one.** The
// `ToolHost` is a Unix socket in `@tade/orchestrator`, hosted by the window for
// its own child agents, undiscoverable, dead when the window closes. This is a
// TCP listener a person turns on, for a browser they paired, serving a
// projection that was built to be read from off the machine. They have
// different transports, different authority, different vocabularies and
// different threat models, and the one thing they share is the process they run
// in. `test/separation.test.ts` asserts this package names neither the
// orchestrator nor a Unix socket.
//
// **Nothing here starts anything.** `listen` is called by whoever holds the
// home lock — the window, in a later slice — and only when the config says so.
// This slice ships the server and its tests; a listener on somebody's network
// is a separate act with its own setting (`surfaces.web.enabled`), and until
// something calls `listen` there is no socket.
//
// **Every answer goes through `answer`**, which writes the security headers
// before anything else — a refusal included, because a refusal is a response a
// browser renders too. There is no `res.end` anywhere else in the file.
//
// **No request handler does any work.** No `git`, no `ps`, no process spawn, no
// file read beyond the device list: every read answers from what the window
// already holds, through `WebReading`. The window draws on this thread.

/** How long a pairing request waits for somebody at the machine. */
export const CONFIRM_MS = 60_000

/** The largest body any route will read. A steer message, later; nothing now. */
export const BODY_MAX = 64 * 1024

/** The header the token travels in, which an HTML form cannot set. */
export const CSRF_HEADER = 'x-tade-csrf'

/** What the window is asked when a device wants in. */
export interface PairingAsk {
  /** The label the device suggested. Attacker-controlled: never in a path. */
  label: string
  /** The address it came from, as the socket gives it. */
  from: string
  /** The host it reached Tade on. */
  host: string
}

/**
 * What the person at the machine answered.
 *
 * `granted` is what this device may read beyond names and counts, and
 * `projects` is which of them it may read at all — `null` for every one. Both
 * are decided at the machine, per device, and neither is a config key: a read
 * scope is a grant somebody made about one phone, and a setting would make it
 * one answer for all of them.
 */
export type Confirmed =
  | { let: true; projects: readonly string[] | null; granted: readonly Grant[] }
  | { let: false; why: 'refused' | 'nobody answered' }

/** One line for the journal. The server never writes the file itself. */
export interface Told {
  type: 'web_paired' | 'web_denied' | 'web_revoked' | 'web_refused' | 'warning'
  detail: Record<string, string | number | boolean>
}

export interface ServerOptions {
  /** Where `web-devices.jsonl` lives. Tade's home, never a project. */
  home: string
  surface: Surface
  /**
   * The projection for one device's reach.
   *
   * A factory and not one reading, because **a read scope is per device**: two
   * phones granted different projects are two projections, and filtering one
   * after the fact is how a field that should have been withheld rides along.
   * The window implements this and keeps a projector per reach.
   */
  readingFor: (reach: Reach) => WebReading
  /**
   * Ask the person at the machine. The one authorisation nothing remote can
   * obtain, and the reason a stolen ticket is worth nothing.
   */
  confirm: (ask: PairingAsk) => Promise<Confirmed>
  /** The tickets the pairing panel minted. */
  tickets: Tickets
  /** Where a line goes. Never throws, and never blocks an answer. */
  tell?: (told: Told) => void
  now?: () => number
  /** How long to wait for a keypress. Shorter in tests, and only there. */
  confirmMs?: number
}

/** The away view, as the window holds it. */
export interface WebServer {
  /** Start listening. The addresses actually bound come back. */
  listen(): Promise<readonly string[]>
  /** Stop listening. Safe twice, and safe before `listen`. */
  close(): Promise<void>
  /** The handler itself, for a test that would rather not bind anything. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** What is bound, as `host:port`. Empty before `listen`. */
  readonly bound: readonly string[]
}

export function webServer(opts: ServerOptions): WebServer {
  const now = opts.now ?? (() => Date.now())
  const confirmMs = opts.confirmMs ?? CONFIRM_MS
  const tell = (told: Told): void => {
    try {
      opts.tell?.(told)
    } catch {
      // A reporter that throws is not a reason a request fails. The same rule
      // telemetry already has: a reporter never throws or blocks.
    }
  }

  let assets: Map<string, Asset> | null = null
  const servers: Server[] = []
  const bound: string[] = []
  const boundHosts: string[] = []
  let stopping = false
  let lastSkipped = 0

  // Two windows, two different questions. The pairing one is per address and
  // is a rate limit; the refusal one is per address and decides when a stream
  // of refusals is worth one line in the journal.
  const pairing = new Window(PAIR_TRIES, PAIR_WINDOW_MS)
  const refusals = new Window(REFUSALS_BEFORE_SAYING, REFUSAL_WINDOW_MS)

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const request = randomUUID()
    try {
      await route(req, res, request)
    } catch (error) {
      // The detail goes in a `warning` where a person at the machine can read
      // it. The browser gets a sentence and an id, and no stack trace ever.
      tell({
        type: 'warning',
        detail: {
          warning: `the away view could not answer a request: ${String(error).slice(0, 200)}`,
          request,
        },
      })
      if (!res.headersSent) answer(res, refuse('broke', { request }))
      else res.end()
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, request: string): Promise<void> {
    if (stopping) return answer(res, refuse('closing'))

    const asking = askingOf(req)
    // A path with a query on it is routed by its path: no route reads a query
    // parameter at all, which is the rule that keeps a ticket out of one.
    const path = pathOf(req.url ?? '/')
    if (path === null) return answer(res, refuse('malformed'))

    const found = routeFor(req.method ?? 'GET', path)
    if (found === null) {
      // **One answer for four different things**, deliberately: a path nothing
      // was ever built at, a path that exists under another method, a
      // capability that is turned off, and a file that is not there. All
      // `404`. A `405` would say "that path exists"; a `403 locked` with the
      // name of a setting would say "there is a diff route and it is called
      // this" — both to whoever is probing, who is the only one asking. The
      // person who needs to know reads what they were granted in their own
      // snapshot, which they already have.
      return answer(res, refuse('no_such'))
    }

    // **The device list is read only where a session is needed.** A public
    // route has no session to look up, so the shell and the two files it pulls
    // cost no disk read at all — which matters because they are the one thing
    // anybody who can reach the port may ask for, repeatedly, with no
    // credential.
    const host = asking.host === null ? null : hostOf(asking.host)
    const devices = found.route.public === true ? NO_DEVICES : await readDevices(opts.home)
    saidSkipped(devices.skipped)
    const guarding: Guarding = {
      surface: opts.surface,
      bound: boundHosts,
      session:
        host === null ? null : sessionOf(asking.cookie, devices.devices, asking.host ?? '', now()),
    }

    const verdict = allowed(asking, found.route, guarding)
    if (!verdict.ok) {
      said(asking, found.route, verdict.why)
      return answer(res, verdict.refusal)
    }

    if (found.route.public === true && !found.route.mutates) {
      return asset(req, res, path)
    }
    if (found.route.name === 'pair') {
      return pair(req, res, asking, verdict.origin, request)
    }

    const device = devices.devices.find((one) => one.id === verdict.device)
    if (device === undefined) return answer(res, refuse('no_session'))

    // The sliding expiry, written down. Bounded to once a day by `renewal`, so
    // this is a file append on one request out of thousands and not one per
    // request — which is what the bound is for. Awaited before the answer so a
    // phone that comes back after thirty days of daily use is never signed out
    // by a write that had not landed yet.
    const until = renewal(device, now())
    if (until !== null) {
      await appendDevice(opts.home, {
        kind: 'renewed',
        device: device.id,
        at: new Date(now()).toISOString(),
        until: new Date(until).toISOString(),
      })
    }

    switch (found.route.name) {
      case 'snapshot':
        return json(res, opts.readingFor(reachOf(device)).snapshot())
      case 'notes': {
        const scope = queryOf(req.url ?? '/').get('scope')
        return json(res, opts.readingFor(reachOf(device)).notes(scope))
      }
      case 'devices':
        return json(res, listing(device, devices.devices))
      case 'sign out':
        return signOut(res, verdict.origin, device, found.params.id ?? '')
      default:
        return answer(res, refuse('no_such'))
    }
  }

  /** A file, with a 304 where the browser already has this version. */
  async function asset(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    assets ??= await readAssets()
    const file = assetFor(path, assets)
    if (file === null) return answer(res, refuse('no_such'))
    const headers = headersFor('asset', file.type, file.etag)
    if (matchesEtag(header(req, 'if-none-match'), file.etag)) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    res.writeHead(200, { ...headers, 'content-length': String(file.bytes.length) })
    // No `HEAD` branch, because no `HEAD` reaches here: the table carries
    // three methods and a request under any other finds no route and is a
    // `404`. A browser needs none for this page, and a branch that cannot run
    // reads as a capability there is no test for.
    res.end(file.bytes)
  }

  /**
   * Pairing: the one route that mints a credential.
   *
   * The order is the whole of it. The rate limit is counted **before** the
   * ticket is looked at, so a stream of guesses costs a map entry rather than a
   * scan; the ticket is **claimed** — which burns it — before anybody at the
   * machine is asked, so a refusal, a deadline, a crash and a replay all find
   * nothing; and the device is written down only once the person has said yes.
   */
  async function pair(
    req: IncomingMessage,
    res: ServerResponse,
    asking: Asking,
    origin: { scheme: string; host: string },
    request: string,
  ): Promise<void> {
    if (pairing.over(asking.from, now())) {
      said(asking, null, `pairing refused: ${PAIR_TRIES} tries already`)
      return answer(res, refuse('slow_down', { after: pairing.after(asking.from, now()) }))
    }
    pairing.add(asking.from, now())

    const got = await read(req, res)
    if (!got.read) return
    if (typeof got.body !== 'object' || got.body === null || Array.isArray(got.body)) {
      return answer(res, refuse('malformed'))
    }
    const asked = got.body as Record<string, unknown>
    if (!couldBeTicket(asked.ticket)) return answer(res, refuse('malformed'))
    const label = typeof asked.label === 'string' ? asked.label : ''

    const claim = opts.tickets.claim(asked.ticket, now())
    if (!claim.ok) {
      tell({ type: 'web_denied', detail: { why: claim.why, from: asking.from } })
      // The same answer to the phone whichever it was. Which it was is in the
      // journal, where a `used` is somebody replaying and an `unknown` is
      // somebody guessing, and the phone learns neither.
      return answer(res, refuse('no_session'))
    }

    let confirmed: Confirmed
    try {
      confirmed = await inTime(
        opts.confirm({ label: labelOf(label), from: asking.from, host: asking.host ?? '' }),
        confirmMs,
        // A deadline is an **answer**, not a failure: nobody was there. The
        // ticket is already burned, so there is nothing to undo and no retry
        // against the same secret — which is the whole reason the claim
        // happens before this await rather than after it.
        { let: false, why: 'nobody answered' } satisfies Confirmed,
      )
    } catch (error) {
      // The window's own `confirm` threw. Also not a retry, and also already
      // burned; what it is, is a bug in the window worth a line somebody can
      // read, and a sentence with an id for the phone.
      tell({
        type: 'warning',
        detail: {
          warning: `the away view could not ask about a pairing: ${String(error).slice(0, 200)}`,
          request,
        },
      })
      return answer(res, refuse('broke', { request }))
    }

    if (!confirmed.let) {
      tell({ type: 'web_denied', detail: { why: confirmed.why, from: asking.from } })
      // A refusal and nobody answering are the same answer here and two lines
      // in the journal: the phone cannot tell them apart, which is right —
      // "there is nobody at that machine" is a fact about somebody's day.
      return answer(res, refuse('no_session'))
    }

    const minted = mint()
    const scopes = scopesOn(origin, opts.surface, ['read'])
    const until = new Date(now() + SESSION_MS)
    await appendDevice(opts.home, {
      kind: 'paired',
      device: minted.device,
      at: new Date(now()).toISOString(),
      label: labelOf(label),
      digest: minted.digest,
      host: asking.host ?? '',
      csrf: minted.csrf,
      until: until.toISOString(),
      scopes: [...scopes],
      projects: confirmed.projects === null ? null : [...confirmed.projects],
      granted: [...confirmed.granted],
      from: asking.from,
    })
    tell({
      type: 'web_paired',
      detail: {
        device: minted.device,
        from: asking.from,
        // Never the label: a label is a person's own words about their own
        // phone, and the telemetry allow-list keeps `device` and not this.
        scopes: scopes.join(' '),
        granted: [...confirmed.granted].join(' '),
      },
    })
    res.setHeader('set-cookie', setCookie(minted.cookie, origin.scheme === 'https'))
    return json(
      res,
      { device: minted.device, scopes, csrf: minted.csrf, reads: [...confirmed.granted] },
      201,
    )
  }

  /** Signing out: this device's own credential, and only its own. */
  async function signOut(
    res: ServerResponse,
    origin: { scheme: string; host: string },
    device: Device,
    id: string,
  ): Promise<void> {
    // Its **own** id, and a mismatch is a `403` rather than a `404`: revoking
    // another device is the window's, which is what keeps one stolen phone
    // from disconnecting the others while it still works.
    if (id !== device.id) return answer(res, refuse('out_of_scope'))
    await appendDevice(opts.home, {
      kind: 'revoked',
      device: device.id,
      at: new Date(now()).toISOString(),
      why: 'signed out',
    })
    tell({ type: 'web_revoked', detail: { device: device.id, why: 'signed out' } })
    // The origin's scheme and not the socket's: behind `tailscale serve` the
    // socket is plaintext and the page is `https`, so a cookie set with
    // `Secure` is cleared by one set with `Secure` or not cleared at all.
    res.setHeader('set-cookie', clearCookie(origin.scheme === 'https'))
    return json(res, { signedOut: device.id })
  }

  /**
   * The device list: this one, and the others by label and when they were last
   * paired.
   *
   * No digest, no token but this device's own, no host and no address: what
   * another device is, from here, is a name and a date. The whole list is here
   * because seeing every device there is, is the real mitigation against one
   * having been minted by something on this machine (`DEVICES_AND_AGENTS`).
   */
  function listing(me: Device, devices: readonly Device[]): Record<string, unknown> {
    return {
      you: {
        device: me.id,
        label: me.label,
        reads: readsOf(reachOf(me)),
        scopes: me.scopes,
        csrf: me.csrf,
        until: new Date(me.until).toISOString(),
      },
      devices: devices
        .filter((one) => one.revoked === null)
        .map((one) => ({
          device: one.id,
          label: one.label,
          pairedAt: new Date(one.pairedAt).toISOString(),
          you: one.id === me.id,
        })),
    }
  }

  /**
   * The body, or `answered` having already said why not.
   *
   * **A discriminated answer and not `unknown | null`**, because `null` is a
   * perfectly good JSON body: a four-byte `null` would otherwise be
   * indistinguishable from "this has already been refused", and the caller
   * would return without answering at all — a request held open for ever, for
   * four bytes, by anybody who can reach the pairing route.
   */
  async function read(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ read: true; body: unknown } | { read: false }> {
    const declared = header(req, 'content-length')
    if (declared !== null && Number(declared) > BODY_MAX) {
      answer(res, refuse('too_big'))
      return { read: false }
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += bytes.length
      // Counted as it arrives and not from the declared length, because the
      // declared length is the client's claim: a chunked body declares none.
      if (size > BODY_MAX) {
        answer(res, refuse('too_big'))
        req.destroy()
        return { read: false }
      }
      chunks.push(bytes)
    }
    if (size === 0) return { read: true, body: {} }
    try {
      return { read: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    } catch {
      answer(res, refuse('malformed'))
      return { read: false }
    }
  }

  /**
   * That lines of the device list could not be read — **said once**, not once
   * per request.
   *
   * A damaged file is damaged for every request that follows, so a warning per
   * request is thousands of lines about one truncated write. Said again only
   * when the number changes, which is the one thing that means something new
   * has happened to the file.
   */
  function saidSkipped(skipped: number): void {
    if (skipped === 0 || skipped === lastSkipped) return
    lastSkipped = skipped
    tell({
      type: 'warning',
      detail: {
        warning: `${skipped} line(s) of the paired-device list could not be read and were skipped`,
        found: skipped,
      },
    })
  }

  /** A refusal, said once a peer is past the threshold rather than per request. */
  function said(asking: Asking, route: Route | null, why: string): void {
    const count = refusals.add(asking.from, now())
    if (count !== REFUSALS_BEFORE_SAYING) return
    tell({
      type: 'web_refused',
      detail: {
        from: asking.from,
        why,
        found: count,
        ...(route === null ? {} : { where: route.name }),
      },
    })
  }

  function answer(res: ServerResponse, refusal: Refusal): void {
    const headers = headersFor('refusal', 'application/json; charset=utf-8')
    if (refusal.after !== undefined) headers['retry-after'] = String(refusal.after)
    res.writeHead(refusal.status, headers)
    res.end(JSON.stringify(bodyOf(refusal)))
  }

  function json(res: ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, headersFor('api', 'application/json; charset=utf-8'))
    res.end(JSON.stringify(body))
  }

  return {
    get bound() {
      return bound
    },
    handle,
    async listen(): Promise<readonly string[]> {
      if (!opts.surface.enabled) return []
      assets ??= await readAssets()
      for (const host of listenOn(opts.surface)) {
        const server = createServer((req, res) => {
          void handle(req, res)
        })
        // Bounded by Node's own defaults for headers, and by `BODY_MAX` for a
        // body. A request that stops mid-header is closed rather than held.
        server.headersTimeout = 10_000
        server.requestTimeout = 30_000
        try {
          await new Promise<void>((done, failed) => {
            server.once('error', failed)
            server.listen({ host, port: opts.surface.port, ipv6Only: host === '::' }, () => done())
          })
        } catch (error) {
          // Already in use is a **named** warning and nothing listens on that
          // address. Never a quiet bind somewhere else: a URL in somebody's
          // hand that goes nowhere is worse than a surface that said it could
          // not come up.
          server.close()
          tell({
            type: 'warning',
            detail: {
              warning: `the away view could not listen on ${host}:${opts.surface.port} — ${codeOf(error)}`,
              where: host,
            },
          })
          continue
        }
        servers.push(server)
        // Typed here rather than imported from `node:net`, so that the rule
        // "this package names no Unix socket" holds without an exception
        // somebody has to remember is harmless (`test/separation.test.ts`).
        const at = server.address() as { address: string; port: number } | string | null
        if (at !== null && typeof at !== 'string') {
          bound.push(`${at.address}:${at.port}`)
          boundHosts.push(at.address)
        }
      }
      return bound
    },
    async close(): Promise<void> {
      stopping = true
      opts.tickets.clear()
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((done) => {
              server.closeAllConnections()
              server.close(() => done())
            }),
        ),
      )
      servers.length = 0
      bound.length = 0
      boundHosts.length = 0
    },
  }
}

/**
 * A request, as the guard needs to see it.
 *
 * **The address is the socket's and the host is `Host`.** No forwarded header
 * is read here or anywhere in this package (`NEVER_TRUSTED`, `headers.ts`):
 * reading one would make the rate limit, the journalled address, the
 * `Host` allow-list and the trusted-origin rule all be whatever the attacker
 * typed, which is four defences for the price of one header.
 */
export function askingOf(req: IncomingMessage): Asking {
  const socket = req.socket as typeof req.socket & { encrypted?: boolean }
  return {
    method: req.method ?? 'GET',
    path: pathOf(req.url ?? '/') ?? '/',
    host: header(req, 'host'),
    origin: header(req, 'origin'),
    site: header(req, 'sec-fetch-site'),
    contentType: header(req, 'content-type'),
    token: header(req, CSRF_HEADER),
    cookie: header(req, 'cookie'),
    tls: socket.encrypted === true,
    from: req.socket.remoteAddress ?? 'unknown',
  }
}

/** One header's value, or null. An array — a repeated header — is null. */
function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (typeof value === 'string') return value
  // A repeated header is two claims about one thing. Picking either is how a
  // guard gets walked past, so neither is picked.
  return null
}

/** The path out of a URL, or null for one that is not a path. */
export function pathOf(url: string): string | null {
  const at = url.search(/[?#]/)
  const path = at === -1 ? url : url.slice(0, at)
  if (!path.startsWith('/')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }
  // A NUL, a newline or a backslash in a path is not a path anything here
  // serves, and refusing them is cheaper than reasoning about what they mean.
  if (/[\0\r\n\\]/.test(decoded)) return null
  return decoded
}

/** The query, read by exactly one route and never for a credential. */
export function queryOf(url: string): URLSearchParams {
  const at = url.indexOf('?')
  if (at === -1) return new URLSearchParams()
  const end = url.indexOf('#', at)
  return new URLSearchParams(url.slice(at + 1, end === -1 ? undefined : end))
}

/** A device label, bounded and on one line. Its words are the person's. */
export function labelOf(said: string): string {
  return said
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 40)
}

/** No device list at all, for a route that needs none. */
const NO_DEVICES: { devices: readonly Device[]; skipped: number } = { devices: [], skipped: 0 }

/**
 * A promise with a deadline, and the deadline is an answer rather than a hang.
 *
 * The same shape as the window's own `inTime`: every wait here has a deadline,
 * because a request held open for ever is a connection nobody closes and a
 * person watching a spinner. The promise it lost the race to is not cancelled —
 * nothing in this program can cancel a keypress — so whatever the window does
 * afterwards is the window's, and this side has already answered.
 */
async function inTime<T>(promise: Promise<T>, ms: number, instead: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((done) => {
        timer = setTimeout(() => done(instead), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'it could not be bound'
}

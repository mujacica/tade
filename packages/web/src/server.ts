import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { carryOut } from './acted.ts'
import type { WebActing } from './acting.ts'
import type { Standing } from './acts.ts'
import { type Asset, assetFor, assetsDir, matchesEtag, readAssets } from './assets.ts'
import { appendDevice, type Device, listing, readDevices } from './devices.ts'
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
import { type Sink, Streams } from './peers.ts'
import type { Grant, Reach } from './reach.ts'
import type { WebReading } from './reading.ts'
import { Receipts } from './receipts.ts'
import { askingOf, codeOf, header, inTime, labelOf, pathOf, queryOf, readBody } from './request.ts'
import { type Route, routeFor, routesFor } from './routes.ts'
import {
  CONFIRM_MS,
  type Confirmed,
  type PairingAsk,
  type ServerOptions,
  type Told,
  type WebServer,
} from './serving.ts'
import { clearCookie, mint, renewal, SESSION_MS, sessionOf, setCookie } from './sessions.ts'
import { cursorOf } from './stream.ts'
import { listenOn, reachOf, type Surface, scopesOn } from './surface.ts'
import { couldBeTicket } from './tickets.ts'

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
//
// **What the window hands it, and what it hands back, is `serving.ts`.** The
// contract is its own file because it is the thing a reader checks this
// subsystem against — nine fields and two of them optional — and because a
// listener and the shape of what it is given are different subjects.

// Re-exported, so everything that already said `from './server.ts'` still
// does: a file split for size may not be a rename of everybody's imports.
export {
  CONFIRM_MS,
  type Confirmed,
  type PairingAsk,
  type ServerOptions,
  type Told,
  type WebServer,
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

  const epoch = randomUUID()
  const streams = opts.streams ?? new Streams()
  streams.use(epoch)
  // **The table is a fact about the config, read once.** Turning `acting` on
  // is a restart (there is no route until there is), and turning it off is
  // read at every act (`acting.unlocked()`). Asymmetric in the direction that
  // takes authority away.
  const table = routesFor(opts.surface)
  // Receipts exist whether or not anything can act, so that a window whose
  // setting was turned off still *reads* what the last one did — a repeat of a
  // key from before is then an answer out of the record rather than a `404`
  // that tells a phone nothing about what became of its request.
  const receipts = new Receipts({
    home: opts.home,
    epoch,
    tell: (said) => tell({ type: 'warning', detail: { warning: said } }),
  })
  // Read once, and **before the first act rather than on the first act**: a
  // repeat that arrived while the file was still being read would find an
  // empty store and be treated as fresh, which is the duplicate the store
  // exists to stop. `listen` awaits it too, so a window that is up has already
  // read what the last one did.
  let read: Promise<void> | null = null
  const readReceipts = (): Promise<void> => {
    read ??= receipts.open()
    return read
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

    const found = routeFor(req.method ?? 'GET', path, table)
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
      // **A verb refused at the door is written down too.** Everything else
      // refused here is a port scanner or a stale tab, and a line per refusal
      // would make the journal a request log; a *verb* is different — a device
      // that asked to change something and was not allowed to is exactly what
      // a person reading back needs to see, and it is the case the audit
      // matters most in. The device id where there was a session, and nothing
      // invented where there was not.
      if (found.route.verb !== undefined) {
        tell({
          type: 'web_did',
          detail: {
            device: guarding.session?.device ?? '',
            tool: found.route.verb,
            state: 'refused',
            why: verdict.refusal.error,
          },
        })
      }
      // **The one place a refusal is not a refusal body.** A non-200 answer
      // kills an `EventSource` permanently, and `204 No Content` is the one
      // status that tells a browser to *stop reconnecting* — so a page whose
      // session went while the tab was closed gets one `204` and shows the
      // pairing screen, instead of reopening a `401` every two seconds for as
      // long as the phone is awake. Every other route answers `401` normally.
      if (found.route.name === 'stream' && verdict.refusal.error === 'no_session') {
        res.writeHead(204, headersFor('api', 'application/json; charset=utf-8'))
        res.end()
        return
      }
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
      // A stream opened days ago holds the expiry it was opened with, and the
      // beat ends it when that passes. A phone that is being used every
      // morning renews on an ordinary request, so its open streams are told
      // here — otherwise the one device that never signs out is the one whose
      // stream gets closed as expired.
      streams.renewed(device.id, until)
    }

    switch (found.route.name) {
      case 'snapshot':
        return json(res, opts.readingFor(reachOf(device)).snapshot())
      case 'stream':
        return stream(req, res, device)
      case 'notes': {
        const scope = queryOf(req.url ?? '/').get('scope')
        return json(res, opts.readingFor(reachOf(device)).notes(scope))
      }
      case 'devices':
        return json(res, listing(device, devices.devices))
      case 'sign out':
        return signOut(res, verdict.origin, device, found.params.id ?? '')
      default:
        if (found.route.verb !== undefined) {
          return act(req, res, found.route, device, verdict.origin, request)
        }
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

    const got = await readBody(req)
    if (!got.read) return answer(res, got.refusal)
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

  /**
   * The live stream: one answer that stays open.
   *
   * What happens here and nowhere else:
   *
   * - **The total cap is a `503` before anything is written**, because a
   *   stream that was opened and then told it cannot be is a stream the
   *   browser will reconnect to for ever. The per-device cap is the other way
   *   round — opened far enough to say `too_many` and then ended — because
   *   four tabs of one phone is a person doing something ordinary and they
   *   deserve the sentence.
   * - **`Last-Event-ID` is the cursor and nothing else is.** No query
   *   parameter, no cookie, no byte offset: `(epoch, rev)`.
   * - **The session's expiry travels with the peer**, so the beat can end a
   *   stream whose credential ran out while it was open — which is the one
   *   way a long-lived answer could otherwise outlive the thing that
   *   authorised it.
   * - **Nothing is awaited.** The handler returns while the response stays
   *   open; what keeps it alive is the socket, and what closes it is the
   *   beat, a revocation or the client going away.
   */
  function stream(req: IncomingMessage, res: ServerResponse, device: Device): void {
    if (streams.full) {
      answer(res, refuse('busy', { after: 5 }))
      return
    }
    const reading = opts.readingFor(reachOf(device))
    res.writeHead(200, headersFor('stream', 'text/event-stream; charset=utf-8'))
    // A seventeen-byte keep-alive that waits for a full packet is a keep-alive
    // that arrives when the next one does, so the liveness line on the phone
    // would lag by whatever Nagle decided.
    req.socket.setNoDelay(true)
    // **Drain the request, which is how `requestTimeout` is satisfied.** It is
    // the deadline for receiving a *whole* request, and this is the one route
    // whose answer outlives it by hours: a `GET` carries no body, so nothing
    // is lost by reading it to its end, and a request nobody read is one the
    // timer is still counting.
    req.resume()
    const sink: Sink = {
      write: (text) => res.write(text),
      end: () => res.end(),
    }
    const opened = streams.open({
      device: device.id,
      until: device.until,
      cursor: cursorOf(header(req, 'last-event-id')),
      sink,
      snapshot: () => reading.snapshot(),
      rev: reading.rev,
      now: now(),
    })
    if (opened.kind === 'too_many') return
    const peer = opened.peer
    res.on('drain', () => streams.drained(peer, now()))
    // **`res` and never `req`.** A request that has been drained — which the
    // line above does, deliberately — emits `close` the moment it is read to
    // its end, which for a bodyless `GET` is immediately: listening for it
    // would forget every peer a few microseconds after opening it, and the
    // stream would carry its opening bytes and then nothing for ever. The
    // response's `close` is the honest signal, because it is the one that
    // means nothing more can be written.
    //
    // An error is the same departure by another name, and not a `warning`
    // somebody needs: a line per dropped phone is a journal of somebody's
    // wifi. `gone` is idempotent, so both arriving is harmless.
    const gone = (): void => streams.gone(peer)
    res.on('close', gone)
    res.on('error', gone)
  }

  /**
   * One act: the body, then `carryOut`, then the bytes.
   *
   * Every decision is in `acted.ts` and every re-check is in `acts.ts`, so
   * what is here is the two things only a listener can do — read a bounded
   * body, and write an answer. The audit line goes out **whatever** came of
   * it, which is the half somebody will want to leave out: a device asking
   * for something it may not have is exactly what a person reading back needs
   * to see.
   */
  async function act(
    req: IncomingMessage,
    res: ServerResponse,
    route: Route,
    device: Device,
    origin: { scheme: string; host: string },
    request: string,
  ): Promise<void> {
    const acting = opts.acting
    // No `WebActing` at all is a window that was not given the acting half,
    // which is "this listener does not do that": a `404`, like every other
    // capability that is not here.
    if (acting === undefined) return answer(res, refuse('no_such'))
    const got = await readBody(req)
    if (!got.read) return answer(res, got.refusal)
    await readReceipts()

    const answered = await carryOut(route, got.body, {
      acting,
      receipts,
      surface: opts.surface,
      unlocked: unlocked(acting),
      rev: opts.readingFor(reachOf(device)).rev,
      reach: reachOf(device),
      scopes: device.scopes as Standing['scopes'],
      origin,
      device: device.id,
      now: now(),
      request,
    })
    if (answered.warning !== null) {
      tell({ type: 'warning', detail: { warning: answered.warning, request } })
    }
    const { task, ...detail } = answered.did
    tell({ type: 'web_did', ...(task === '' ? {} : { task }), detail })
    if (answered.refusal !== null) return answer(res, answered.refusal)
    return json(res, answered.body ?? {})
  }

  /**
   * Whether acting is unlocked, asked of the window and never allowed to throw
   * a request over.
   *
   * A `false` here is a refusal with a sentence; an exception out of the
   * window's own reader would be a `500` on a question whose safe answer is
   * *no*.
   */
  function unlocked(acting: WebActing): boolean {
    try {
      return acting.unlocked()
    } catch {
      return false
    }
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
    streams.revoke(device.id, 'signed out')
    tell({ type: 'web_revoked', detail: { device: device.id, why: 'signed out' } })
    // The origin's scheme and not the socket's: behind `tailscale serve` the
    // socket is plaintext and the page is `https`, so a cookie set with
    // `Secure` is cleared by one set with `Secure` or not cleared at all.
    res.setHeader('set-cookie', clearCookie(origin.scheme === 'https'))
    return json(res, { signedOut: device.id })
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
      if (opts.surface.acting) await readReceipts()
      // **A folder with no files in it is said, not served.** `readAssets`
      // answers a folder it could not read the same way it answers an empty
      // one, which is right for it and is a listener that `404`s every page
      // with nothing anywhere saying why — the one failure here that only
      // happens on somebody else's machine. A warning costs a line and is the
      // difference between a broken install and a mystery.
      if (assets.size === 0) {
        tell({
          type: 'warning',
          detail: {
            warning: `the away view found none of its own files, so every page will be a 404 — ${assetsDir()}`,
            where: assetsDir(),
          },
        })
      }
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
    get streams() {
      return streams
    },
    epoch,
    async close(): Promise<void> {
      stopping = true
      opts.tickets.clear()
      // Every open stream is told why before the listener goes, which is the
      // difference between a page that says *Tade is closing* and one that
      // says nothing and reconnects for the rest of the afternoon. Nothing is
      // awaited: there is no acknowledgement worth waiting for from a phone in
      // a drawer, and `App.stop()` may not hang on one.
      streams.closeAll('closing')
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

/** No device list at all, for a route that needs none. */
const NO_DEVICES: { devices: readonly Device[]; skipped: number } = { devices: [], skipped: 0 }

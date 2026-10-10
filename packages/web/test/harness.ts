import { mkdtemp } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noFacts, type TaskFacts, type WebActing } from '../src/acting.ts'
import type { Streams } from '../src/peers.ts'
import type { Reach } from '../src/reach.ts'
import { type Projector, projector, type WebReading } from '../src/reading.ts'
import {
  type Confirmed,
  type PairingAsk,
  type Told,
  type WebServer,
  webServer,
} from '../src/server.ts'
import type { Surface } from '../src/surface.ts'
import { Tickets } from '../src/tickets.ts'
import { input, NOW } from './fixtures.ts'

// A real listener on this machine, and a client that can say what a browser
// says. Shared by `server.test.ts` (the door: what is served, what is refused)
// and `pairing.test.ts` (the credential: minting it, using it, losing it).
//
// **Loopback and `port: 0` throughout.** A test that bound the LAN would be a
// listener on whoever's network ran it, which is the one thing this slice is
// not allowed to leave behind.
//
// **The client is `node:http` and not `fetch`.** `fetch` cannot set `Host` —
// it is a forbidden header name, so it strips it silently — and a
// DNS-rebinding test written with `fetch` therefore sends the real host, gets
// a `200`, and is a test that passes while asserting nothing.

/**
 * A `WebActing` with every verb refusing, and whichever ones a test wants.
 *
 * **Every method, every time**, which is the point: a test that built a
 * `WebActing` by hand would have to be found and edited for each new verb, and
 * the one that was forgotten would be the one whose route went to a method
 * that was not there. Here the default for each is a throw with the verb's own
 * name in it — so a test that reaches a verb it did not mean to is a
 * failure that says which.
 */
export function actingStub(over: Partial<WebActing> = {}): WebActing {
  const no = (verb: string) => (): Promise<never> =>
    Promise.reject(new Error(`this test did not expect ${verb}`))
  return {
    unlocked: () => true,
    park: no('park'),
    answer: no('answer'),
    steer: no('steer'),
    queue: no('queue'),
    done: no('done'),
    note: no('note'),
    context: no('context'),
    intake: no('intake'),
    ...over,
  }
}

/** The facts a task's revision is built from, with nothing waiting on it. */
export function facts(over: Partial<TaskFacts> = {}): TaskFacts {
  return { ...noFacts(), ...over }
}

export const BASE: Surface = {
  enabled: true,
  bind: 'loopback',
  port: 0,
  trustedHosts: ['studio.yak-bebop.ts.net'],
  // Off, like the config's default: the read-only tests are about a listener
  // that has no route to change anything, and `acting.test.ts` turns it on
  // deliberately. A fixture that was kinder than the default would be the one
  // thing these tests exist to catch.
  acting: false,
  talking: false,
  drafting: false,
  installing: false,
  keepsView: false,
}

export interface Running {
  server: WebServer
  home: string
  origin: string
  host: string
  /** The server's own epoch, which its projections are stamped with. */
  epoch: string
  tickets: Tickets
  told: Told[]
  asked: PairingAsk[]
  /** What the next pairing is answered with, and by whom. */
  answer: (ask: PairingAsk) => Promise<Confirmed>
}

/** What came back: the status, the headers and the bytes. */
export interface Answer {
  status: number
  headers: Record<string, string>
  text: string
}

/**
 * A reading over the projection's own fixtures.
 *
 * The real one, and not a stub that answers `{}`: what these files are for is
 * the server, and a server tested against an empty answer would not notice
 * that what it served was the wrong device's projection.
 *
 * A **real projector** per reach, kept here, so a test can move the projection
 * on (`beat`) and watch what the stream does about it. One per reach and not
 * one altogether, because that is the rule the server is built on: a read
 * scope is per device, so two devices are two projections.
 */
const projectors = new Map<string, Projector>()

/**
 * The epoch the projections are stamped with, which is the running server's.
 *
 * Set by `start`, because an epoch is the *server's* lifetime: the window
 * reads it off the server for `lifetime.epoch` so that a snapshot's freshness
 * and a delta's `id` are the same string. A fixture that kept its own would
 * make every reconnection look like a restart, and no assertion would notice,
 * because resnapshotting is correct.
 */
let epoch = ''

export function projectorFor(reach: Reach): Projector {
  const held = projectors.get(reach.device)
  if (held !== undefined) return held
  const first = input({ reach })
  const made = projector(
    { ...first, lifetime: { ...first.lifetime, ...(epoch === '' ? {} : { epoch }) } },
    NOW,
  )
  projectors.set(reach.device, made)
  return made
}

export function reading(reach: Reach): WebReading {
  return projectorFor(reach)
}

/** A home of its own, so no two tests share a device list. */
export async function homeFor(what: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `tade-web-${what}-`))
}

/**
 * Every server a test started, so each file can close them all afterwards.
 *
 * Shared by the files that import this, and emptied by `closeAll` — which each
 * of them calls in its own `afterEach`, because a listener left open outlives
 * the test that wanted it.
 */
const running: Running[] = []

export async function closeAll(): Promise<void> {
  for (const one of running) await one.server.close()
  running.length = 0
  forgetProjectors()
}

/** Forget every projector, so no two tests share a revision. */
export function forgetProjectors(): void {
  projectors.clear()
  epoch = ''
}

export async function start(
  over: Partial<Surface> = {},
  opts: { confirmMs?: number; streams?: Streams; acting?: WebActing; home?: string } = {},
): Promise<Running> {
  // A home of its own unless a test wants the one a previous listener used,
  // which is how a restart is written: the devices and the receipts outlive
  // the window, and the epoch does not.
  const home = opts.home ?? (await homeFor('run'))
  const tickets = new Tickets()
  const told: Told[] = []
  const asked: PairingAsk[] = []
  const one: Running = {
    home,
    tickets,
    told,
    asked,
    origin: '',
    host: '',
    epoch: '',
    server: undefined as unknown as WebServer,
    answer: async () => ({ let: true, projects: null, granted: [] }),
  }
  one.server = webServer({
    home,
    surface: { ...BASE, ...over },
    readingFor: reading,
    tickets,
    tell: (line) => told.push(line),
    confirm: (ask) => {
      asked.push(ask)
      return one.answer(ask)
    },
    ...(opts.streams === undefined ? {} : { streams: opts.streams }),
    // Handed over only when a test says so, which is how the window does it:
    // with no `acting` there is no verb to reach, whatever the route table
    // says.
    ...(opts.acting === undefined ? {} : { acting: opts.acting }),
    ...(opts.confirmMs === undefined ? {} : { confirmMs: opts.confirmMs }),
  })
  epoch = one.server.epoch
  one.epoch = epoch
  const bound = await one.server.listen()
  const at = bound.find((address) => address.startsWith('127.0.0.1'))
  if (at === undefined) throw new Error(`nothing bound on loopback: ${bound.join(', ')}`)
  one.host = at
  one.origin = `http://${at}`
  running.push(one)
  return one
}

/** The JSON an answer carried, as the loose shape a test reads fields off. */
export function said(answer: Answer): Record<string, unknown> {
  return JSON.parse(answer.text) as Record<string, unknown>
}

/**
 * One request, over `node:http` rather than `fetch`.
 *
 * **`fetch` cannot set `Host`** — it is a forbidden header name, so `fetch`
 * strips it silently. A rebinding test written with `fetch` therefore sends the
 * real host, gets a `200`, and is a test that passes while asserting nothing.
 * `node:http` sends what it is given, which is what a test of a `Host`
 * allow-list has to be able to do.
 */
export function ask(
  one: Running,
  path: string,
  over: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {
    host: one.host,
    'sec-fetch-site': 'same-origin',
    ...over.headers,
  }
  if (over.body !== undefined) headers['content-length'] = String(Buffer.byteLength(over.body))
  const [address, port] = one.host.split(':')
  return new Promise<Answer>((done, failed) => {
    const req = request(
      { host: address, port: Number(port), path, method: over.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([name, value]) => [
                name,
                Array.isArray(value) ? value.join(', ') : String(value ?? ''),
              ]),
            ),
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', failed)
    if (over.body !== undefined) req.write(over.body)
    req.end()
  })
}

/** A paired device, and the cookie header that is its credential. */
export async function pair(
  one: Running,
  over: { label?: string; headers?: Record<string, string> } = {},
): Promise<{ answer: Answer; cookie: string; csrf: string; device: string }> {
  const ticket = one.tickets.mint(`${one.origin}/pair`, Date.now())
  const answer = await ask(one, '/api/pair', {
    method: 'POST',
    headers: {
      origin: one.origin,
      'content-type': 'application/json',
      ...over.headers,
    },
    body: JSON.stringify({ ticket: ticket.value, label: over.label ?? 'iPhone' }),
  })
  const set = answer.headers['set-cookie'] ?? ''
  const cookie = set.split(';')[0] ?? ''
  const body = answer.status === 201 ? (said(answer) as Record<string, string>) : {}
  return { answer, cookie, csrf: body.csrf ?? '', device: body.device ?? '' }
}

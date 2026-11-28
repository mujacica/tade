import { afterEach, describe, expect, it } from 'vitest'
import { appendDevice } from '../src/devices.ts'
import { type Asking, allowed, type Guarding } from '../src/guard.ts'
import { Pieces } from '../src/projection-told.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { CONNECTS, OWNED, ROUTES, type Route } from '../src/routes.ts'
import type { Surface } from '../src/surface.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// A paired phone asks what only the SSH key's session could: every route of
// the owner's, presence, and the guided pages that connect a source with their
// presses. Every paired device is the person's own — their phone is the screen
// they can pull the plug on — so it is answered these on any door, asked there
// what acting asks. Nobody without a session gets anything but the `404` of a
// path nobody built, and the connect pages on this machine's door stay
// sessionless, as they were.

afterEach(closeAll)

/** The routes a paired device is answered on any door that are asked with a body, by name. */
const THEIRS = [
  'presence',
  'seen',
  'watch seen',
  'duties',
  'carry',
  'attach',
  'since',
  'share notes',
  'share feeds',
  'projection',
  'conversation',
  'acts',
  'acts outbox',
  'press there',
  'repositories',
  'side',
  'disk',
  'machine',
  'restart',
  'orchestrator restart',
  'orchestrator sign-in',
  'accounts',
  'accounts sign-in',
  'inventory',
  'document',
  'tool',
  'records',
  'take',
  'open',
  'connect',
] as const

/** The connect page and its presses: each source's, as its flow says. */
const PRESSES = CONNECTS.filter((one) => one.connects === 'press')
const CONNECT_PAGE = CONNECTS.find((one) => one.connects === 'page') as Route

const routeNamed = (name: string): Route => {
  const found = [...ROUTES, ...OWNED, ...CONNECTS].find((one) => one.name === name)
  if (found === undefined) throw new Error(`no route named ${name}`)
  return found
}

describe('which routes a paired device reaches from any door', () => {
  it('is every route only this machine’s door answered: the owner’s, presence, and the connect page and presses', () => {
    const here = [...ROUTES, ...OWNED, ...CONNECTS].filter((one) => one.here === true)
    expect(here.map((one) => one.name).sort()).toEqual(
      [...THEIRS, 'connect page', ...PRESSES.map((one) => one.name)].sort(),
    )
    expect(PRESSES.length).toBeGreaterThan(0)
    expect(PRESSES.map((one) => one.name)).toContain('connect github make')
  })
})

describe('the door, for a route that is the SSH key’s', () => {
  const NAME = 'tade.example.com'
  const NOW = Date.parse('2026-10-18T12:00:00Z')
  const HOUR = 3_600_000
  const PUBLIC: Surface = {
    enabled: true,
    bind: 'loopback',
    port: 7654,
    trustedHosts: [NAME],
    publicName: NAME,
    passkeyMs: 12 * HOUR,
    acting: true,
    talking: false,
    drafting: false,
    configuring: false,
    installing: false,
    keepsView: false,
    pushing: false,
    pushDetails: false,
  }
  const session = (over: Partial<NonNullable<Guarding['session']>> = {}) => ({
    device: '00112233445566aa',
    host: NAME,
    csrf: 'x'.repeat(43),
    proved: NOW - HOUR,
    ...over,
  })
  const through = (over: Partial<Asking> = {}): Asking => ({
    method: 'POST',
    path: '/api/x',
    host: NAME,
    origin: `https://${NAME}`,
    site: 'same-origin',
    contentType: 'application/json',
    token: 'x'.repeat(43),
    cookie: 'tade_away=00112233445566aa.whatever',
    tls: true,
    from: '203.0.113.7',
    listener: 'public',
    ...over,
  })
  const guarding = (over: Partial<Guarding> = {}): Guarding => ({
    surface: PUBLIC,
    bound: ['127.0.0.1'],
    session: session(),
    now: NOW,
    ...over,
  })
  const here = [...ROUTES, ...OWNED, ...CONNECTS].filter((one) => one.here === true)
  const ALL = [...THEIRS, 'connect page', ...PRESSES.map((one) => one.name)]

  it('lets a paired device through from the public name, on every one of them', () => {
    const answered: string[] = []
    for (const route of here) {
      const verdict = allowed(through(), route, guarding())
      if (verdict.ok) answered.push(route.name)
      else expect.fail(`${route.name}: ${verdict.why}`)
    }
    expect(answered.sort()).toEqual([...ALL].sort())
  })

  it('is the same 404 as ever for nobody at all', () => {
    for (const name of ALL) {
      const verdict = allowed(through(), routeNamed(name), guarding({ session: null }))
      expect(!verdict.ok && verdict.refusal.error, name).toBe('no_such')
    }
  })

  it('never acts for a device paired in the clear, whatever door it asks from', () => {
    for (const name of ALL) {
      const verdict = allowed(
        through(),
        routeNamed(name),
        guarding({ session: session({ clear: true }) }),
      )
      expect(!verdict.ok && verdict.refusal.error, name).toBe('locked')
    }
  })

  it('asks what acting asks: a trusted origin, and the passkey from the public name', () => {
    for (const name of ALL) {
      const route = routeNamed(name)
      const stale = allowed(
        through(),
        route,
        guarding({ session: session({ proved: NOW - 13 * HOUR }) }),
      )
      expect(!stale.ok && stale.refusal.error, name).toBe('unproven')
      const never = allowed(through(), route, guarding({ session: session({ proved: null }) }))
      expect(!never.ok && never.refusal.error, name).toBe('unproven')
      // A network name over plain HTTP: the credential travelled in the clear.
      const plain = allowed(
        through({
          host: '192.168.1.10:7654',
          origin: 'http://192.168.1.10:7654',
          tls: false,
          listener: 'public',
        }),
        route,
        guarding({
          surface: { ...PUBLIC, bind: 'lan', publicName: null, trustedHosts: [] },
          bound: ['192.168.1.10'],
          session: session({ host: '192.168.1.10:7654' }),
        }),
      )
      expect(!plain.ok && plain.refusal.error, name).toBe('locked')
    }
  })

  it('still needs the session’s own token, as every mutation does', () => {
    for (const route of [routeNamed('carry'), routeNamed('take'), ...PRESSES]) {
      const verdict = allowed(through({ token: 'y'.repeat(43) }), route, guarding())
      expect(!verdict.ok && verdict.refusal.error, route.name).toBe('bad_origin')
      const none = allowed(through({ token: null }), route, guarding())
      expect(!none.ok && none.refusal.error, route.name).toBe('bad_origin')
    }
  })

  it('asks a press off this machine’s door every layer a phone’s act is asked', () => {
    for (const route of PRESSES) {
      for (const [what, asked] of [
        ['another origin', through({ origin: 'https://evil.example' })],
        ['no origin', through({ origin: null })],
        ['a form', through({ contentType: 'application/x-www-form-urlencoded' })],
        ['a cross-site fetch', through({ site: 'cross-site' })],
      ] as const) {
        const verdict = allowed(asked, route, guarding())
        expect(!verdict.ok && verdict.refusal.error, `${route.name}, ${what}`).toBe('bad_origin')
      }
      const someoneElse = allowed(
        through(),
        route,
        guarding({ session: session({ host: 'other.example.com' }) }),
      )
      expect(!someoneElse.ok && someoneElse.refusal.error, route.name).toBe('no_session')
    }
  })

  // A typed address or a link from the away view's page: a navigation, with no
  // `Origin`, and through Caddy's socket in the clear — so `https` by the name
  // the config trusts, as every read is.
  const opened = (over: Partial<Asking> = {}) =>
    through({
      method: 'GET',
      path: '/connect',
      origin: null,
      site: 'none',
      contentType: null,
      token: null,
      tls: false,
      ...over,
    })

  it('draws the connect page for its session, typed or followed, and asks the passkey for it', () => {
    expect(allowed(opened(), CONNECT_PAGE, guarding()).ok).toBe(true)
    expect(allowed(opened({ site: 'same-origin' }), CONNECT_PAGE, guarding()).ok).toBe(true)
    const stale = allowed(
      opened(),
      CONNECT_PAGE,
      guarding({ session: session({ proved: NOW - 13 * HOUR }) }),
    )
    expect(!stale.ok && stale.refusal.error).toBe('unproven')
    // A network name the config does not trust is not one a proxy ends TLS for.
    const untrusted = allowed(
      opened({ host: '192.168.1.10:7654' }),
      CONNECT_PAGE,
      guarding({
        surface: { ...PUBLIC, bind: 'lan', publicName: null, trustedHosts: [] },
        bound: ['192.168.1.10'],
        session: session({ host: '192.168.1.10:7654' }),
      }),
    )
    expect(!untrusted.ok && untrusted.refusal.error).toBe('locked')
    const nobody = allowed(opened(), CONNECT_PAGE, guarding({ session: null }))
    expect(!nobody.ok && nobody.refusal.error).toBe('no_such')
  })

  it('keeps this machine’s own door sessionless, a press there carrying a ticket instead', () => {
    const door = {
      host: 'localhost:7654',
      origin: 'http://localhost:7654',
      tls: false,
      listener: 'loopback' as const,
    }
    for (const route of [CONNECT_PAGE, ...PRESSES]) {
      const verdict = allowed(
        through({ ...door, token: null, cookie: null }),
        route,
        guarding({ session: null, ticketed: true }),
      )
      expect(verdict.ok, route.name).toBe(true)
    }
    // With none, the page still answers and no press does (`connect-tickets.ts`).
    for (const route of [CONNECT_PAGE, ...PRESSES]) {
      const verdict = allowed(
        through({ ...door, token: null, cookie: null }),
        route,
        guarding({ session: null }),
      )
      expect(verdict.ok, route.name).toBe(route === CONNECT_PAGE)
    }
  })
})

/** A machine whose window wired every one of them, each recording that it was asked. */
async function wired(): Promise<{ one: Running; asked: string[] }> {
  const asked: string[] = []
  const heard =
    (name: string) =>
    (..._: unknown[]): never => {
      asked.push(name)
      throw new Error(`${name} should not be asked for a body that does not parse`)
    }
  const one = await start(
    {},
    {
      present: (device) => asked.push(`presence ${device}`),
      attaching: (task) => {
        asked.push(`attach ${task}`)
        return { command: `tmux attach -t ${task}` }
      },
      since: heard('since'),
      notes: heard('share notes'),
      feeds: heard('share feeds'),
      conversation: heard('conversation'),
      acts: { take: heard('acts'), outbox: heard('acts outbox') },
      repositories: heard('repositories'),
      side: heard('side'),
      owned: {
        machine: heard('machine'),
        disk: heard('disk'),
        restarting: { standing: heard('restart'), restart: heard('restart') },
        orchestratorRestart: { restart: heard('orchestrator restart') },
        orchestratorSignIn: {
          look: heard('orchestrator sign-in'),
          start: heard('orchestrator sign-in'),
          type: heard('orchestrator sign-in'),
          key: heard('orchestrator sign-in'),
          cancel: heard('orchestrator sign-in'),
        },
        accounts: { carry: heard('accounts'), signIn: heard('accounts sign-in') },
        inventoryTold: heard('inventory'),
        projectionTold: { pieces: new Pieces(), take: heard('projection') },
        seen: heard('seen'),
        watchSeen: heard('watch seen'),
        duties: heard('duties'),
        document: heard('document'),
        tool: heard('tool'),
        records: heard('records'),
        taking: heard('take'),
        opening: heard('open'),
        pressThere: { press: heard('press there') },
        // Never reached: its body is read before anything of it is.
        carrying: {} as never,
      },
      connecting: { page: heard('connect') } as never,
    },
  )
  return { one, asked }
}

/** POST one of them at this machine's own door, as a paired device. */
function post(one: Running, device: Awaited<ReturnType<typeof pair>>, path: string, body: unknown) {
  return ask(one, path, {
    method: 'POST',
    headers: {
      origin: one.origin,
      cookie: device.cookie,
      'content-type': 'application/json',
      [CSRF_HEADER]: device.csrf,
    },
    body: JSON.stringify(body),
  })
}

describe('a paired device at this machine’s door', () => {
  // A phone pairs on this machine's own address in these tests, so the door
  // lets it through and what is under test is each handler: a body that does
  // not parse is `malformed`, so no window half is ever reached.

  it('is answered each of them past the door, as an owner is', async () => {
    const { one, asked } = await wired()
    const phone = await pair(one, { label: 'mine' })
    for (const name of THEIRS) {
      const mine = await post(one, phone, routeNamed(name).path, { bogus: 1 })
      expect(mine.status, `${name}: ${mine.text}`).toBe(400)
    }
    expect(asked).toEqual([])
  })

  it('says presence and gets an attach line, as the window answers an owner', async () => {
    const { one, asked } = await wired()
    const phone = await pair(one)
    expect((await post(one, phone, '/api/presence', { ago: 0 })).status).toBe(200)
    const line = await post(one, phone, '/api/attach', { task: 'app/fix-it' })
    expect(line.status, line.text).toBe(200)
    expect(JSON.parse(line.text)).toEqual({ command: 'tmux attach -t app/fix-it' })
    expect(asked).toEqual([`presence ${phone.device}`, 'attach app/fix-it'])
  })

  it('is nothing at the next request once it is revoked', async () => {
    const { one, asked } = await wired()
    const phone = await pair(one)
    expect((await post(one, phone, '/api/presence', { ago: 0 })).status).toBe(200)
    await appendDevice(one.home, {
      kind: 'revoked',
      device: phone.device,
      at: new Date().toISOString(),
      why: 'revoked at the machine',
    })
    expect((await post(one, phone, '/api/presence', { ago: 0 })).status).toBe(401)
    expect(asked).toHaveLength(1)
  })
})

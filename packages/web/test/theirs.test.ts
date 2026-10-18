import { afterEach, describe, expect, it } from 'vitest'
import { allowDevice, appendDevice, grantDevice } from '../src/devices.ts'
import { type Asking, allowed, type Guarding } from '../src/guard.ts'
import { GRANTS } from '../src/reach.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { CONNECTS, OWNED, ROUTES, type Route } from '../src/routes.ts'
import { SCOPES, type Surface } from '../src/surface.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// The person's own phone asks what only the SSH key's session could
// (`Route.theirs`): the carry, an attach line, the catch-up, what this
// machine is, a document, a tool that reads, presence and connecting a
// source. The person decided it — their phone is the screen they can pull the
// plug on — so a device with full access that is not a machine link
// (`theirsOf`) is answered these on any door, read off the record at the
// request. Every other device keeps exactly what it had: on this machine's
// door refused, anywhere else the `404` of a path nobody built.

afterEach(closeAll)

/** The routes the person's own device is answered on any door, by name. */
const THEIRS = [
  'presence',
  'carry',
  'attach',
  'since',
  'machine',
  'document',
  'tool',
  'connect',
] as const

const routeNamed = (name: string): Route => {
  const found = [...ROUTES, ...OWNED].find((one) => one.name === name)
  if (found === undefined) throw new Error(`no route named ${name}`)
  return found
}

describe('which routes the person’s own device reaches from any door', () => {
  it('is these eight, named here, and none of the rest of the owner’s', () => {
    const marked = [...ROUTES, ...OWNED, ...CONNECTS].filter((one) => one.theirs === true)
    expect(marked.map((one) => one.name).sort()).toEqual([...THEIRS].sort())
    for (const route of marked) expect(route.here, route.name).toBe(true)
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
    scopes: [...SCOPES],
    host: NAME,
    csrf: 'x'.repeat(43),
    proved: NOW - HOUR,
    theirs: true,
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
  const here = [...ROUTES, ...OWNED].filter((one) => one.here === true)

  it('lets the person’s own device through from the public name, on the eight alone', () => {
    const answered: string[] = []
    for (const route of here) {
      const verdict = allowed(through(), route, guarding())
      if (verdict.ok) answered.push(route.name)
      else expect(verdict.refusal.error, route.name).toBe('no_such')
    }
    expect(answered.sort()).toEqual([...THEIRS].sort())
  })

  it('is the same 404 as ever for every other device, and for nobody at all', () => {
    for (const name of THEIRS) {
      const route = routeNamed(name)
      for (const [who, asked] of [
        ['an ordinary device', session({ theirs: false })],
        ['a device read without the mark', { ...session(), theirs: undefined }],
        ['no session', null],
      ] as const) {
        const verdict = allowed(through(), route, guarding({ session: asked }))
        expect(!verdict.ok && verdict.refusal.error, `${name}, ${who}`).toBe('no_such')
      }
    }
  })

  it('asks what acting asks: a trusted origin, and the passkey from the public name', () => {
    for (const name of THEIRS) {
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
    const verdict = allowed(through({ token: 'y'.repeat(43) }), routeNamed('carry'), guarding())
    expect(!verdict.ok && verdict.refusal.error).toBe('bad_origin')
  })
})

/** A machine whose window wired every one of the eight, each recording that it was asked. */
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
      owned: {
        machine: heard('machine'),
        document: heard('document'),
        tool: heard('tool'),
        // Never reached: its body is read before anything of it is.
        carrying: {} as never,
      },
      connecting: { page: heard('connect') } as never,
    },
  )
  return { one, asked }
}

/** POST one of the eight at this machine's own door, as a paired device. */
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

/** Give a paired device every scope and every grant: the person's own. */
async function fullAccess(one: Running, device: string): Promise<void> {
  await allowDevice(one.home, device, SCOPES, new Date())
  await grantDevice(one.home, device, GRANTS, new Date())
}

describe('the person’s own device at this machine’s door', () => {
  // A phone pairs on this machine's own address in these tests, so the door
  // lets it through and what is under test is each handler's own gate, which
  // asks the record: a body that does not parse is `malformed` past it and
  // `out_of_scope` before it, so no window half is ever reached.

  it('is answered each of the eight past the owner’s gate, where an ordinary device is refused', async () => {
    const { one, asked } = await wired()
    const phone = await pair(one, { label: 'mine' })
    const other = await pair(one, { label: 'theirs too?' })
    await fullAccess(one, phone.device)
    for (const name of THEIRS) {
      const path = routeNamed(name).path
      const mine = await post(one, phone, path, { bogus: 1 })
      expect(mine.status, `${name}: ${mine.text}`).toBe(400)
      const ordinary = await post(one, other, path, { bogus: 1 })
      expect(ordinary.status, name).toBe(403)
    }
    expect(asked).toEqual([])
  })

  it('says presence and gets an attach line, as the window answers an owner', async () => {
    const { one, asked } = await wired()
    const phone = await pair(one)
    await fullAccess(one, phone.device)
    expect((await post(one, phone, '/api/presence', { ago: 0 })).status).toBe(200)
    const line = await post(one, phone, '/api/attach', { task: 'app/fix-it' })
    expect(line.status, line.text).toBe(200)
    expect(JSON.parse(line.text)).toEqual({ command: 'tmux attach -t app/fix-it' })
    expect(asked).toEqual([`presence ${phone.device}`, 'attach app/fix-it'])
  })

  it('is an ordinary device again at the next request once one box is unticked', async () => {
    const { one, asked } = await wired()
    const phone = await pair(one)
    await fullAccess(one, phone.device)
    expect((await post(one, phone, '/api/presence', { ago: 0 })).status).toBe(200)
    await grantDevice(
      one.home,
      phone.device,
      GRANTS.filter((grant) => grant !== GRANTS[0]),
      new Date(),
    )
    expect((await post(one, phone, '/api/presence', { ago: 0 })).status).toBe(403)
    expect(asked).toHaveLength(1)
  })

  it('is nothing at the next request once it is revoked', async () => {
    const { one, asked } = await wired()
    const phone = await pair(one)
    await fullAccess(one, phone.device)
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

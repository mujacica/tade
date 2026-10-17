import { chmod, chown, mkdtemp } from 'node:fs/promises'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PASSKEY_BEFORE_ACTING, PASSKEY_BEFORE_ACTING_SHORT } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { appendDevice, readDevices } from '../src/devices.ts'
import { ENROL_MS, PROVE_TRIES } from '../src/passkeys.ts'
import { userIdOf } from '../src/webauthn.ts'
import { type Ceremony, SoftAuthenticator } from './authenticator.ts'
import { type Answer, actingStub, ask, closeAll, pair, type Running, start } from './harness.ts'

// A passkey per device and the proof before acting from the public name
// (REMOTE-TADE.md §4.4, V5), end to end: through the socket Caddy connects to,
// over a real listener, with a software authenticator making real keys and
// real signatures. `guard.test.ts` holds every cell of the gate;
// `webauthn.test.ts` every check of an answer; this is that they are wired.

const NAME = 'tade.example.com'
const ORIGIN = `https://${NAME}`
const HOUR = 3_600_000

afterEach(closeAll)

interface Phone {
  one: Running
  socket: string
  cookie: string
  csrf: string
  device: string
  clock: { at: number }
}

/** A machine with a public name, and a phone paired through it that may steer. */
async function phone(hours = 12): Promise<Phone> {
  const dir = await mkdtemp(join(tmpdir(), 'tade-pk-'))
  // This user's own group first: a folder in `/tmp` is `wheel`'s, and a setgid
  // bit on a group its owner is not in is dropped without a word.
  await chown(dir, process.getuid?.() ?? 0, process.getgid?.() ?? 0)
  await chmod(dir, 0o2750)
  const socket = join(dir, 'away.sock')
  const clock = { at: Date.now() }
  const one = await start(
    { publicName: NAME, trustedHosts: [NAME], passkeyMs: hours * HOUR, acting: true },
    { publicSocket: socket, acting: actingStub(), now: () => clock.at },
  )
  one.answer = async () => ({ let: true, projects: null, granted: [], scopes: ['read', 'steer'] })
  const paired = await viaCaddy(socket, '/api/pair', {
    method: 'POST',
    body: { ticket: one.tickets.mint(`${ORIGIN}/pair`, clock.at).value, label: 'iPhone' },
  })
  expect(paired.status).toBe(201)
  const body = JSON.parse(paired.text) as { device: string; csrf: string }
  const cookie = (paired.headers['set-cookie'] ?? '').split(';')[0] ?? ''
  return { one, socket, cookie, csrf: body.csrf, device: body.device, clock }
}

/** One request through the socket, as Caddy makes it, from the page on the public name. */
function viaCaddy(
  socket: string,
  path: string,
  over: { method?: string; body?: unknown; cookie?: string; csrf?: string; origin?: string } = {},
): Promise<Answer> {
  const text = over.body === undefined ? undefined : JSON.stringify(over.body)
  const method = over.method ?? 'GET'
  const headers: Record<string, string> = {
    host: NAME,
    // **As a browser sends it**: no `Origin` on a same-origin `GET`, which is
    // what made the page's own read of its standing come through Caddy's
    // plaintext socket as `http` — found by Chromium, not by this file.
    ...(method === 'GET' ? {} : { origin: over.origin ?? ORIGIN }),
    'sec-fetch-site': 'same-origin',
    ...(text === undefined
      ? {}
      : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }),
    ...(over.cookie === undefined ? {} : { cookie: over.cookie }),
    ...(over.csrf === undefined ? {} : { 'x-tade-csrf': over.csrf }),
  }
  return new Promise((done, failed) => {
    const req = request(
      { path, method, headers, createConnection: () => connect(socket) },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.join(', ') : String(v ?? ''),
              ]),
            ),
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', failed)
    if (text !== undefined) req.write(text)
    req.end()
  })
}

const as = (p: Phone, path: string, body?: unknown) =>
  viaCaddy(p.socket, path, {
    method: body === undefined ? 'GET' : 'POST',
    body,
    cookie: p.cookie,
    csrf: p.csrf,
  })

/** What `/api/devices` tells this phone about its passkey. */
async function standing(p: Phone) {
  const got = await as(p, '/api/devices')
  expect(got.status).toBe(200)
  return (JSON.parse(got.text) as { you: { passkey: Record<string, unknown> } }).you.passkey
}

/** A challenge, as the page asks for one. */
async function challenge(p: Phone) {
  const got = await as(p, '/api/passkey/challenge', {})
  return {
    status: got.status,
    body: JSON.parse(got.text) as { ceremony?: string; options: { challenge: string } },
  }
}

/** One act that needs `steer`, and what came of it at the door. */
async function park(p: Phone): Promise<{ status: number; error: string }> {
  const got = await as(p, '/api/act/park', {})
  return { status: got.status, error: (JSON.parse(got.text) as { error?: string }).error ?? '' }
}

const ceremonyOf = (options: { challenge: string }): Ceremony => ({
  challenge: options.challenge,
  origin: ORIGIN,
  rpId: NAME,
})

/** Make this phone's passkey, through both routes. */
async function enrol(p: Phone, box = new SoftAuthenticator()): Promise<Answer> {
  const set = await challenge(p)
  expect(set.status).toBe(200)
  expect(set.body.ceremony).toBe('create')
  return as(p, '/api/passkey/answer', box.make(ceremonyOf(set.body.options)))
}

/** Use it. */
async function prove(
  p: Phone,
  box: SoftAuthenticator,
  over: Partial<Ceremony> = {},
): Promise<Answer> {
  const set = await challenge(p)
  expect(set.body.ceremony).toBe('get')
  return as(
    p,
    '/api/passkey/answer',
    box.prove(
      { ...ceremonyOf(set.body.options), ...over },
      {
        userHandle: userIdOf(p.device),
      },
    ),
  )
}

const proved = (p: Phone) =>
  p.one.told.flatMap((line) => (line.type === 'web_proved' ? [line.detail] : []))

describe('a passkey, made in the minutes after pairing', () => {
  it('is offered at once, asked before acting, and lets the phone act once made', async () => {
    const p = await phone()
    expect(await standing(p)).toMatchObject({ asks: true, made: false, until: null, hours: 12 })
    expect((await standing(p)).makeBy).toBe(new Date(p.clock.at + ENROL_MS).toISOString())
    // Reading never asks; acting does, before anything about the act is read.
    expect((await as(p, '/api/snapshot')).status).toBe(200)
    expect(await park(p)).toEqual({ status: 403, error: 'unproven' })
    expect(
      p.one.told.some((line) => line.type === 'web_did' && line.detail.why === 'unproven'),
    ).toBe(true)

    const made = await enrol(p)
    expect(made.status).toBe(200)
    expect(JSON.parse(made.text)).toEqual({
      made: true,
      until: new Date(p.clock.at + 12 * HOUR).toISOString(),
    })
    expect(await standing(p)).toMatchObject({ made: true, proven: true, makeBy: null })
    // Past the gate: the act is now refused for being an empty act, not for the passkey.
    expect(await park(p)).toEqual({ status: 400, error: 'malformed' })
    expect(proved(p)).toEqual([
      { device: p.device, ceremony: 'create', state: 'made', synced: false },
    ])
    // Written down, and public: the key and never anything to sign with.
    const kept = (await readDevices(p.one.home)).devices.find((one) => one.id === p.device)
    expect(kept?.passkey?.alg).toBe(-7)
  })

  it('asks again once the hours are up, and the same passkey answers', async () => {
    const p = await phone()
    const box = new SoftAuthenticator()
    expect((await enrol(p, box)).status).toBe(200)
    p.clock.at += 12 * HOUR
    expect(await park(p)).toEqual({ status: 403, error: 'unproven' })
    expect(await standing(p)).toMatchObject({
      proven: false,
      until: new Date(p.clock.at).toISOString(),
    })
    const again = await prove(p, box)
    expect(again.status).toBe(200)
    expect(await park(p)).toEqual({ status: 400, error: 'malformed' })
    expect(proved(p).at(-1)).toEqual({ device: p.device, ceremony: 'get', state: 'proved' })
  })

  it('is never made later: past the minutes after pairing, the phone reads and does not act', async () => {
    const p = await phone()
    p.clock.at += ENROL_MS
    expect(await standing(p)).toMatchObject({ asks: true, made: false, makeBy: null })
    const set = await challenge(p)
    expect(set.status).toBe(404)
    expect(await park(p)).toEqual({ status: 403, error: 'unproven' })
    expect((await as(p, '/api/snapshot')).status).toBe(200)
  })

  it('is one per device: a second is never made over the first', async () => {
    const p = await phone()
    const box = new SoftAuthenticator()
    expect((await enrol(p, box)).status).toBe(200)
    // Asked again, the machine offers using it, never making another.
    expect((await challenge(p)).body.ceremony).toBe('get')
  })
})

describe('a request no page of Tade’s sends', () => {
  it('refuses a challenge from a plaintext page, a body that is not JSON, and one that names anything', async () => {
    const p = await phone()
    const plain = await viaCaddy(p.socket, '/api/passkey/challenge', {
      method: 'POST',
      body: {},
      cookie: p.cookie,
      csrf: p.csrf,
      origin: `http://${NAME}`,
    })
    expect(plain.status).toBe(403)
    expect(JSON.parse(plain.text).error).toBe('locked')
    const named = await as(p, '/api/passkey/challenge', { device: 'ffeeddccbbaa9988' })
    expect(named.status).toBe(400)
    const headers = {
      host: NAME,
      origin: ORIGIN,
      cookie: p.cookie,
      'x-tade-csrf': p.csrf,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    }
    const broken = await new Promise<number>((done, failed) => {
      const req = request(
        {
          path: '/api/passkey/answer',
          method: 'POST',
          headers: { ...headers, 'content-length': '9' },
          createConnection: () => connect(p.socket),
        },
        (res) => {
          res.resume()
          done(res.statusCode ?? 0)
        },
      )
      req.on('error', failed)
      req.end('{not json')
    })
    expect(broken).toBe(400)
  })

  it('makes no second passkey over one another window wrote between the challenge and the answer', async () => {
    const p = await phone()
    const set = await challenge(p)
    await appendDevice(p.one.home, {
      kind: 'passkey',
      device: p.device,
      at: new Date(p.clock.at).toISOString(),
      id: 'c'.repeat(43),
      key: 'k'.repeat(120),
      alg: -7,
      counter: 0,
      synced: true,
      transports: [],
    })
    const late = await as(
      p,
      '/api/passkey/answer',
      new SoftAuthenticator().make(ceremonyOf(set.body.options)),
    )
    expect(late.status).toBe(403)
    expect(proved(p).at(-1)).toMatchObject({ state: 'refused', why: 'it already has one' })
  })

  it('proves nothing for a device whose passkey went between the challenge and the answer', async () => {
    // Pairing the same id again — a written code claimed twice by hand — is a
    // device with no passkey, and the fold says so.
    const p = await phone()
    const box = new SoftAuthenticator()
    expect((await enrol(p, box)).status).toBe(200)
    p.clock.at += 13 * HOUR
    const set = await challenge(p)
    const was = (await readDevices(p.one.home)).devices.find((one) => one.id === p.device)
    if (was === undefined) throw new Error('paired')
    await appendDevice(p.one.home, {
      kind: 'paired',
      device: was.id,
      at: new Date(p.clock.at).toISOString(),
      label: was.label,
      digest: was.digest,
      host: was.host,
      csrf: was.csrf,
      until: new Date(was.until).toISOString(),
      scopes: [...was.scopes] as ('read' | 'steer')[],
      projects: null,
      granted: [],
      from: was.from,
    })
    const got = await as(p, '/api/passkey/answer', box.prove(ceremonyOf(set.body.options)))
    expect(got.status).toBe(403)
    expect(proved(p).at(-1)).toMatchObject({ state: 'refused', why: 'it has none' })
  })
})

describe('an answer that does not hold', () => {
  it('is refused, written down with its reason, and spends the challenge', async () => {
    const p = await phone()
    const set = await challenge(p)
    const box = new SoftAuthenticator()
    const forged = box.make({ ...ceremonyOf(set.body.options), origin: 'https://evil.example' })
    const got = await as(p, '/api/passkey/answer', forged)
    expect(got.status).toBe(403)
    expect(JSON.parse(got.text).error).toBe('unproven')
    expect(proved(p).at(-1)).toMatchObject({ ceremony: 'create', state: 'refused' })
    expect(String(proved(p).at(-1)?.why)).toContain('origin')
    // The same challenge answered properly now finds none.
    const late = await as(p, '/api/passkey/answer', box.make(ceremonyOf(set.body.options)))
    expect(late.status).toBe(409)
  })

  it('cannot be replayed', async () => {
    const p = await phone()
    const box = new SoftAuthenticator()
    expect((await enrol(p, box)).status).toBe(200)
    p.clock.at += 13 * HOUR
    const set = await challenge(p)
    const answer = box.prove(ceremonyOf(set.body.options))
    expect((await as(p, '/api/passkey/answer', answer)).status).toBe(200)
    p.clock.at += 13 * HOUR
    await challenge(p)
    // Last time's answer, to this time's challenge.
    expect((await as(p, '/api/passkey/answer', answer)).status).toBe(403)
    expect(await park(p)).toEqual({ status: 403, error: 'unproven' })
  })

  it('slows a device that keeps failing', async () => {
    const p = await phone()
    const box = new SoftAuthenticator()
    expect((await enrol(p, box)).status).toBe(200)
    p.clock.at += 13 * HOUR
    for (let n = 0; n < PROVE_TRIES; n++) {
      const got = await prove(p, box, { hashedRpId: 'evil.example' })
      expect(got.status).toBe(403)
    }
    const slowed = await prove(p, box)
    expect(slowed.status).toBe(429)
  })

  it('is a refusal for a challenge that ran out', async () => {
    const p = await phone()
    const set = await challenge(p)
    p.clock.at += 5 * 60_000
    const late = await as(
      p,
      '/api/passkey/answer',
      new SoftAuthenticator().make(ceremonyOf(set.body.options)),
    )
    expect(late.status).toBe(409)
  })
})

describe('what is said where the hours are set', () => {
  it('says what it stops, then the two halves the comfortable version leaves out, then off', () => {
    // A passkey is not *only that phone can act*: a synced one is the
    // keychain's, and the proof still rides on that device's session.
    // `separation.test.ts` holds it to never calling anything safe or secure.
    expect(PASSKEY_BEFORE_ACTING).toContain('a session copied off it reads and cannot act')
    expect(PASSKEY_BEFORE_ACTING).toContain('in the minutes after it pairs')
    expect(PASSKEY_BEFORE_ACTING).toContain('reads until it pairs again')
    expect(PASSKEY_BEFORE_ACTING).toContain('your keychain’s rather than the phone’s')
    expect(PASSKEY_BEFORE_ACTING).toContain('still needs that device’s own session')
    expect(PASSKEY_BEFORE_ACTING).toContain('Reading never asks')
    expect(PASSKEY_BEFORE_ACTING).toContain('Nought asks nothing, and then a session alone acts')
    expect(PASSKEY_BEFORE_ACTING_SHORT).toContain('nought asks nothing')
  })
})

describe('where nothing is asked', () => {
  it('asks nothing and offers nothing with the hours at nought', async () => {
    const p = await phone(0)
    expect(await standing(p)).toMatchObject({ asks: false, makeBy: null })
    expect((await challenge(p)).status).toBe(404)
    expect(await park(p)).toEqual({ status: 400, error: 'malformed' })
  })

  it('asks nothing on this machine, nor offers a passkey there', async () => {
    const one = await start({ acting: true, passkeyMs: 12 * HOUR }, { acting: actingStub() })
    one.answer = async () => ({ let: true, projects: null, granted: [], scopes: ['read', 'steer'] })
    const mine = await pair(one)
    const headers = {
      cookie: mine.cookie,
      origin: one.origin,
      'content-type': 'application/json',
      'x-tade-csrf': mine.csrf,
    }
    const parked = await ask(one, '/api/act/park', { method: 'POST', headers, body: '{}' })
    expect(parked.status).toBe(400)
    const offered = await ask(one, '/api/passkey/challenge', {
      method: 'POST',
      headers,
      body: '{}',
    })
    expect(offered.status).toBe(404)
    const devices = await ask(one, '/api/devices', { headers: { cookie: mine.cookie } })
    expect(JSON.parse(devices.text).you.passkey).toMatchObject({ asks: false })
  })
})

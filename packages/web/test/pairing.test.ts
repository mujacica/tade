import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readDevices, writeDevices } from '../src/devices.ts'
import type { Reach } from '../src/reach.ts'
import { CSRF_HEADER, labelOf } from '../src/request.ts'
import { type Confirmed, webServer } from '../src/server.ts'
import { SESSION_MS } from '../src/sessions.ts'
import { Tickets } from '../src/tickets.ts'
import {
  ask,
  BASE,
  closeAll,
  homeFor,
  pair,
  type Running,
  reading,
  said,
  start,
} from './harness.ts'

// **The credential**: minting one, what is written down about it, using it,
// renewing it, and losing it. The door it goes through is `server.test.ts`.
//
// The ordering questions are the point of this file: a replay, two requests
// racing with one ticket, a refusal, a deadline and a throw all have to find
// nothing, and all five follow from the ticket being burned on the *claim*
// rather than on the answer.

afterEach(closeAll)

describe('pairing', () => {
  it('asks at the machine, mints a session and sets a cookie a script cannot read', async () => {
    const one = await start()
    const paired = await pair(one)
    expect(paired.answer.status).toBe(201)
    expect(one.asked).toHaveLength(1)
    expect(one.asked[0]?.label).toBe('iPhone')
    const set = paired.answer.headers['set-cookie'] ?? ''
    expect(set).toContain('HttpOnly')
    expect(set).toContain('SameSite=Strict')
    // Over plain HTTP, so no `Secure` — a browser would discard one, which
    // would be a pairing that appeared to work and then had no session.
    expect(set).not.toContain('Secure')
    const line = one.told.find((told) => told.type === 'web_paired')
    expect(line?.detail.device).toBe(paired.device)
    // The label is a person's own words about their own phone, and is
    // deliberately not in the line that telemetry may read.
    expect(JSON.stringify(line?.detail)).not.toContain('iPhone')
  })

  it('writes down only the digest, never the secret', async () => {
    const one = await start()
    const paired = await pair(one)
    const secret = paired.cookie.split('.')[1] ?? ''
    expect(secret).not.toBe('')
    const file = await readFile(join(one.home, 'web-devices.jsonl'), 'utf8')
    expect(file).not.toContain(secret)
    const { devices } = await readDevices(one.home)
    expect(devices[0]?.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reads the session on the next request', async () => {
    const one = await start()
    const paired = await pair(one)
    const answer = await ask(one, '/api/snapshot', { headers: { cookie: paired.cookie } })
    expect(answer.status).toBe(200)
    expect(said(answer).v).toBe(1)
  })

  it('refuses a replayed pairing request, with the ticket already burned', async () => {
    const one = await start()
    const ticket = one.tickets.mint(`${one.origin}/pair`, Date.now())
    const body = JSON.stringify({ ticket: ticket.value, label: 'iPhone' })
    const headers = { origin: one.origin, 'content-type': 'application/json' }
    const first = await ask(one, '/api/pair', { method: 'POST', headers, body })
    expect(first.status).toBe(201)
    const again = await ask(one, '/api/pair', { method: 'POST', headers, body })
    expect(again.status).toBe(401)
    // One device, not two: the replay did not reach the person at the machine
    // either, which is the half a check-then-ask ordering would have missed.
    expect((await readDevices(one.home)).devices).toHaveLength(1)
    expect(one.asked).toHaveLength(1)
  })

  it('refuses two concurrent pairings with one ticket, and asks once', async () => {
    const one = await start()
    one.answer = async () =>
      new Promise((done) => setTimeout(() => done({ let: true, projects: null, granted: [] }), 20))
    const ticket = one.tickets.mint(`${one.origin}/pair`, Date.now())
    const body = JSON.stringify({ ticket: ticket.value, label: 'iPhone' })
    const headers = { origin: one.origin, 'content-type': 'application/json' }
    const both = await Promise.all([
      ask(one, '/api/pair', { method: 'POST', headers, body }),
      ask(one, '/api/pair', { method: 'POST', headers, body }),
    ])
    expect(both.map((answer) => answer.status).sort()).toEqual([201, 401])
    expect(one.asked).toHaveLength(1)
    expect((await readDevices(one.home)).devices).toHaveLength(1)
  })

  it('burns the ticket on a refusal, so there is no second try', async () => {
    const one = await start()
    one.answer = async () => ({ let: false, why: 'refused' })
    const ticket = one.tickets.mint(`${one.origin}/pair`, Date.now())
    const body = JSON.stringify({ ticket: ticket.value, label: 'iPhone' })
    const headers = { origin: one.origin, 'content-type': 'application/json' }
    expect((await ask(one, '/api/pair', { method: 'POST', headers, body })).status).toBe(401)
    expect(one.told.find((told) => told.type === 'web_denied')?.detail.why).toBe('refused')
    one.answer = async () => ({ let: true, projects: null, granted: [] })
    // The same ticket, now that somebody would say yes. Still nothing.
    expect((await ask(one, '/api/pair', { method: 'POST', headers, body })).status).toBe(401)
    expect((await readDevices(one.home)).devices).toHaveLength(0)
  })

  it('answers when nobody answers, and burns the ticket doing it', async () => {
    const one = await start({}, { confirmMs: 30 })
    // A promise that never settles: the person walked away.
    one.answer = () => new Promise<Confirmed>(() => {})
    const ticket = one.tickets.mint(`${one.origin}/pair`, Date.now())
    const body = JSON.stringify({ ticket: ticket.value, label: 'iPhone' })
    const headers = { origin: one.origin, 'content-type': 'application/json' }
    const answer = await ask(one, '/api/pair', { method: 'POST', headers, body })
    expect(answer.status).toBe(401)
    // A deadline is an answer and not a crash: `web_denied`, not `broke`.
    expect(one.told.find((told) => told.type === 'web_denied')?.detail.why).toBe('nobody answered')
    expect(one.told.some((told) => told.type === 'warning')).toBe(false)
    expect((await ask(one, '/api/pair', { method: 'POST', headers, body })).status).toBe(401)
  })

  it('tells a refusal from a deadline in the journal and not on the wire', async () => {
    const refused = await start()
    refused.answer = async () => ({ let: false, why: 'refused' })
    const quiet = await start({}, { confirmMs: 30 })
    quiet.answer = () => new Promise<Confirmed>(() => {})
    const answers = await Promise.all([pair(refused), pair(quiet)])
    // The same status and the same sentence to the phone — "there is nobody at
    // that machine" is a fact about somebody's day.
    expect(answers.map((one) => one.answer.status)).toEqual([401, 401])
    const both = answers.map((one) => said(one.answer))
    expect(both[0]).toEqual(both[1])
  })

  it('survives a confirm that throws, and says so where a person can read it', async () => {
    const one = await start()
    one.answer = async () => {
      throw new Error('the window fell over')
    }
    const paired = await pair(one)
    expect(paired.answer.status).toBe(500)
    const body = said(paired.answer)
    expect(body.error).toBe('broke')
    // A request id and a sentence; never a stack trace and never the message.
    expect(String(body.request)).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(body)).not.toContain('fell over')
    const warning = one.told.find((told) => told.type === 'warning')
    expect(String(warning?.detail.warning)).toContain('fell over')
    expect(warning?.detail.request).toBe(body.request)
  })

  it('refuses a ticket that was never minted, and one of the wrong shape', async () => {
    const one = await start()
    const headers = { origin: one.origin, 'content-type': 'application/json' }
    for (const [ticket, status] of [
      ['A'.repeat(27), 401],
      ['A'.repeat(26), 400],
      // Over the body cap, and so refused by it: the cap is counted as the
      // bytes arrive, before anything is parsed or compared.
      ['A'.repeat(100_000), 413],
      ['', 400],
    ] as const) {
      const answer = await ask(one, '/api/pair', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ticket, label: 'x' }),
      })
      expect(answer.status, ticket.slice(0, 10)).toBe(status)
    }
    expect(one.asked).toHaveLength(0)
  })

  it('refuses a ticket in a query string, because no route reads one', async () => {
    const one = await start()
    const ticket = one.tickets.mint(`${one.origin}/pair`, Date.now())
    const answer = await ask(one, `/api/pair?ticket=${ticket.value}`, {
      method: 'POST',
      headers: { origin: one.origin, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(answer.status).toBe(400)
    expect(one.asked).toHaveLength(0)
  })

  it('refuses a body that is not an object, and one that is not JSON', async () => {
    const one = await start()
    const headers = { origin: one.origin, 'content-type': 'application/json' }
    // `null` is in here for a reason: it is a perfectly good JSON body and a
    // four-byte one, so a handler that used `null` to mean "already refused"
    // would return without answering and hold the request open for ever.
    for (const body of ['[]', '"a string"', '42', 'null', 'not json'])
      expect((await ask(one, '/api/pair', { method: 'POST', headers, body })).status, body).toBe(
        400,
      )
    // And the sixth is a `429`, because a malformed body counts against the
    // pairing limit like anything else: otherwise a bad body is a free,
    // unlimited probe of the one route that mints a credential.
    expect((await ask(one, '/api/pair', { method: 'POST', headers, body: '{' })).status).toBe(429)
    expect(one.asked).toHaveLength(0)
  })

  it('bounds the label to something a person can read', () => {
    expect(labelOf('x'.repeat(100))).toHaveLength(40)
    expect(labelOf('  iPhone \n of mine ')).toBe('iPhone   of mine')
    expect(labelOf('a\r\nb')).toBe('a b')
  })

  it('keeps the label verbatim otherwise, because it is somebody’s own words', async () => {
    const one = await start()
    await pair(one, { label: "Amir's iPhone 15" })
    const { devices } = await readDevices(one.home)
    expect(devices[0]?.label).toBe("Amir's iPhone 15")
  })
})
describe('a session over time', () => {
  it('is gone once it has expired, and the device list says why nothing works', async () => {
    const one = await start()
    const paired = await pair(one)
    const { devices } = await readDevices(one.home)
    const device = devices[0]
    if (device === undefined) throw new Error('nothing paired')
    // Rewritten in the past rather than waiting thirty days.
    await writeDevices(one.home, [
      {
        kind: 'paired',
        device: device.id,
        at: new Date(Date.now() - SESSION_MS * 2).toISOString(),
        label: device.label,
        digest: device.digest,
        host: device.host,
        csrf: device.csrf,
        until: new Date(Date.now() - 1000).toISOString(),
        scopes: ['read'],
        projects: null,
        granted: [],
        from: device.from,
      },
    ])
    const answer = await ask(one, '/api/snapshot', { headers: { cookie: paired.cookie } })
    expect(answer.status).toBe(401)
  })

  it('survives a restart, because the credential is in a file and not in memory', async () => {
    const one = await start()
    const paired = await pair(one)
    await one.server.close()
    // A second server over the same home: a new process, nothing kept.
    const again = webServer({
      home: one.home,
      surface: BASE,
      readingFor: reading,
      tickets: new Tickets(),
      confirm: async () => ({ let: false, why: 'refused' }),
    })
    const bound = await again.listen()
    const at = bound.find((address) => address.startsWith('127.0.0.1')) ?? ''
    const answer = await ask(
      { ...one, server: again, host: at, origin: `http://${at}` },
      '/api/snapshot',
      {
        headers: { cookie: paired.cookie },
      },
    )
    // The cookie is bound to the host it was minted for, so a different port
    // is deliberately not the same session. What survived is the device.
    expect(answer.status).toBe(401)
    expect((await readDevices(one.home)).devices[0]?.revoked).toBeNull()
    await again.close()
  })

  it('signs this device out, and only this device', async () => {
    const one = await start()
    const mine = await pair(one, { label: 'iPhone' })
    const theirs = await pair(one, { label: 'iPad' })
    const refused = await ask(one, `/api/devices/${theirs.device}`, {
      method: 'DELETE',
      headers: {
        cookie: mine.cookie,
        origin: one.origin,
        'content-type': 'application/json',
        [CSRF_HEADER]: mine.csrf,
      },
    })
    // Revoking another device is the window's: otherwise one stolen phone
    // disconnects the others while it still works.
    expect(refused.status).toBe(403)
    expect(said(refused).error).toBe('out_of_scope')

    const mineGone = await ask(one, `/api/devices/${mine.device}`, {
      method: 'DELETE',
      headers: {
        cookie: mine.cookie,
        origin: one.origin,
        'content-type': 'application/json',
        [CSRF_HEADER]: mine.csrf,
      },
    })
    expect(mineGone.status).toBe(200)
    expect(mineGone.headers['set-cookie']).toContain('Max-Age=0')
    expect((await ask(one, '/api/snapshot', { headers: { cookie: mine.cookie } })).status).toBe(401)
    // Theirs still works, which is the half the test is for.
    expect((await ask(one, '/api/snapshot', { headers: { cookie: theirs.cookie } })).status).toBe(
      200,
    )
    expect(one.told.filter((told) => told.type === 'web_revoked')).toHaveLength(1)
  })

  it('reads a device list that names every device and no secret', async () => {
    const one = await start()
    const mine = await pair(one, { label: 'iPhone' })
    await pair(one, { label: 'iPad' })
    const answer = await ask(one, '/api/devices', { headers: { cookie: mine.cookie } })
    const body = said(answer) as unknown as {
      you: Record<string, unknown>
      devices: Record<string, unknown>[]
    }
    expect(body.devices).toHaveLength(2)
    expect(body.devices.map((device) => device.label).sort()).toEqual(['iPad', 'iPhone'])
    expect(body.devices.filter((device) => device.you)).toHaveLength(1)
    const text = JSON.stringify(body)
    // No digest, no host, no address, and no token but this device's own.
    const { devices } = await readDevices(one.home)
    for (const device of devices) {
      expect(text).not.toContain(device.digest)
      expect(text).not.toContain(device.from)
      if (device.id !== mine.device) expect(text).not.toContain(device.csrf)
    }
  })

  it('renews a session that has been used a day later, once', async () => {
    const one = await start()
    const paired = await pair(one)
    const { devices } = await readDevices(one.home)
    const device = devices[0]
    if (device === undefined) throw new Error('nothing paired')
    // Its expiry pushed a day into the past, which is what a day of use looks
    // like to `renewal`.
    await writeDevices(one.home, [
      {
        kind: 'paired',
        device: device.id,
        at: new Date(device.pairedAt).toISOString(),
        label: device.label,
        digest: device.digest,
        host: device.host,
        csrf: device.csrf,
        until: new Date(device.until - 2 * 24 * 60 * 60_000).toISOString(),
        scopes: ['read'],
        projects: null,
        granted: [],
        from: device.from,
      },
    ])
    expect((await ask(one, '/api/snapshot', { headers: { cookie: paired.cookie } })).status).toBe(
      200,
    )
    const file = await readFile(join(one.home, 'web-devices.jsonl'), 'utf8')
    expect(file.split('\n').filter((line) => line.includes('"renewed"'))).toHaveLength(1)
    // And not again on the next request: the bound is what keeps a sliding
    // expiry from being a write per request.
    await ask(one, '/api/snapshot', { headers: { cookie: paired.cookie } })
    const after = await readFile(join(one.home, 'web-devices.jsonl'), 'utf8')
    expect(after.split('\n').filter((line) => line.includes('"renewed"'))).toHaveLength(1)
  })
})
describe('read scopes, enforced', () => {
  it('hands the projection the reach the device was granted, and not another', async () => {
    const reaches: Reach[] = []
    const home = await homeFor('reach')
    const tickets = new Tickets()
    let granted: readonly string[] = ['notes']
    let projects: readonly string[] | null = ['tade']
    const server = webServer({
      home,
      surface: BASE,
      readingFor: (reach) => {
        reaches.push(reach)
        return reading(reach)
      },
      tickets,
      confirm: async () => ({ let: true, projects, granted: granted as never }),
    })
    const bound = await server.listen()
    const at = bound.find((address) => address.startsWith('127.0.0.1')) ?? ''
    const one: Running = {
      server,
      home,
      tickets,
      told: [],
      asked: [],
      epoch: server.epoch,
      host: at,
      origin: `http://${at}`,
      answer: async () => ({ let: true, projects: null, granted: [] }),
    }
    // Its own server, because what is under test is the *grant* decided at
    // pairing time, and the harness's `start` answers every pairing the same
    // way. Closed by hand: `closeAll` only knows the ones `start` made.
    try {
      const narrow = await pair(one, { label: 'iPhone' })
      granted = ['notes', 'spend']
      projects = null
      const wide = await pair(one, { label: 'iPad' })

      await ask(one, '/api/snapshot', { headers: { cookie: narrow.cookie } })
      await ask(one, '/api/snapshot', { headers: { cookie: wide.cookie } })
      const [first, second] = reaches.slice(-2)
      expect(first?.granted).toEqual(['notes'])
      expect(first?.projects).toEqual({ kind: 'listed', names: ['tade'] })
      expect(second?.granted).toEqual(['notes', 'spend'])
      expect(second?.projects).toEqual({ kind: 'every' })
    } finally {
      await server.close()
    }
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { mintOwner } from '../src/owner.ts'
import { PRESENCE_MOST_MS, presenceOf } from '../src/presence.ts'
import { GRANTS } from '../src/reach.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { ROUTES } from '../src/routes.ts'
import { SCOPES } from '../src/surface.ts'
import { ask, closeAll, pair, start } from './harness.ts'

// Somebody at another of their screens (`presence.ts`): an owner's link says
// how long ago a key was pressed there, and this machine holds it as a
// moment in its own clock — so a VPS does not buzz the phone of somebody
// sitting at the Mac. Only an owner, only through this machine's own door,
// only an age, and never written down.

afterEach(closeAll)

describe('an owner saying the person is at another screen', () => {
  it('is handed to the window as a moment in this machine’s clock, from an age', async () => {
    const heard: { device: string; at: number }[] = []
    const one = await start({}, { present: (device, at) => heard.push({ device, at }) })
    const port = Number(one.host.split(':')[1])
    const owner = await mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
    const before = Date.now()
    const said = await ask(one, '/api/presence', {
      method: 'POST',
      headers: {
        host: owner.host,
        origin: `http://${owner.host}`,
        cookie: `tade_away=${owner.cookie}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: owner.csrf,
      },
      body: JSON.stringify({ ago: 5_000 }),
    })
    expect(said.status, said.text).toBe(200)
    expect(heard).toHaveLength(1)
    expect(heard[0]?.device).toBe(owner.device)
    // Five seconds before this machine's own clock at the request.
    expect(heard[0]?.at).toBeGreaterThanOrEqual(before - 5_000)
    expect(heard[0]?.at).toBeLessThanOrEqual(Date.now() - 5_000)
    // And nothing about it was written down: it is held, not a fact about work.
    expect(one.told.filter((line) => line.type !== 'warning')).toEqual([])
  })

  it('is refused from a device that is not an owner, and the window is told nothing', async () => {
    const heard: number[] = []
    const one = await start({}, { present: (_device, at) => heard.push(at) })
    const phone = await pair(one)
    const said = await ask(one, '/api/presence', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify({ ago: 0 }),
    })
    // A phone pairs on this machine's own address in this test, so the door
    // lets it through and the reason it is refused is the one that matters.
    expect(said.status).toBe(403)
    expect(heard).toEqual([])
  })

  it('is the 404 of a path nobody wired where the window did not hand a place for it', async () => {
    const one = await start()
    const port = Number(one.host.split(':')[1])
    const owner = await mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
    const said = await ask(one, '/api/presence', {
      method: 'POST',
      headers: {
        host: owner.host,
        origin: `http://${owner.host}`,
        cookie: `tade_away=${owner.cookie}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: owner.csrf,
      },
      body: JSON.stringify({ ago: 0 }),
    })
    expect(said.status).toBe(404)
  })

  it('answers only on this machine’s own door', () => {
    expect(ROUTES.find((route) => route.name === 'presence')).toMatchObject({
      method: 'POST',
      mutates: true,
      here: true,
    })
  })
})

describe('reading one', () => {
  const owner = { owner: true, scopes: [], granted: [] }

  it('takes an age and nothing else, bounded', () => {
    expect(presenceOf({ ago: 1_000 }, owner, 10_000)).toEqual({ ok: true, at: 9_000 })
    expect(presenceOf({ ago: PRESENCE_MOST_MS }, owner, PRESENCE_MOST_MS)).toEqual({
      ok: true,
      at: 0,
    })
    for (const body of [
      { ago: -1 },
      { ago: PRESENCE_MOST_MS + 1 },
      { ago: 1.5 },
      { ago: '1000' },
      { ago: 1, at: 5 },
      { at: 5 },
      null,
    ]) {
      const read = presenceOf(body, owner, 10_000)
      expect(read.ok, JSON.stringify(body)).toBe(false)
      if (!read.ok) expect(read.refusal.error).toBe('malformed')
    }
  })

  it('is an owner’s, or the person’s own device’s, and nobody else’s', () => {
    const read = presenceOf({ ago: 0 }, { owner: false, scopes: ['read'], granted: [] }, 10_000)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.refusal.error).toBe('out_of_scope')
    const theirs = { owner: false, scopes: [...SCOPES], granted: [...GRANTS] }
    expect(presenceOf({ ago: 0 }, theirs, 10_000)).toEqual({ ok: true, at: 10_000 })
    const less = { ...theirs, granted: GRANTS.slice(1) }
    expect(presenceOf({ ago: 0 }, less, 10_000).ok).toBe(false)
  })
})

describe('a device saying its own page is in front of somebody', () => {
  // `looking.ts`: any paired device, about itself alone, held by the window
  // and never written down — the moment this machine's, at the request.
  const posted = (
    one: Awaited<ReturnType<typeof start>>,
    phone: Awaited<ReturnType<typeof pair>>,
    body: unknown,
  ) =>
    ask(one, '/api/looking', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify(body),
    })

  it('is handed to the window as this device and this machine’s moment, and written nowhere', async () => {
    const heard: { device: string; at: number }[] = []
    const one = await start({}, { looking: (device, at) => heard.push({ device, at }) })
    const phone = await pair(one)
    const before = Date.now()
    const said = await posted(one, phone, {})
    expect(said.status, said.text).toBe(200)
    expect(heard).toHaveLength(1)
    expect(heard[0]?.device).toBe(phone.device)
    expect(heard[0]?.at).toBeGreaterThanOrEqual(before)
    expect(
      one.told.filter((line) => line.type !== 'warning' && line.type !== 'web_paired'),
    ).toEqual([])
  })

  it('carries nothing — a device to speak for, or a moment, is refused', async () => {
    const heard: number[] = []
    const one = await start({}, { looking: (_device, at) => heard.push(at) })
    const phone = await pair(one)
    for (const body of [{ device: 'another' }, { at: 5 }, { ago: 0 }, null]) {
      expect((await posted(one, phone, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(heard).toEqual([])
  })

  it('is the 404 of a path nobody wired where the window did not hand a place for it', async () => {
    const one = await start()
    const phone = await pair(one)
    expect((await posted(one, phone, {})).status).toBe(404)
  })

  it('answers any listener, a phone’s through Caddy included', () => {
    const route = ROUTES.find((one) => one.name === 'looking')
    expect(route).toMatchObject({ method: 'POST', mutates: true, needs: 'read' })
    expect(route?.here).toBeUndefined()
  })
})

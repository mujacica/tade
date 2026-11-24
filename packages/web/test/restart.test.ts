import { afterEach, describe, expect, it } from 'vitest'
import { allowDevice, grantDevice } from '../src/devices.ts'
import { GRANTS } from '../src/reach.ts'
import { CSRF_HEADER } from '../src/request.ts'
import type { WebOrchestratorRestart, WebRestarting } from '../src/restarted.ts'
import { OWNED } from '../src/routes.ts'
import { SCOPES } from '../src/surface.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// Restarting Tade from the person's own phone (`restarted.ts`): theirs and an
// owner's, never an ordinary phone's however much it was granted; one press
// where nothing would stop, and where lanes would, the count first and the
// restart only on a press that sends that count back.

afterEach(closeAll)

/** A window half with `stops` lanes inside it, recording each restart. */
function half(stops: number | null): WebRestarting & { restarted: string[] } {
  const restarted: string[] = []
  return {
    restarted,
    standing: () => (stops === null ? { cannot: 'no window here' } : { stops }),
    restart: (device) => restarted.push(device),
  }
}

function post(one: Running, device: Awaited<ReturnType<typeof pair>>, body: unknown) {
  return ask(one, '/api/restart', {
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

async function theirs(one: Running) {
  const phone = await pair(one, { label: 'mine' })
  await allowDevice(one.home, phone.device, SCOPES, new Date())
  await grantDevice(one.home, phone.device, GRANTS, new Date())
  return phone
}

describe('restarting Tade from the person’s own phone', () => {
  it('restarts on one press where nothing would stop, as the device’s', async () => {
    const restarting = half(0)
    const one = await start({}, { owned: { restarting } })
    const phone = await theirs(one)
    const said = await post(one, phone, { stops: 0 })
    expect(said.status, said.text).toBe(200)
    expect(JSON.parse(said.text)).toEqual({ restarting: true, stops: 0, said: null })
    expect(restarting.restarted).toEqual([phone.device])
  })

  it('answers how many lanes would stop and does nothing, then restarts on that number', async () => {
    const restarting = half(3)
    const one = await start({}, { owned: { restarting } })
    const phone = await theirs(one)
    const first = await post(one, phone, { stops: 0 })
    expect(first.status, first.text).toBe(200)
    expect(JSON.parse(first.text)).toEqual({ restarting: false, stops: 3, said: null })
    // A number nobody was shown stops nothing either.
    expect(JSON.parse((await post(one, phone, { stops: 2 })).text).restarting).toBe(false)
    expect(restarting.restarted).toEqual([])
    const second = await post(one, phone, { stops: 3 })
    expect(JSON.parse(second.text)).toEqual({ restarting: true, stops: 3, said: null })
    expect(restarting.restarted).toEqual([phone.device])
  })

  it('says why where this Tade cannot start itself again', async () => {
    const restarting = half(null)
    const one = await start({}, { owned: { restarting } })
    const phone = await theirs(one)
    const said = await post(one, phone, { stops: 0 })
    expect(JSON.parse(said.text)).toEqual({
      restarting: false,
      stops: null,
      said: 'no window here',
    })
    expect(restarting.restarted).toEqual([])
  })

  it('takes a count of lanes and nothing else', async () => {
    const restarting = half(0)
    const one = await start({}, { owned: { restarting } })
    const phone = await theirs(one)
    for (const body of [{}, { stops: -1 }, { stops: 1.5 }, { stops: '0' }, { stops: 0, now: 1 }]) {
      expect((await post(one, phone, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(restarting.restarted).toEqual([])
  })

  it('refuses an ordinary phone however much it was granted, and is the 404 of a path nobody wired', async () => {
    const restarting = half(0)
    const one = await start({}, { owned: { restarting } })
    const phone = await pair(one)
    await grantDevice(one.home, phone.device, GRANTS, new Date())
    const refused = await post(one, phone, { stops: 0 })
    expect(refused.status).toBe(403)
    const body = JSON.parse(refused.text)
    expect(body.error).toBe('out_of_scope')
    expect(body.needs).toEqual(SCOPES.filter((one) => one !== 'read'))
    expect(restarting.restarted).toEqual([])
    const none = await start()
    const mine = await theirs(none)
    expect((await post(none, mine, { stops: 0 })).status).toBe(404)
  })

  it('answers only on this machine’s own door, and the person’s own on any', () => {
    expect(OWNED.find((route) => route.name === 'restart')).toMatchObject({
      method: 'POST',
      path: '/api/restart',
      here: true,
      theirs: true,
    })
  })
})

/** A window half that starts its orchestrator again, or says `cannot`; recording each press. */
function orchestrator(
  cannot: string | null = null,
): WebOrchestratorRestart & { pressed: string[] } {
  const pressed: string[] = []
  return {
    pressed,
    restart: (device) => {
      pressed.push(device)
      return cannot === null ? { restarting: true } : { cannot }
    },
  }
}

function again(one: Running, device: Awaited<ReturnType<typeof pair>>, body: unknown) {
  return ask(one, '/api/orchestrator/restart', {
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

describe('starting the orchestrator alone again, from another of the person’s machines', () => {
  it('starts it again as the device’s, or says why it cannot', async () => {
    const orchestratorRestart = orchestrator()
    const one = await start({}, { owned: { orchestratorRestart } })
    const phone = await theirs(one)
    const said = await again(one, phone, {})
    expect(said.status, said.text).toBe(200)
    expect(JSON.parse(said.text)).toEqual({ restarting: true, said: null })
    expect(orchestratorRestart.pressed).toEqual([phone.device])
    const none = await start({}, { owned: { orchestratorRestart: orchestrator('nothing here') } })
    const mine = await theirs(none)
    expect(JSON.parse((await again(none, mine, {})).text)).toEqual({
      restarting: false,
      said: 'nothing here',
    })
  })

  it('takes nothing, refuses an ordinary phone, and is the 404 of a path nobody wired', async () => {
    const orchestratorRestart = orchestrator()
    const one = await start({}, { owned: { orchestratorRestart } })
    const mine = await theirs(one)
    expect((await again(one, mine, { account: 'work' })).status).toBe(400)
    const phone = await pair(one)
    await grantDevice(one.home, phone.device, GRANTS, new Date())
    const refused = await again(one, phone, {})
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.text).error).toBe('out_of_scope')
    expect(orchestratorRestart.pressed).toEqual([])
    const none = await start()
    expect((await again(none, await theirs(none), {})).status).toBe(404)
    expect(OWNED.find((route) => route.name === 'orchestrator restart')).toMatchObject({
      method: 'POST',
      path: '/api/orchestrator/restart',
      here: true,
      theirs: true,
    })
  })
})

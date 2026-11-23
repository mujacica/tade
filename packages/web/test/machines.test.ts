import { afterEach, describe, expect, it } from 'vitest'
import { allowDevice, grantDevice } from '../src/devices.ts'
import type { MachinesAnswer, MachinesPress, WebMachines } from '../src/machines.ts'
import { GRANTS } from '../src/reach.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import { SCOPES } from '../src/surface.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// The Machines page, for the person's own phone (`machines.ts`): every
// machine's inventory as the window's Settings › Machines draws it, and a
// press there. Theirs and an owner's, never an ordinary phone's however much
// it was granted; a press is the device's, and a move with no plan shown is
// refused rather than worked out and done unseen.

afterEach(closeAll)

const SHOWN: MachinesAnswer = {
  columns: [
    { machine: 'mac', asOf: null, here: true, said: null },
    { machine: 'vps', asOf: '2026-11-22T10:00:00.000Z', here: false, said: null },
  ],
  rows: [
    {
      id: 'secret:openai',
      kind: 'secret',
      label: 'OpenAI key',
      cells: [
        { mark: '✓', days: null, where: ['~/.zshenv:14'], said: 'only a shell sets it' },
        { mark: '✗', days: null, where: [], said: null },
      ],
    },
  ],
  looking: false,
  plan: null,
  busy: false,
  said: null,
  file: '~/.config/tade/env',
  agents: 'any agent can read it',
  notes: [
    {
      id: '0123456789abcdef',
      label: 'Retired on vps',
      note: 'deploys freeze on Fridays',
      said: 'vps would retire “deploys freeze on Fridays” — device phone: lifted',
    },
  ],
}

/** A window half that records each press, with a plan shown or not. */
function half(planned: boolean): WebMachines & { pressed: string[] } {
  const pressed: string[] = []
  return {
    pressed,
    shown: () => SHOWN,
    press: (press: MachinesPress, by: string) => {
      if (press === 'move' && !planned) return false
      pressed.push(`${press} ${by}`)
      return true
    },
    settle: (note: string, answer: 'take' | 'leave', by: string) => {
      if (note !== '0123456789abcdef') return false
      pressed.push(`${answer} ${note} ${by}`)
      return true
    },
  }
}

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

async function theirs(one: Running) {
  const phone = await pair(one, { label: 'mine' })
  await allowDevice(one.home, phone.device, SCOPES, new Date())
  await grantDevice(one.home, phone.device, GRANTS, new Date())
  return phone
}

describe('the Machines page, for the person’s own phone', () => {
  it('answers the page as the window holds it, and an empty body only', async () => {
    const machines = half(false)
    const one = await start({}, { owned: { machines } })
    const phone = await theirs(one)
    const said = await post(one, phone, '/api/machines', {})
    expect(said.status, said.text).toBe(200)
    expect(JSON.parse(said.text)).toEqual(SHOWN)
    for (const body of [{ machine: 'vps' }, null, []]) {
      expect((await post(one, phone, '/api/machines', body)).status).toBe(400)
    }
  })

  it('carries a press as the device’s, and answers with the page as it stands', async () => {
    const machines = half(true)
    const one = await start({}, { owned: { machines } })
    const phone = await theirs(one)
    for (const press of ['look', 'plan', 'move', 'leave']) {
      const said = await post(one, phone, '/api/machines/press', { press })
      expect(said.status, said.text).toBe(200)
      expect(JSON.parse(said.text)).toEqual(SHOWN)
    }
    expect(machines.pressed).toEqual(
      ['look', 'plan', 'move', 'leave'].map((press) => `${press} device ${phone.device}`),
    )
  })

  it('takes or leaves a note another machine changed, as the device’s press, and refuses one not waiting', async () => {
    const machines = half(false)
    const one = await start({}, { owned: { machines } })
    const phone = await theirs(one)
    for (const answer of ['take', 'leave']) {
      const said = await post(one, phone, '/api/machines/press', {
        note: '0123456789abcdef',
        answer,
      })
      expect(said.status, said.text).toBe(200)
      expect(JSON.parse(said.text).notes).toEqual(SHOWN.notes)
    }
    expect(machines.pressed).toEqual([
      `take 0123456789abcdef device ${phone.device}`,
      `leave 0123456789abcdef device ${phone.device}`,
    ])
    const taken = await post(one, phone, '/api/machines/press', {
      note: 'fedcba9876543210',
      answer: 'take',
    })
    expect(taken.status).toBe(409)
    expect(JSON.parse(taken.text).error).toBe('gone')
    for (const body of [
      { note: 'not a digest', answer: 'take' },
      { note: '0123456789abcdef', answer: 'forget' },
      { note: '0123456789abcdef', answer: 'take', press: 'look' },
    ]) {
      expect((await post(one, phone, '/api/machines/press', body)).status).toBe(400)
    }
    expect(machines.pressed).toHaveLength(2)
  })

  it('refuses a move nobody was shown the plan of, and a press it does not know', async () => {
    const machines = half(false)
    const one = await start({}, { owned: { machines } })
    const phone = await theirs(one)
    const move = await post(one, phone, '/api/machines/press', { press: 'move' })
    expect(move.status).toBe(409)
    expect(JSON.parse(move.text).error).toBe('gone')
    for (const body of [{ press: 'delete' }, { press: 'move', files: ['~/.zshrc'] }, {}]) {
      expect((await post(one, phone, '/api/machines/press', body)).status).toBe(400)
    }
    expect(machines.pressed).toEqual([])
  })

  it('refuses an ordinary phone however much it was granted, and is the 404 of a path nobody wired', async () => {
    const machines = half(true)
    const one = await start({}, { owned: { machines } })
    const phone = await pair(one)
    // Everything to read, but not every scope: not the person's own.
    await grantDevice(one.home, phone.device, GRANTS, new Date())
    const refused = await post(one, phone, '/api/machines', {})
    expect(refused.status).toBe(403)
    // Every box it lacks for full access is named, and no grant it has.
    const body = JSON.parse(refused.text)
    expect(body.error).toBe('out_of_scope')
    expect(body.needs).toEqual(SCOPES.filter((one) => one !== 'read'))
    expect((await post(one, phone, '/api/machines/press', { press: 'look' })).status).toBe(403)
    expect(machines.pressed).toEqual([])
    const none = await start()
    const mine = await theirs(none)
    expect((await post(none, mine, '/api/machines', {})).status).toBe(404)
    expect((await post(none, mine, '/api/machines/press', { press: 'look' })).status).toBe(404)
  })

  it('answers only on this machine’s own door, and the person’s own on any', () => {
    for (const name of ['machines', 'machines press']) {
      expect(OWNED.find((route) => route.name === name)).toMatchObject({
        method: 'POST',
        here: true,
        theirs: true,
      })
    }
  })
})

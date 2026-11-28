import { afterEach, describe, expect, it } from 'vitest'
import {
  AWAY_DEVICES_MOST,
  type AwayAnswer,
  AwayAnswerSchema,
  type AwayAsk,
  awayFor,
} from '../src/away-there.ts'
import { mintOwner } from '../src/owner.ts'
import { CSRF_HEADER } from '../src/request.ts'
import type { ServerOptions } from '../src/serving.ts'
import { ask, closeAll, type Running, start } from './harness.ts'

// This machine's away view, for a tab of another machine's AWAY VIEW panel
// (`away-there.ts`): an owner's route at this machine's own door, answering a
// look or one of three presses — and nothing else, in the shape another
// machine reads, bounded for it. What each press does here is the window's
// half (`packages/app/test/wire/web-away-there.test.ts`).

afterEach(closeAll)

const AT = '2026-11-28T09:00:00.000Z'

const ANSWER: AwayAnswer = {
  at: AT,
  listening: true,
  bind: 'loopback',
  bound: ['127.0.0.1:7654'],
  reachable: ['tade.example.com'],
  public: { name: 'tade.example.com', up: true, lines: [] },
  devices: [
    {
      id: '00112233445566aa',
      label: 'iPhone',
      from: 'outside your network',
      pairedAt: Date.parse(AT),
      live: true,
    },
  ],
  codes: [],
  code: null,
  streams: 1,
  problem: null,
  cannot: null,
}

async function owner(one: Running) {
  const port = Number(one.host.split(':')[1])
  return mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
}

function asOwner(one: Running, made: Awaited<ReturnType<typeof owner>>, body: unknown) {
  return ask(one, '/api/away', {
    method: 'POST',
    headers: {
      host: made.host,
      origin: `http://${made.host}`,
      cookie: `tade_away=${made.cookie}`,
      'content-type': 'application/json',
      [CSRF_HEADER]: made.csrf,
    },
    body: JSON.stringify(body),
  })
}

async function away(half: ServerOptions['awayThere']) {
  return start({}, { owned: { awayThere: half } })
}

describe('this machine’s away view, for another machine’s tab', () => {
  it('answers a look and each press with the device that asked, in the shape another machine reads', async () => {
    const asked: Array<{ asked: AwayAsk; device: string }> = []
    const one = await away(async (what, device) => {
      asked.push({ asked: what, device })
      return ANSWER
    })
    const made = await owner(one)
    const bodies: AwayAsk[] = [
      {},
      { press: 'code' },
      { press: 'revoke', device: '00112233445566aa' },
      { press: 'revoke all' },
    ]
    for (const body of bodies) {
      const said = await asOwner(one, made, body)
      expect(said.status, said.text).toBe(200)
      expect(AwayAnswerSchema.parse(JSON.parse(said.text))).toEqual(ANSWER)
    }
    expect(asked).toEqual(bodies.map((body) => ({ asked: body, device: made.device })))
  })

  it('takes no other shape: no other press, no extra field, no device id that is not one', async () => {
    let asked = 0
    const one = await away(async () => {
      asked++
      return ANSWER
    })
    const made = await owner(one)
    for (const body of [
      { press: 'pair' },
      { press: 'code', label: 'mine' },
      { press: 'revoke', device: '../web-devices.jsonl' },
      { press: 'revoke' },
      { look: true },
      null,
    ]) {
      const said = await asOwner(one, made, body)
      expect(said.status, JSON.stringify(body)).toBe(400)
    }
    expect(asked).toBe(0)
  })

  it('is the 404 of a path nobody wired, where the window gave no half', async () => {
    const one = await away(undefined)
    const said = await asOwner(one, await owner(one), {})
    expect(said.status).toBe(404)
  })

  it('cuts what it answers to what another machine reads, rather than refusing the whole', () => {
    const long = 'x'.repeat(5000)
    const many = Array.from({ length: AWAY_DEVICES_MOST + 6 }, (_, at) => ({
      ...(ANSWER.devices[0] as AwayAnswer['devices'][number]),
      id: `device${at}`,
      label: long,
    }))
    const cut = awayFor({ ...ANSWER, devices: many, problem: long, bound: [long] })
    expect(AwayAnswerSchema.safeParse(cut).success).toBe(true)
    // The newest are kept: a list appended to in pairing order ends with the newest.
    expect(cut.devices).toHaveLength(AWAY_DEVICES_MOST)
    expect(cut.devices.at(-1)?.id).toBe(`device${AWAY_DEVICES_MOST + 5}`)
    expect(cut.problem?.endsWith('…')).toBe(true)
  })
})

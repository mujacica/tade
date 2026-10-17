import { noSpend, type SinceHere } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { Device } from '../src/devices.ts'
import { mintOwner } from '../src/owner.ts'
import type { Reach } from '../src/reach.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import { SINCE_BACK_MOST_MS, SINCE_MOST, SinceAnswerSchema, sinceAnswerOf } from '../src/since.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// What the person missed while away (`since.ts`): the card another machine of
// theirs draws once when its link comes back, folded here, for an owner at
// this machine's own door and for nobody else.

afterEach(closeAll)

const NOW = Date.UTC(2026, 9, 17, 9, 0)
const EVERY: Reach = { device: 'd1', projects: { kind: 'every' }, granted: ['spend'] }
const item = (task: string, minute: number, said = 'its agent said so') => ({
  task,
  at: NOW - minute * 60_000,
  said,
})
const here = (over: Partial<SinceHere> = {}): SinceHere => ({
  since: NOW - 3_600_000,
  finished: [],
  documents: [],
  held: [],
  proposed: [],
  spend: noSpend(),
  ...over,
})

describe('the card', () => {
  it('carries each list newest first, cut at its bound with what was left counted', () => {
    const finished = Array.from({ length: SINCE_MOST + 3 }, (_, n) => item(`vps/t${n}`, n))
    const card = sinceAnswerOf(here({ finished }), [], EVERY)
    expect(SinceAnswerSchema.parse(card)).toEqual(card)
    expect(card.finished.rows.map((one) => one.task)).toEqual(
      finished.slice(0, SINCE_MOST).map((one) => one.task),
    )
    expect(card.finished.more).toBe(3)
    expect(card.since).toBe(new Date(NOW - 3_600_000).toISOString())
  })

  it('leaves out a project the device may not read, and money it was not granted', () => {
    const spent = { ...noSpend(), usd: 1.5, tokens: 900, hasCost: true }
    const some: Reach = { device: 'd1', projects: { kind: 'listed', names: ['vps'] }, granted: [] }
    const card = sinceAnswerOf(
      here({ finished: [item('vps/mine', 1), item('secret/theirs', 2)], spend: spent }),
      [item('secret/waits', 1, 'wants an answer')],
      some,
    )
    expect(card.finished).toEqual({
      rows: [expect.objectContaining({ task: 'vps/mine' })],
      more: 0,
    })
    expect(card.waiting).toEqual({ rows: [], more: 0 })
    expect(card.spend).toBeNull()
    expect(sinceAnswerOf(here({ spend: spent }), [], EVERY).spend).toEqual({
      usd: 1.5,
      tokens: 900,
      hasCost: true,
    })
  })

  it('has nothing to catch up on where nobody was ever counted present, and still says what waits', () => {
    const card = sinceAnswerOf(null, [item('vps/asks', 1, 'wants an answer')], EVERY)
    expect(card.since).toBeNull()
    expect(card.finished.rows).toEqual([])
    expect(card.waiting.rows.map((one) => one.task)).toEqual(['vps/asks'])
  })
})

/** A machine whose window answers the card, and the cut it was asked from. */
async function machine(now: number) {
  const cuts: number[] = []
  const one = await start(
    {},
    {
      now: () => now,
      since: async (device: Device, cut: number) => {
        cuts.push(cut)
        return sinceAnswerOf(here({ finished: [item('far/done', 5)] }), [], {
          device: device.id,
          projects: { kind: 'every' },
          granted: [],
        })
      },
    },
  )
  return { one, cuts }
}

async function owner(one: Running, now: number) {
  const port = Number(one.host.split(':')[1])
  return mintOwner(one.home, { port, label: 'mac', from: '' }, now)
}

function asOwner(one: Running, made: Awaited<ReturnType<typeof owner>>, body: unknown) {
  return ask(one, '/api/since', {
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

describe('asking what was missed', () => {
  it('answers an owner, cut at how long ago its link came back in this clock, and writes nothing', async () => {
    const now = Date.now()
    const { one, cuts } = await machine(now)
    const said = await asOwner(one, await owner(one, now), { back: 4_000 })
    expect(said.status, said.text).toBe(200)
    expect(SinceAnswerSchema.parse(JSON.parse(said.text)).finished.rows[0]?.task).toBe('far/done')
    expect(cuts).toEqual([now - 4_000])
    expect(one.told.filter((line) => line.type !== 'warning')).toEqual([])
  })

  it('refuses a phone, however much it was granted, and never asks the window', async () => {
    const now = Date.now()
    const { one, cuts } = await machine(now)
    const phone = await pair(one)
    const said = await ask(one, '/api/since', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify({ back: 0 }),
    })
    expect(said.status).toBe(403)
    expect(cuts).toEqual([])
  })

  it('reads an age and nothing else: never a moment, never one past its bound', async () => {
    const now = Date.now()
    const { one, cuts } = await machine(now)
    const made = await owner(one, now)
    for (const body of [
      { back: SINCE_BACK_MOST_MS + 1 },
      { back: -1 },
      { back: 1.5 },
      { since: new Date(now).toISOString() },
      { back: 0, device: 'other' },
      {},
      null,
    ]) {
      const said = await asOwner(one, made, body)
      expect(said.status, JSON.stringify(body)).toBe(400)
    }
    expect(cuts).toEqual([])
  })

  it('is the 404 of a path nobody wired where the window gave no way to answer', async () => {
    const one = await start()
    const said = await asOwner(one, await owner(one, Date.now()), { back: 0 })
    expect(said.status).toBe(404)
  })

  it('answers only on this machine’s own door', () => {
    expect(OWNED.find((route) => route.name === 'since')).toMatchObject({
      method: 'POST',
      path: '/api/since',
      here: true,
    })
  })
})

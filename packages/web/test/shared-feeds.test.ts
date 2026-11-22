import { afterEach, describe, expect, it } from 'vitest'
import { mintOwner } from '../src/owner.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import type { FeedsBody, FeedsShareAnswer } from '../src/shared-feeds.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// Every machine's journal on every other machine of the person's
// (`shared-feeds.ts`): the route reads an owner's body, checks it as text and
// hands it to the window, at this machine's own door and for nobody else.
// What the window does with it is `@tade/workbench`'s `feeds.ts`, tested there.

afterEach(closeAll)

const MAC = '11111111-1111-4111-8111-111111111111'
const EPOCH = { id: '0123456789abcdef', at: '2026-11-22T10:00:00.000Z' }
const H = 'a'.repeat(64)
const LINE = JSON.stringify({ seq: 1, ts: 'x', type: 'said', detail: {} })

/** A machine whose window answers a share, and what it was handed. */
async function machine() {
  const handed: { body: FeedsBody; device: string }[] = []
  const one = await start(
    {},
    {
      feeds: async (body, device): Promise<FeedsShareAnswer> => {
        handed.push({ body, device })
        return { machine: { id: MAC, name: 'vps' }, lines: [], took: [] }
      },
    },
  )
  return { one, handed }
}

async function owner(one: Running) {
  const port = Number(one.host.split(':')[1])
  return mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
}

function asOwner(one: Running, made: Awaited<ReturnType<typeof owner>>, body: unknown) {
  return ask(one, '/api/feeds/share', {
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

const fine = { from: { id: MAC, name: 'mac' }, give: [], want: [] }

describe('sharing journals', () => {
  it('hands an owner’s lines to the window with the device that sent them, and answers what it said', async () => {
    const { one, handed } = await machine()
    const made = await owner(one)
    const body = {
      ...fine,
      have: [{ machine: MAC, name: 'mac', epoch: EPOCH, seq: 1, n: 1, h: H }],
      sync: { notes: H, settings: { 'queue.holds': '0123456789abcdef' }, pinned: [] },
      give: [{ machine: MAC, name: 'mac', epoch: EPOCH, after: 0, h: H, lines: [LINE] }],
      want: [{ machine: MAC, epoch: EPOCH, after: 0, h: H }],
    }
    const said = await asOwner(one, made, body)
    expect(said.status, said.text).toBe(200)
    expect(JSON.parse(said.text)).toMatchObject({ machine: { id: MAC, name: 'vps' } })
    expect(handed).toEqual([{ body, device: made.device }])
  })

  it('refuses a phone that is not the person’s own, and never asks the window', async () => {
    const { one, handed } = await machine()
    const phone = await pair(one)
    const said = await ask(one, '/api/feeds/share', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify(fine),
    })
    expect(said.status).toBe(403)
    expect(handed).toEqual([])
  })

  it('reads ids, epochs, chain links and lines as text, and nothing else', async () => {
    const { one, handed } = await machine()
    const made = await owner(one)
    for (const body of [
      { ...fine, from: { id: 'not-an-id', name: 'mac' } },
      { ...fine, want: [{ machine: MAC, epoch: { id: '../../etc', at: '' }, after: 0, h: H }] },
      { ...fine, want: [{ machine: MAC, epoch: EPOCH, after: -1, h: H }] },
      {
        ...fine,
        give: [{ machine: MAC, name: 'mac', epoch: EPOCH, after: 0, h: 'short', lines: [] }],
      },
      {
        ...fine,
        give: [
          { machine: MAC, name: 'mac', epoch: EPOCH, after: 0, h: H, lines: [{ not: 'a line' }] },
        ],
      },
      { ...fine, also: 'more' },
      null,
    ]) {
      const said = await asOwner(one, made, body)
      expect(said.status, JSON.stringify(body)).toBe(400)
    }
    expect(handed).toEqual([])
  })

  it('is the 404 of a path nobody wired where the window gave no way to answer', async () => {
    const one = await start()
    const said = await asOwner(one, await owner(one), fine)
    expect(said.status).toBe(404)
  })

  it('answers only on this machine’s own door, and the person’s own device', () => {
    expect(OWNED.find((route) => route.name === 'share feeds')).toMatchObject({
      method: 'POST',
      path: '/api/feeds/share',
      here: true,
      theirs: true,
    })
  })
})

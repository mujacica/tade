import { afterEach, describe, expect, it } from 'vitest'
import { mintOwner } from '../src/owner.ts'
import { type RecordsAnswer, RecordsAnswerSchema, recordsFor } from '../src/records.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import type { ServerOptions } from '../src/serving.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// The records this machine's public name needs, looked at now for another
// machine of the person's (`records.ts`): an owner's read, at this machine's
// own door, never a phone's — asking the world only when an owner asks, which
// it does only while somebody there is looking — and bounded for the machine
// that reads it.

afterEach(closeAll)

const AT = '2026-10-17T12:00:00.000Z'

const RECORDS: RecordsAnswer = {
  at: AT,
  name: 'tade.example.com',
  head: 'tade.example.com, in the zone example.com, answered for by ns1.dns.example',
  lines: [
    {
      record: 'A',
      state: 'right',
      said: 'A: tade.example.com → 203.0.113.7, this machine',
      add: null,
      remove: [],
      loud: false,
    },
    {
      record: 'CAA',
      state: 'missing',
      said: 'CAA: none',
      add: 'tade.example.com. CAA 0 issue "letsencrypt.org"',
      remove: [],
      loud: false,
    },
  ],
  cannot: null,
}

async function owner(one: Running) {
  const port = Number(one.host.split(':')[1])
  return mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
}

function asOwner(one: Running, made: Awaited<ReturnType<typeof owner>>, body: unknown) {
  return ask(one, '/api/records', {
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

async function records(look: ServerOptions['records']) {
  return start({}, { owned: { records: look } })
}

describe('the records this machine’s public name needs, for an owner', () => {
  it('answers an owner, in the shape another machine reads, looking each time it is asked', async () => {
    let looked = 0
    const one = await records(async () => {
      looked++
      return RECORDS
    })
    const said = await asOwner(one, await owner(one), {})
    expect(said.status, said.text).toBe(200)
    expect(RecordsAnswerSchema.parse(JSON.parse(said.text))).toEqual(RECORDS)
    expect(looked).toBe(1)
  })

  it('refuses a phone however much it was granted, takes an empty body only, and is the 404 of a path nobody wired', async () => {
    let looked = 0
    const one = await records(async () => {
      looked++
      return RECORDS
    })
    const phone = await pair(one)
    const asPhone = await ask(one, '/api/records', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: '{}',
    })
    expect(asPhone.status).toBe(403)
    const made = await owner(one)
    for (const body of [{ name: 'evil.example' }, null, []]) {
      expect((await asOwner(one, made, body)).status).toBe(400)
    }
    // Nothing that was refused asked the world.
    expect(looked).toBe(0)
    const none = await start()
    expect((await asOwner(none, await owner(none), {})).status).toBe(404)
  })

  it('answers only on this machine’s own door', () => {
    expect(OWNED.find((route) => route.name === 'records')).toMatchObject({
      method: 'POST',
      path: '/api/records',
      here: true,
    })
  })

  it('cuts what is too long rather than sending what the other machine would refuse whole', () => {
    const long = 'x'.repeat(5000)
    const cut = recordsFor({
      ...RECORDS,
      name: long,
      head: long,
      cannot: long,
      lines: Array.from({ length: 12 }, () => ({
        ...RECORDS.lines[1]!,
        said: long,
        add: long,
        remove: Array.from({ length: 30 }, () => long),
      })),
    })
    expect(RecordsAnswerSchema.safeParse(cut).success).toBe(true)
    expect(cut.lines).toHaveLength(8)
    expect(cut.lines[0]?.said.endsWith('…')).toBe(true)
  })
})

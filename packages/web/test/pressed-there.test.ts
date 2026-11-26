import { afterEach, describe, expect, it } from 'vitest'
import { allowDevice, grantDevice } from '../src/devices.ts'
import { mintOwner } from '../src/owner.ts'
import { methodOf, PRESSES_THERE, type PressThere } from '../src/pressed-there.ts'
import { GRANTS } from '../src/reach.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import { SCOPES } from '../src/surface.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// A press on another machine's row from this door's page (`pressed-there.ts`):
// this door names the presses and maps each to that machine's tool method
// itself, so nothing a page sends becomes a method name; only the person's
// own device or an owner is answered; and the page's key is bound to the
// device before it goes in the outbox, so two devices' keys never name one act.

afterEach(closeAll)

const ON = { machine: 'laptop', key: 'press-0001' }

/** Every press, as the page sends it, and the method and parameters it must come to. */
const MAPPED: [PressThere, string, Record<string, unknown>][] = [
  [
    { ...ON, verb: 'steer', task: 'tade/fix-it', said: 'look at the test first' },
    'worker/steer',
    { task: 'tade/fix-it', message: 'look at the test first' },
  ],
  [
    { ...ON, verb: 'stop', task: 'tade/fix-it', confirm: true },
    'worker/stop',
    { task: 'tade/fix-it' },
  ],
  [
    { ...ON, verb: 'park', task: 'tade/fix-it', parked: false },
    'task/park',
    { task: 'tade/fix-it', parked: false },
  ],
  [
    { ...ON, verb: 'note', task: 'tade/fix-it', text: 'the flake is the clock' },
    'memory/remember',
    { text: 'the flake is the clock', scope: 'tade/fix-it' },
  ],
  [
    { ...ON, verb: 'queue', task: 'tade/fix-it', change: 'pause' },
    'queue/change',
    { task: 'tade/fix-it', change: 'pause' },
  ],
  [
    { ...ON, verb: 'queue project', project: 'tade', change: 'resume' },
    'queue/change',
    { project: 'tade', change: 'resume' },
  ],
]

describe('the presses this door carries to another machine', () => {
  it('maps each of the six to that machine’s method itself', () => {
    expect(MAPPED.map(([press]) => press.verb)).toEqual([...PRESSES_THERE])
    for (const [press, method, params] of MAPPED) {
      expect(methodOf(press), press.verb).toEqual({ method, params })
    }
  })
})

type Handed = { machine: string; key: string; method: string; params: Record<string, unknown> }

async function door(said: { ok: boolean; said: string } = { ok: true, said: 'steered' }) {
  const handed: Handed[] = []
  const one = await start(
    {},
    {
      owned: {
        pressThere: {
          press: async (req) => {
            handed.push(req)
            return said
          },
        },
      },
    },
  )
  return { one, handed }
}

/** A paired phone with every scope and grant: the person's own. */
async function theirs(one: Running, label = 'mine') {
  const phone = await pair(one, { label })
  await allowDevice(one.home, phone.device, SCOPES, new Date())
  await grantDevice(one.home, phone.device, GRANTS, new Date())
  return phone
}

function press(one: Running, phone: Awaited<ReturnType<typeof pair>>, body: unknown) {
  return ask(one, '/api/there/press', {
    method: 'POST',
    headers: {
      origin: one.origin,
      cookie: phone.cookie,
      'content-type': 'application/json',
      [CSRF_HEADER]: phone.csrf,
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/there/press', () => {
  it('hands the person’s own device’s press to the window as that machine’s method, its key bound to the device', async () => {
    const { one, handed } = await door()
    const phone = await theirs(one)
    for (const [body] of MAPPED) {
      const answer = await press(one, phone, body)
      expect(answer.status, answer.text).toBe(200)
      expect(JSON.parse(answer.text)).toEqual({ ok: true, said: 'steered' })
    }
    expect(handed).toEqual(
      MAPPED.map(([, method, params]) => ({
        machine: 'laptop',
        key: `${phone.device}-press-0001`,
        method,
        params,
      })),
    )
  })

  it('binds one key to each device, so two phones pressing with it are two acts', async () => {
    const { one, handed } = await door()
    const a = await theirs(one, 'a')
    const b = await theirs(one, 'b')
    const [[body]] = MAPPED as [[PressThere, string, Record<string, unknown>]]
    expect((await press(one, a, body)).status).toBe(200)
    expect((await press(one, b, body)).status).toBe(200)
    expect(handed.map((one) => one.key)).toEqual([
      `${a.device}-press-0001`,
      `${b.device}-press-0001`,
    ])
    expect(a.device).not.toBe(b.device)
  })

  it('answers what was not done as words, not as an error', async () => {
    const { one } = await door({ ok: false, said: 'laptop is closed since 14:02' })
    const phone = await theirs(one)
    const answer = await press(one, phone, MAPPED[0]?.[0])
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.text)).toEqual({ ok: false, said: 'laptop is closed since 14:02' })
  })

  it('takes an owner link as well', async () => {
    const { one, handed } = await door()
    const port = Number(one.host.split(':')[1])
    const made = await mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
    const answer = await ask(one, '/api/there/press', {
      method: 'POST',
      headers: {
        host: made.host,
        origin: `http://${made.host}`,
        cookie: `tade_away=${made.cookie}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: made.csrf,
      },
      body: JSON.stringify(MAPPED[1]?.[0]),
    })
    expect(answer.status, answer.text).toBe(200)
    expect(handed).toHaveLength(1)
    expect(handed[0]).toMatchObject({ method: 'worker/stop', key: `${made.device}-press-0001` })
  })

  it('refuses a device that is not the person’s own, and reaches nothing', async () => {
    const { one, handed } = await door()
    const ordinary = await pair(one, { label: 'a friend’s' })
    // Every scope but not every grant: not the person's own.
    await allowDevice(one.home, ordinary.device, SCOPES, new Date())
    for (const [body] of MAPPED) expect((await press(one, ordinary, body)).status).toBe(403)
    expect(handed).toEqual([])
  })

  it('refuses every body that is not one of its six presses, as text', async () => {
    const { one, handed } = await door()
    const phone = await theirs(one)
    const steer = { ...ON, verb: 'steer', task: 'tade/fix-it', said: 'go on' }
    for (const body of [
      // A method name is never taken from a page, whatever it names.
      { ...steer, method: 'terminal/open' },
      { ...ON, verb: 'terminal/open', task: 'tade/fix-it' },
      { ...ON, verb: 'answer', task: 'tade/fix-it', allow: true },
      { ...ON, verb: 'start', task: 'tade/fix-it' },
      { ...ON, verb: 'close', task: 'tade/fix-it' },
      // Each press's own fields, and nothing beside them.
      { ...steer, also: 1 },
      { ...steer, said: '   ' },
      { ...steer, said: 'x'.repeat(2_001) },
      { ...steer, task: '../../etc' },
      { ...steer, key: 'short' },
      { ...steer, key: 'has a space in it' },
      { ...steer, machine: '' },
      { ...steer, machine: '../ipax' },
      { ...ON, verb: 'stop', task: 'tade/fix-it' },
      { ...ON, verb: 'stop', task: 'tade/fix-it', confirm: false },
      { ...ON, verb: 'park', task: 'tade/fix-it', parked: 'yes' },
      { ...ON, verb: 'note', task: 'tade/fix-it', text: '' },
      { ...ON, verb: 'queue', task: 'tade/fix-it', change: 'start' },
      { ...ON, verb: 'queue project', project: '../tade', change: 'pause' },
      { ...ON, verb: 'queue project', task: 'tade/fix-it', change: 'pause' },
      [],
      null,
    ]) {
      const answer = await press(one, phone, body)
      expect(answer.status, JSON.stringify(body)).toBe(400)
    }
    expect(handed).toEqual([])
  })

  it('is the 404 of a path nobody wired, and answers only at this machine’s own door', async () => {
    const one = await start()
    const phone = await theirs(one)
    expect((await press(one, phone, MAPPED[0]?.[0])).status).toBe(404)
    expect(OWNED.find((route) => route.name === 'press there')).toMatchObject({
      path: '/api/there/press',
      method: 'POST',
      mutates: true,
      here: true,
      theirs: true,
    })
  })
})

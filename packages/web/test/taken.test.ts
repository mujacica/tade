import { afterEach, describe, expect, it } from 'vitest'
import { appendDevice } from '../src/devices.ts'
import { mintOwner } from '../src/owner.ts'
import { GRANTS } from '../src/reach.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import { mint } from '../src/sessions.ts'
import { SCOPES } from '../src/surface.ts'
import { type Take, TakeAnswerSchema, TakeSchema } from '../src/taken.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// Work another machine of the person's hands this one (`taken.ts`): an
// owner's, at this machine's own door, and never a phone's — the one route
// that makes work, so what it refuses is held here before the window is ever
// asked.

afterEach(closeAll)

const HEAD = 'b'.repeat(40)

const TAKE = {
  from: 'mac',
  was: 'tade/fix-it',
  project: 'tade',
  name: 'fix-it',
  intent: 'fix the flaky test, and say why it was flaky',
  prompt: 'Fix it.',
  context: '## What we know\n\nIt fails under load.\n',
  begins: { branch: 'tade/fix-it', head: HEAD },
}

async function machine() {
  const asked: { take: Take; device: string }[] = []
  const one = await start(
    {},
    {
      owned: {
        taking: async (take, device) => {
          asked.push({ take, device })
          return { took: true, task: `${take.project}/${take.name}`, said: 'queued', pushes: null }
        },
      },
    },
  )
  return { one, asked }
}

async function owner(one: Running) {
  const port = Number(one.host.split(':')[1])
  return mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
}

function asOwner(one: Running, made: Awaited<ReturnType<typeof owner>>, body: unknown) {
  return ask(one, '/api/take', {
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

describe('work handed to this machine', () => {
  it('hands an owner’s take to the window whole, with the device that asked', async () => {
    const { one, asked } = await machine()
    const made = await owner(one)
    const said = await asOwner(one, made, TAKE)
    expect(said.status, said.text).toBe(200)
    expect(TakeAnswerSchema.parse(JSON.parse(said.text))).toEqual({
      took: true,
      task: 'tade/fix-it',
      said: 'queued',
      pushes: null,
    })
    expect(asked).toEqual([{ take: TakeSchema.parse(TAKE), device: made.device }])
    // Nothing is made on a check: the window is asked with it said.
    expect(asked[0]?.take.check).toBe(false)
  })

  it('refuses a phone, however much it was granted, and never asks the window', async () => {
    const { one, asked } = await machine()
    const phone = await pair(one)
    const said = await ask(one, '/api/take', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify(TAKE),
    })
    expect(said.status).toBe(403)
    expect(asked).toEqual([])
  })

  it('refuses an owner a project outside what its line reads', async () => {
    const { one, asked } = await machine()
    // An owner's line as `mintOwner` writes it, narrowed by hand to another project.
    const minted = mint()
    const host = `localhost:${one.host.split(':')[1]}`
    await appendDevice(one.home, {
      kind: 'paired',
      device: minted.device,
      at: new Date().toISOString(),
      label: 'mac',
      digest: minted.digest,
      host,
      csrf: minted.csrf,
      until: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: [...SCOPES],
      projects: ['other'],
      granted: [...GRANTS],
      from: '',
      owner: true,
    })
    const said = await asOwner(
      one,
      { device: minted.device, cookie: minted.cookie, csrf: minted.csrf, host, until: 0 },
      TAKE,
    )
    expect(said.status, said.text).toBe(403)
    expect(asked).toEqual([])
  })

  it('takes nothing it could not hand git or a shell, and nothing it does not know', async () => {
    const { one, asked } = await machine()
    const made = await owner(one)
    for (const body of [
      { ...TAKE, begins: { branch: '--upload-pack=touch x', head: HEAD } },
      { ...TAKE, begins: { branch: 'a/../b', head: HEAD } },
      { ...TAKE, begins: { branch: 'tade/fix-it', head: 'HEAD' } },
      { ...TAKE, project: '../etc' },
      { ...TAKE, name: 'Fix It' },
      { ...TAKE, harness: 'claude-code' },
      { ...TAKE, context: 'x'.repeat(40_001) },
      { ...TAKE, intent: undefined },
    ]) {
      const said = await asOwner(one, made, body)
      expect([400, 413], JSON.stringify(body).slice(0, 120)).toContain(said.status)
    }
    expect(asked).toEqual([])
  })

  it('is the 404 of a path nobody wired where the window gave no way to take work', async () => {
    const one = await start()
    expect((await asOwner(one, await owner(one), TAKE)).status).toBe(404)
  })

  it('answers only on this machine’s own door', () => {
    expect(OWNED.find((route) => route.name === 'take')).toMatchObject({
      method: 'POST',
      path: '/api/take',
      here: true,
    })
  })

  it('reads another machine’s answer for its shape', () => {
    expect(TakeAnswerSchema.safeParse({ took: false, said: 'no project here' }).success).toBe(true)
    expect(
      TakeAnswerSchema.safeParse({ took: true, task: 't/x', said: 'queued', newer: 1 }).success,
    ).toBe(true)
    expect(TakeAnswerSchema.safeParse({ took: 'yes' }).success).toBe(false)
  })
})

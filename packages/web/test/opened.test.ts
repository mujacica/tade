import { afterEach, describe, expect, it } from 'vitest'
import { CLONE_URL, type Open, OpenAnswerSchema, OpenSchema } from '../src/opened.ts'
import { mintOwner } from '../src/owner.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// A project another machine of the person's moves here (`opened.ts`): an
// owner's, at this machine's own door, never a phone's — and what it is handed
// to clone from is a URL git reads as nothing but a URL.

afterEach(closeAll)

const OPEN = {
  from: 'mac',
  name: 'app',
  repository: 'github.com/acme/app',
  clone: 'git@github.com:acme/app.git',
}

async function machine() {
  const asked: { open: Open; device: string }[] = []
  const one = await start(
    {},
    {
      owned: {
        opening: async (open, device) => {
          asked.push({ open, device })
          return { opened: true, project: open.name, root: '/home/me/app', said: 'opened' }
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
  return ask(one, '/api/open', {
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

describe('a project moved to this machine', () => {
  it('hands an owner’s ask to the window whole, with the device that asked', async () => {
    const { one, asked } = await machine()
    const made = await owner(one)
    const said = await asOwner(one, made, OPEN)
    expect(said.status, said.text).toBe(200)
    expect(OpenAnswerSchema.parse(JSON.parse(said.text))).toMatchObject({ opened: true })
    expect(asked).toEqual([{ open: OpenSchema.parse(OPEN), device: made.device }])
  })

  it('refuses a phone, however much it was granted, and never asks the window', async () => {
    const { one, asked } = await machine()
    const phone = await pair(one)
    const said = await ask(one, '/api/open', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify(OPEN),
    })
    expect(said.status).toBe(403)
    expect(asked).toEqual([])
  })

  it('takes a URL git reads as a URL, and nothing it could read as an option or a transport', async () => {
    for (const ok of [
      'git@github.com:acme/app.git',
      'https://github.com/acme/app.git',
      'ssh://git@github.com/acme/app.git',
      'ssh://me@box.example.com:2222/srv/git/app.git',
    ])
      expect(CLONE_URL.test(ok), ok).toBe(true)
    for (const no of [
      '--upload-pack=touch x',
      '-u x',
      'ext::sh -c touch% x',
      'file:///etc',
      'https://user:token@github.com/acme/app.git',
      'https://github.com/acme/app.git --upload-pack=x',
      '/srv/git/app.git',
      'http://github.com/acme/app.git',
    ])
      expect(CLONE_URL.test(no), no).toBe(false)
    const { one, asked } = await machine()
    const made = await owner(one)
    for (const body of [
      { ...OPEN, clone: 'ext::sh -c touch% x' },
      { ...OPEN, name: '../etc' },
      { ...OPEN, repository: 'github.com/acme/app --x' },
      { ...OPEN, root: '/tmp/x' },
    ]) {
      expect((await asOwner(one, made, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(asked).toEqual([])
  })

  it('is the 404 of a path nobody wired where the window gave no way to open one', async () => {
    const one = await start()
    expect((await asOwner(one, await owner(one), OPEN)).status).toBe(404)
  })

  it('answers only on this machine’s own door', () => {
    expect(OWNED.find((route) => route.name === 'open')).toMatchObject({
      method: 'POST',
      path: '/api/open',
      here: true,
    })
  })
})

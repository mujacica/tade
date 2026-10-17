import { afterEach, describe, expect, it } from 'vitest'
import { mintOwner } from '../src/owner.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import type { NotesBody, NotesShareAnswer, SharedBy } from '../src/shared-notes.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// The person's notes shared with another machine of theirs (`shared-notes.ts`):
// the route reads an owner's body, checks it as text and hands it to the
// window, at this machine's own door and for nobody else. What the window does
// with it is `@tade/workbench`'s `notes-shared.ts`, tested there.

afterEach(closeAll)

const DIGEST = '0123456789abcdef'
const SUM = 'a'.repeat(64)
const NOTE = JSON.stringify({
  text: 'refunds go through the ledger',
  scope: null,
  by: 'cli',
  at: 'x',
})

/** A machine whose window answers a share, and what it was handed. */
async function machine() {
  const handed: { body: NotesBody; by: SharedBy }[] = []
  const one = await start(
    {},
    {
      notes: async (body, by): Promise<NotesShareAnswer> => {
        handed.push({ body, by })
        return { machine: 'vps', sum: SUM, lines: [], took: body.give.length, refused: 0 }
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
  return ask(one, '/api/notes/share', {
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

describe('sharing notes', () => {
  it('hands an owner’s lines to the window with who sent them, and answers what it said', async () => {
    const { one, handed } = await machine()
    const made = await owner(one)
    const body = {
      from: 'mac',
      sum: SUM,
      give: [{ line: NOTE, from: 'build-box' }],
      want: [DIGEST],
    }
    const said = await asOwner(one, made, body)
    expect(said.status, said.text).toBe(200)
    expect(JSON.parse(said.text)).toMatchObject({ machine: 'vps', took: 1 })
    expect(handed).toEqual([{ body, by: { device: made.device, from: 'mac' } }])
  })

  it('refuses a phone, however much it was granted, and never asks the window', async () => {
    const { one, handed } = await machine()
    const phone = await pair(one)
    const said = await ask(one, '/api/notes/share', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify({ from: 'phone', give: [], want: [] }),
    })
    expect(said.status).toBe(403)
    expect(handed).toEqual([])
  })

  it('reads lines as text, names a machine may be drawn by and digests, and nothing else', async () => {
    const { one, handed } = await machine()
    const made = await owner(one)
    const fine = { from: 'mac', give: [], want: [] }
    for (const body of [
      { ...fine, from: '\u001b[31mred' },
      { ...fine, from: '' },
      { ...fine, sum: 'not a sum' },
      { ...fine, give: [{ line: { text: 'an object, not a line' } }] },
      { ...fine, give: [{ line: 'x'.repeat(32_001) }] },
      { ...fine, give: [{ line: NOTE, from: 'a\nb' }] },
      { ...fine, want: ['../../etc'] },
      { ...fine, also: 'more' },
      { give: [], want: [] },
      null,
    ]) {
      const said = await asOwner(one, made, body)
      expect(said.status, JSON.stringify(body)).toBe(400)
    }
    expect(handed).toEqual([])
  })

  it('is the 404 of a path nobody wired where the window gave no way to answer', async () => {
    const one = await start()
    const said = await asOwner(one, await owner(one), { from: 'mac', give: [], want: [] })
    expect(said.status).toBe(404)
  })

  it('answers only on this machine’s own door', () => {
    expect(OWNED.find((route) => route.name === 'share notes')).toMatchObject({
      method: 'POST',
      path: '/api/notes/share',
      here: true,
    })
  })
})

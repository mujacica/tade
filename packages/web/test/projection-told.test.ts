import { afterEach, describe, expect, it } from 'vitest'
import { mintOwner } from '../src/owner.ts'
import {
  PIECES,
  Pieces,
  ProjectionAnswerSchema,
  type ProjectionTold,
  piecesOf,
} from '../src/projection-told.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// Another machine's whole projection told here in pieces
// (`projection-told.ts`): each piece under the server's own bound, put back
// together in order, a piece out of order starting that revision over, and
// only an owner — or the person's own phone — ever heard.

afterEach(closeAll)

const EPOCH = '7f3a9c21-0000-4000-8000-000000000000'

/** A projection's worth of text, with the quotes JSON is full of. */
function text(size: number): string {
  return JSON.stringify({ tasks: Array.from({ length: size }, (_, at) => ({ id: `app/t${at}` })) })
}

const whole = (body: string): ProjectionTold => ({
  kind: 'whole',
  epoch: EPOCH,
  rev: 4,
  text: body,
})

describe('a revision in pieces', () => {
  it('is put back together into exactly what was sent', () => {
    const told = whole(text(30_000))
    const pieces = piecesOf(told)
    expect(pieces.length).toBeGreaterThan(1)
    const held = new Pieces()
    const made = pieces.map((one) => held.take('mac', one))
    expect(made.slice(0, -1).every((one) => one === null)).toBe(true)
    expect(made.at(-1)).toEqual(told)
  })

  it('cuts every piece so its body is under the server’s bound', () => {
    for (const piece of piecesOf(whole(text(30_000)))) {
      expect(Buffer.byteLength(JSON.stringify(piece))).toBeLessThanOrEqual(60_000)
    }
    // Text that doubles when it is a string inside another is cut smaller.
    for (const piece of piecesOf(whole('"'.repeat(100_000)))) {
      expect(Buffer.byteLength(JSON.stringify(piece))).toBeLessThanOrEqual(60_000)
    }
  })

  it('is one piece where it fits, and an empty one is still one', () => {
    expect(piecesOf(whole('{}'))).toHaveLength(1)
    expect(new Pieces().take('mac', piecesOf(whole(''))[0] as never)).toEqual(whole(''))
  })

  it('carries a change’s revision it was made from', () => {
    const change: ProjectionTold = { kind: 'change', epoch: EPOCH, rev: 5, from: 4, text: '{}' }
    const [one] = piecesOf(change)
    expect(new Pieces().take('mac', one as never)).toEqual(change)
  })

  it('starts over on a piece out of order, or of another revision', () => {
    const pieces = piecesOf(whole(text(30_000)))
    const held = new Pieces()
    held.take('mac', pieces[0] as never)
    expect(held.take('mac', pieces[2] as never)).toBeNull()
    expect(held.arriving('mac')).toBe(false)
    held.take('mac', pieces[0] as never)
    const other = piecesOf({ ...whole(text(30_000)), rev: 9 })
    expect(held.take('mac', other[1] as never)).toBeNull()
    expect(held.arriving('mac')).toBe(false)
  })

  it('keeps each device’s pieces apart', () => {
    const pieces = piecesOf(whole(text(30_000)))
    const held = new Pieces()
    held.take('mac', pieces[0] as never)
    held.take('box', pieces[0] as never)
    for (const one of pieces.slice(1, -1)) held.take('mac', one)
    expect(held.take('mac', pieces.at(-1) as never)).not.toBeNull()
    expect(held.arriving('box')).toBe(true)
  })

  it('refuses to send more than one revision may take, rather than send it in part', () => {
    expect(() => piecesOf(whole('x'.repeat(40_000 * PIECES + 1)))).toThrow(/more than one may send/)
  })
})

/** A machine whose window keeps what it is told, and what it was handed. */
async function machine() {
  const handed: { told: ProjectionTold; device: string; label: string }[] = []
  const one = await start(
    {},
    {
      owned: {
        projectionTold: {
          pieces: new Pieces(),
          take: async (told, device, label) => {
            handed.push({ told, device, label })
            return told.kind === 'change' && told.from !== 4 ? 'gap' : 'kept'
          },
        },
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
  return ask(one, '/api/projection', {
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

const kept = (said: { text: string }) => ProjectionAnswerSchema.parse(JSON.parse(said.text)).kept

describe('the route', () => {
  it('hands an owner’s whole revision to the window once its last piece is here', async () => {
    const { one, handed } = await machine()
    const made = await owner(one)
    const told = whole(text(30_000))
    const pieces = piecesOf(told)
    const said = []
    for (const piece of pieces) said.push(kept(await asOwner(one, made, piece)))
    expect(said).toEqual([...pieces.slice(1).map(() => 'piece'), 'kept'])
    expect(handed).toEqual([{ told, device: made.device, label: 'mac' }])
  })

  it('answers gap for a change the window is not at, and for a piece that is not the next', async () => {
    const { one } = await machine()
    const made = await owner(one)
    const change: ProjectionTold = { kind: 'change', epoch: EPOCH, rev: 9, from: 8, text: '{}' }
    expect(kept(await asOwner(one, made, piecesOf(change)[0]))).toBe('gap')
    const pieces = piecesOf(whole(text(30_000)))
    expect(kept(await asOwner(one, made, pieces[1]))).toBe('gap')
  })

  it('reads every field as what it is, and nothing else', async () => {
    const { one, handed } = await machine()
    const made = await owner(one)
    const [piece] = piecesOf(whole('{}'))
    for (const body of [
      { ...piece, epoch: '../../etc' },
      { ...piece, rev: -1 },
      { ...piece, piece: PIECES },
      { ...piece, kind: 'snapshot' },
      { ...piece, text: 'x'.repeat(40_001) },
      { ...piece, also: 1 },
      null,
    ]) {
      expect((await asOwner(one, made, body)).status, JSON.stringify(body).slice(0, 80)).toBe(400)
    }
    expect(handed).toEqual([])
  })

  it('refuses a phone that is not the person’s own, and is the 404 of a path nobody wired', async () => {
    const { one, handed } = await machine()
    const phone = await pair(one)
    const said = await ask(one, '/api/projection', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify(piecesOf(whole('{}'))[0]),
    })
    expect(said.status).toBe(403)
    expect(handed).toEqual([])
    const none = await start()
    expect((await asOwner(none, await owner(none), piecesOf(whole('{}'))[0])).status).toBe(404)
    expect(OWNED.find((route) => route.name === 'projection')).toMatchObject({
      here: true,
      theirs: true,
    })
  })
})

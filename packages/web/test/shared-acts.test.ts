import { afterEach, describe, expect, it } from 'vitest'
import { mintOwner } from '../src/owner.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import type { ActBody, ActDone } from '../src/shared-acts.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// One orchestrator on every machine, acting on any of them (`shared-acts.ts`):
// an act run here, and the outbox a machine that links here asks for what this
// one wants done there. The routes read an owner's body, check it as text and
// hand it to the window, at this machine's own door and for nobody else. What
// the window does with it is `@tade/app`'s `acts.ts`, tested there.

afterEach(closeAll)

async function machine() {
  const handed: unknown[] = []
  const one = await start(
    {},
    {
      acts: {
        take: async (act, device, label): Promise<ActDone> => {
          handed.push({ act, device, label })
          return { key: act.key, ok: true, text: 'done here' }
        },
        outbox: async (answers, _device, label) => {
          handed.push({ answers, label })
          const waiting: ActBody = {
            key: 'k9',
            method: 'task/park',
            params: { task: 'a/b' },
            quoted: [],
            from: 'vps',
          }
          return { acts: [waiting] }
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

function asOwner(
  one: Running,
  made: Awaited<ReturnType<typeof owner>>,
  path: string,
  body: unknown,
) {
  return ask(one, path, {
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

const ACT = {
  key: 'k1',
  method: 'config/change',
  params: { path: 'queue.holds' },
  quoted: ['turn the holds off'],
  from: 'mac',
}

describe('acts from another machine of the person’s', () => {
  it('hands an owner’s act to the window with what its link paired as, and answers what was done', async () => {
    const { one, handed } = await machine()
    const made = await owner(one)
    const said = await asOwner(one, made, '/api/acts', ACT)
    expect(said.status, said.text).toBe(200)
    expect(JSON.parse(said.text)).toEqual({ key: 'k1', ok: true, text: 'done here' })
    expect(handed).toEqual([{ act: ACT, device: made.device, label: 'mac' }])
  })

  it('takes answers in and hands out what waits for that machine', async () => {
    const { one, handed } = await machine()
    const made = await owner(one)
    const answers = [{ key: 'k8', ok: false, text: 'no such task' }]
    const said = await asOwner(one, made, '/api/acts/outbox', { answers })
    expect(said.status, said.text).toBe(200)
    expect(JSON.parse(said.text).acts[0]).toMatchObject({ key: 'k9', method: 'task/park' })
    expect(handed).toEqual([{ answers, label: 'mac' }])
  })

  it('answers a paired phone too, and reads bodies as text', async () => {
    const { one, handed } = await machine()
    const phone = await pair(one)
    const refused = await ask(one, '/api/acts', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify(ACT),
    })
    expect(refused.status, refused.text).toBe(200)
    const made = await owner(one)
    for (const body of [
      { ...ACT, method: '../../etc' },
      { ...ACT, params: [] },
      { ...ACT, quoted: [{ not: 'a line' }] },
      { ...ACT, key: '' },
      { ...ACT, also: 1 },
      null,
    ]) {
      expect((await asOwner(one, made, '/api/acts', body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(
      (
        await asOwner(one, made, '/api/acts/outbox', {
          answers: [{ key: 'k', ok: 'yes', text: '' }],
        })
      ).status,
    ).toBe(400)
    expect(handed).toHaveLength(1)
  })

  it('is the 404 of a path nobody wired, and answers only at this machine’s own door and a paired device', async () => {
    const one = await start()
    expect((await asOwner(one, await owner(one), '/api/acts', ACT)).status).toBe(404)
    for (const name of ['acts', 'acts outbox']) {
      expect(OWNED.find((route) => route.name === name)).toMatchObject({ here: true })
    }
  })
})

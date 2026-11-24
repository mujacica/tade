import type { ConversationAsk } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { mintOwner } from '../src/owner.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import { type ConversationShareAnswer, STARTING } from '../src/shared-conversation.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// One orchestrator conversation on every machine of the person's
// (`shared-conversation.ts`): the route reads an owner's body, checks it as
// text and hands it to the heart, at this machine's own door and for nobody
// else. What the heart does with it is `@tade/harnesses-core`'s
// `conversation-share.ts` and `one-conversation.ts`, tested there.

afterEach(closeAll)

const MAC = '11111111-1111-4111-8111-111111111111'
const H = 'a'.repeat(64)
const LINE = JSON.stringify({ type: 'user', uuid: 'u' })

async function machine() {
  const handed: ConversationAsk[] = []
  const one = await start(
    {},
    {
      conversation: async (body): Promise<ConversationShareAnswer> => {
        handed.push(body)
        return {
          machine: { id: MAC, name: 'vps' },
          harness: 'claude-code',
          held: { after: 0, h: H },
          after: 0,
          lines: [],
          more: false,
          entries: 0,
        }
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
  return ask(one, '/api/conversation', {
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

const fine = { from: { id: MAC, name: 'mac' }, harness: 'claude-code' }

describe('one conversation, shared', () => {
  it('hands an owner’s entries, what it holds and its lease to the heart, and answers what it said', async () => {
    const { one, handed } = await machine()
    const body = {
      ...fine,
      give: { after: 0, h: H, lines: [LINE], piece: { text: 'ab', from: 0, done: false } },
      want: { after: 3, h: H, piece: 10 },
      lease: { op: 'take', key: 'k1' },
    }
    const said = await asOwner(one, await owner(one), body)
    expect(said.status, said.text).toBe(200)
    expect(JSON.parse(said.text)).toMatchObject({
      machine: { name: 'vps' },
      harness: 'claude-code',
    })
    expect(handed).toEqual([body])
  })

  it('refuses a phone that is not the person’s own, and never asks the heart', async () => {
    const { one, handed } = await machine()
    const phone = await pair(one)
    const said = await ask(one, '/api/conversation', {
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

  it('reads ids, counts, chain links, lines and lease words as text, and nothing else', async () => {
    const { one, handed } = await machine()
    const made = await owner(one)
    for (const body of [
      { ...fine, from: { id: 'not-an-id', name: 'mac' } },
      { ...fine, harness: '' },
      { ...fine, give: { after: -1, h: H, lines: [] } },
      { ...fine, give: { after: 0, h: 'short', lines: [] } },
      { ...fine, give: { after: 0, h: H, lines: [{ not: 'a line' }] } },
      { ...fine, give: { after: 0, h: H, lines: ['x'.repeat(48 * 1024 + 1)] } },
      { ...fine, want: { after: 0, h: H, piece: -1 } },
      { ...fine, lease: { op: 'steal', key: 'k' } },
      { ...fine, also: 'more' },
      null,
    ]) {
      const said = await asOwner(one, made, body)
      expect(said.status, JSON.stringify(body).slice(0, 200)).toBe(400)
    }
    expect(handed).toEqual([])
  })

  it('tells a machine to wait while the orchestrator here is starting, and reports nothing as trouble', async () => {
    // TADE-B: the door opens before the orchestrator is up, and an exchange
    // from another machine then was a 500 and a warning on every start.
    const one = await start({}, { conversation: async () => STARTING })
    const said = await asOwner(one, await owner(one), fine)
    expect(said.status, said.text).toBe(503)
    expect(JSON.parse(said.text)).toMatchObject({ error: 'starting', after: 5 })
    expect(one.told.filter((line) => line.type === 'warning')).toEqual([])
  })

  it('is the 404 of a path nobody wired where the heart gave no way to answer', async () => {
    const one = await start()
    const said = await asOwner(one, await owner(one), fine)
    expect(said.status).toBe(404)
  })

  it('answers only on this machine’s own door, and the person’s own device', () => {
    expect(OWNED.find((route) => route.name === 'conversation')).toMatchObject({
      method: 'POST',
      path: '/api/conversation',
      here: true,
      theirs: true,
    })
  })
})

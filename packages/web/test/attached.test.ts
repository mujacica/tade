import { afterEach, describe, expect, it } from 'vitest'
import { NO_AGENT } from '../src/attached.ts'
import { appendDevice } from '../src/devices.ts'
import { mintOwner } from '../src/owner.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// What to run on this machine to be shown one of its agents (`attached.ts`):
// the one answer that is an attach line, for an owner at this machine's own
// door and for nobody else, and nothing written down for asking.

afterEach(closeAll)

/** A machine whose window answers every task with the line it was asked for, and what it was asked. */
async function machine() {
  const asked: string[] = []
  const one = await start(
    {},
    {
      attaching: (task) => {
        asked.push(task)
        return task === 'far/gone'
          ? { command: null, why: 'its agent is not running' }
          : { command: `tmux -L tade new-session -t tade-1 ';' select-window -t ':${task}'` }
      },
    },
  )
  return { one, asked }
}

async function owner(one: Running) {
  const port = Number(one.host.split(':')[1])
  return mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
}

/** POST /api/attach as an owner minted on this machine. */
function asOwner(one: Running, made: Awaited<ReturnType<typeof owner>>, body: unknown) {
  return ask(one, '/api/attach', {
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

describe('asking what to run here to be shown an agent', () => {
  it('answers an owner with the line the window gave, and writes nothing down', async () => {
    const { one, asked } = await machine()
    const made = await owner(one)
    const said = await asOwner(one, made, { task: 'far/fix-it' })
    expect(said.status, said.text).toBe(200)
    expect(JSON.parse(said.text)).toEqual({
      command: "tmux -L tade new-session -t tade-1 ';' select-window -t ':far/fix-it'",
    })
    expect(asked).toEqual(['far/fix-it'])
    expect(one.told.filter((line) => line.type !== 'warning')).toEqual([])
  })

  it('says why where there is no line, in the window’s words', async () => {
    const { one } = await machine()
    const said = await asOwner(one, await owner(one), { task: 'far/gone' })
    expect(JSON.parse(said.text)).toEqual({ command: null, why: 'its agent is not running' })
  })

  it('refuses a phone, however much it was granted, and never asks the window', async () => {
    const { one, asked } = await machine()
    const phone = await pair(one)
    const said = await ask(one, '/api/attach', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify({ task: 'far/fix-it' }),
    })
    expect(said.status).toBe(403)
    expect(asked).toEqual([])
  })

  it('answers an owner whose lanes were taken back as for a task that is not there', async () => {
    const { one, asked } = await machine()
    const made = await owner(one)
    // The boxes in the window can take anything back from an owner; `lanes` is
    // the one a way into a lane stands on.
    await appendDevice(one.home, {
      kind: 'granted',
      device: made.device,
      at: new Date().toISOString(),
      granted: ['titles'],
    })
    const said = await asOwner(one, made, { task: 'far/fix-it' })
    expect(JSON.parse(said.text)).toEqual({ command: null, why: NO_AGENT })
    expect(asked).toEqual([])
  })

  it('reads a task id and nothing else', async () => {
    const { one, asked } = await machine()
    const made = await owner(one)
    for (const body of [{ task: '../etc' }, { task: 'far/x', lane: 'far/x/agent' }, {}, null]) {
      const said = await asOwner(one, made, body)
      expect(said.status, JSON.stringify(body)).toBe(400)
    }
    expect(asked).toEqual([])
  })

  it('is the 404 of a path nobody wired where the window gave no way to answer', async () => {
    const one = await start()
    const said = await asOwner(one, await owner(one), { task: 'far/fix-it' })
    expect(said.status).toBe(404)
  })

  it('answers only on this machine’s own door', () => {
    expect(OWNED.find((route) => route.name === 'attach')).toMatchObject({
      method: 'POST',
      path: '/api/attach',
      here: true,
    })
  })
})

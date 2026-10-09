import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { ConfigSchema, taskDir } from '@tade/core'
import { allowDevice, digestOf, writeDevices } from '@tade/web'
import { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { Live } from '../../src/live.ts'
import { type AppState, initialState } from '../../src/model.ts'
import { AWAY_CONTROLS, awayPanel } from '../../src/panels/away/state.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Away } from '../../src/wire/web.ts'

// The window's own end of acting: the only door a scope widens through, and
// one park carried out through a real listener against a real repository.
//
// **Everything here is real but the browser.** A real git repository, a real
// workbench writing a real task file, a real `node:http` listener on loopback,
// and a request made with `node:http` because `fetch` cannot set `Host`. What
// that buys is the one thing a fake cannot say: that the value a phone echoes
// back (`was`) is the value the projection put on the row, that it is compared
// against the file the workbench actually wrote, and that the line in the
// journal says a device did it.

const SECRET = 'A'.repeat(43)
const COOKIE = `tade_away=00112233445566aa.${SECRET}`

const open: Away[] = []
const shut: Workbench[] = []

afterEach(async () => {
  for (const one of open) await one.stop()
  open.length = 0
  for (const one of shut) await one.close().catch(() => {})
  shut.length = 0
})

/** A port the machine has just said is free, so nothing is guessed. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

/**
 * A window with a real workbench behind it, acting on, and nothing paired yet.
 */
async function machine(over: { acting?: boolean } = {}) {
  const repo = mkrepo()
  const home = tmp('tade-away-act-')
  writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
  const client = await Workbench.open({ home })
  shut.push(client)
  const task = await client.createTask({
    project: 'app',
    slug: 'migration',
    intent: 'the migration keeps failing',
  })

  let state: AppState = initialState()
  const news: string[] = []
  const port = await freePort()
  const config = ConfigSchema.parse({
    projects: { app: { root: repo.root } },
    surfaces: { web: { enabled: true, port, acting: over.acting ?? true } },
  })
  const wire = {
    opts: { home, config, client },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    live: null as Live | null,
    now: () => Date.now(),
    openedAt: 0,
    draw: () => {},
    note: () => {},
  } as unknown as Wiring
  const away = new Away(wire, { decided: () => {}, news: (said) => news.push(said) })
  open.push(away)
  return {
    away,
    home,
    repo,
    client,
    task: task.id,
    port,
    news,
    /** Open the panel, which is what `panel()` draws only when it is open. */
    show: () => {
      state = { ...state, panel: awayPanel() }
    },
  }
}

/**
 * Wait for one journal line, because the audit is written **beside** the
 * answer and not before it.
 *
 * A reporter that blocked a response would mean a phone waiting on a disk, and
 * the rule everywhere else in Tade is that a reporter never throws or blocks.
 * So the line lands a tick later, and a test that read the journal the
 * microsecond the answer arrived would be a test about scheduling.
 */
async function waitFor(client: Workbench, type: string): Promise<Record<string, unknown>[]> {
  for (let tries = 0; tries < 50; tries++) {
    const found = await client.events({ types: [type as 'web_did'] })
    if (found.length > 0) return found as unknown as Record<string, unknown>[]
    await new Promise((done) => setTimeout(done, 10))
  }
  return []
}

/** A device in the file, already granted whatever the test needs. */
async function paired(home: string, port: number, scopes: readonly string[]): Promise<void> {
  await writeDevices(home, [
    {
      kind: 'paired',
      device: '00112233445566aa',
      at: new Date().toISOString(),
      label: 'iPhone',
      digest: digestOf(SECRET),
      host: `127.0.0.1:${port}`,
      csrf: 'x'.repeat(43),
      until: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: ['read'],
      projects: null,
      granted: [],
      from: '127.0.0.1',
    },
  ])
  if (scopes.length > 0) await allowDevice(home, '00112233445566aa', scopes, new Date())
}

/** One act, as a browser would send it. */
function act(
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = JSON.stringify(body)
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/act/park',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          cookie: COOKIE,
          origin: `http://127.0.0.1:${port}`,
          'content-type': 'application/json',
          'x-tade-csrf': 'x'.repeat(43),
          'sec-fetch-site': 'same-origin',
          'content-length': String(Buffer.byteLength(text)),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const said = Buffer.concat(chunks).toString('utf8')
          done({
            status: res.statusCode ?? 0,
            body: said === '' ? {} : (JSON.parse(said) as Record<string, unknown>),
          })
        })
      },
    )
    req.on('error', failed)
    req.write(text)
    req.end()
  })
}

function parkedIn(home: string, task: string): boolean {
  const file = parse(readFileSync(join(taskDir(home, task), 'task.yaml'), 'utf8')) as {
    parked?: boolean
  }
  return file.parked === true
}

describe('one park, all the way through', () => {
  it('moves the task file and says a device did it', async () => {
    const one = await machine()
    await paired(one.home, one.port, ['read', 'steer'])
    await one.away.open()

    const answer = await act(one.port, {
      task: one.task,
      parked: true,
      was: 'p0',
      key: 'abcdefgh12345678',
      rev: 0,
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ did: true, rev: 'p1', said: 'set aside' })
    expect(parkedIn(one.home, one.task)).toBe(true)

    // **The provenance, in the journal.** `by` is the device and not `you`, so
    // `historyFrom` does not count it as the person's own doing — and there is
    // no `said` line anywhere, which is what keeps `namedBy` out of it.
    const changes = await one.client.events({ types: ['state_change'] })
    expect(changes.at(-1)?.detail).toMatchObject({
      state: 'parked',
      by: 'device 00112233445566aa',
    })
    expect(await one.client.events({ types: ['said'] })).toEqual([])
    const did = await waitFor(one.client, 'web_did')
    expect(did).toHaveLength(1)
    expect(did[0]?.task).toBe(one.task)
    expect(did[0]?.detail).toMatchObject({ device: '00112233445566aa', tool: 'park', why: 'done' })
  })

  it('picks it back up again, which is the same verb', async () => {
    const one = await machine()
    await paired(one.home, one.port, ['read', 'steer'])
    await one.away.open()
    await one.client.parkTask(one.task, true)

    const answer = await act(one.port, {
      task: one.task,
      parked: false,
      was: 'p1',
      key: 'abcdefgh12345678',
      rev: 0,
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ did: true, rev: 'p0' })
    expect(parkedIn(one.home, one.task)).toBe(false)
  })

  it('refuses a screen that was drawn before somebody parked it here', async () => {
    // **The stale screen, against the file.** The phone drew the row when the
    // task was not parked; somebody parked it at the keyboard since. The act
    // says what it assumed, so it is refused with what is true now and the
    // page redraws rather than undoing a decision.
    const one = await machine()
    await paired(one.home, one.port, ['read', 'steer'])
    await one.away.open()
    await one.client.parkTask(one.task, true)

    const answer = await act(one.port, {
      task: one.task,
      parked: false,
      was: 'p0',
      key: 'abcdefgh12345678',
      rev: 0,
    })
    expect(answer.status).toBe(409)
    expect(answer.body.error).toBe('gone')
    // The truth rides on the refusal, so the next frame is already consistent.
    expect(answer.body.rev).toBe('p1')
    expect(parkedIn(one.home, one.task)).toBe(true)
  })

  it('refuses a replayed request, because the state it assumed has moved', async () => {
    // The same bytes twice, with the receipts deliberately out of the way: a
    // different key, so nothing about idempotency is doing the work and the
    // state re-check is what refuses it. DECISIONS §4.6.
    const one = await machine()
    await paired(one.home, one.port, ['read', 'steer'])
    await one.away.open()
    const body = { task: one.task, parked: true, was: 'p0', key: 'abcdefgh12345678', rev: 0 }
    expect((await act(one.port, body)).status).toBe(200)
    const again = await act(one.port, { ...body, key: 'second0012345678' })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('gone')
  })

  it('answers the same key with the same answer, and parks nothing twice', async () => {
    const one = await machine()
    await paired(one.home, one.port, ['read', 'steer'])
    await one.away.open()
    const body = { task: one.task, parked: true, was: 'p0', key: 'abcdefgh12345678', rev: 0 }
    const first = await act(one.port, body)
    const again = await act(one.port, body)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    const changes = await one.client.events({ types: ['state_change'] })
    expect(changes.filter((event) => event.detail.state === 'parked')).toHaveLength(1)
  })

  it('answers `404` for a task that is not there, and writes nothing', async () => {
    const one = await machine()
    await paired(one.home, one.port, ['read', 'steer'])
    await one.away.open()
    const answer = await act(one.port, {
      task: 'app/nothing',
      parked: true,
      was: 'p0',
      key: 'abcdefgh12345678',
      rev: 0,
    })
    expect(answer.status).toBe(404)
    expect(answer.body.error).toBe('no_such')
  })

  it('answers `403` where the device was granted only reading', async () => {
    const one = await machine()
    await paired(one.home, one.port, [])
    await one.away.open()
    const answer = await act(one.port, {
      task: one.task,
      parked: true,
      was: 'p0',
      key: 'abcdefgh12345678',
      rev: 0,
    })
    expect(answer.status).toBe(403)
    expect(answer.body.error).toBe('out_of_scope')
    expect(parkedIn(one.home, one.task)).toBe(false)
  })

  it('has no acting route at all while the setting is off', async () => {
    const one = await machine({ acting: false })
    await paired(one.home, one.port, ['read', 'steer'])
    await one.away.open()
    const answer = await act(one.port, {
      task: one.task,
      parked: true,
      was: 'p0',
      key: 'abcdefgh12345678',
      rev: 0,
    })
    expect(answer.status).toBe(404)
    expect(parkedIn(one.home, one.task)).toBe(false)
  })
})

describe('work that came from outside this machine', () => {
  it('cannot be picked up again from away, because that is approving it', async () => {
    // **A proposed intake *is* a parked task** — that is the shape the queue
    // fix chose, and approving one is `parkTask(id, false)`. So a device that
    // could lift any park could approve a stranger's ticket into an agent
    // here, which is DESIGN §9.1's *accept work from an outside source* by a
    // longer route: an act with two re-checks of its own that no phase builds.
    // Until it is built, the verb does not reach it.
    const one = await machine()
    await paired(one.home, one.port, ['read', 'steer'])
    await one.away.open()
    const came = await one.client.createTask({
      project: 'app',
      slug: 'from-a-ticket',
      intent: 'intake: a ticket somebody else filed',
      by: 'intake:github',
    })
    await one.client.parkTask(came.id, true)

    const answer = await act(one.port, {
      task: came.id,
      parked: false,
      was: 'p1',
      key: 'abcdefgh12345678',
      rev: 0,
    })
    expect(answer.status).toBe(403)
    expect(answer.body.error).toBe('out_of_scope')
    expect(parkedIn(one.home, came.id)).toBe(true)
  })

  it('can still be set aside from away, because a hold is always safe', async () => {
    const one = await machine()
    await paired(one.home, one.port, ['read', 'steer'])
    await one.away.open()
    const came = await one.client.createTask({
      project: 'app',
      slug: 'from-a-ticket',
      intent: 'intake: a ticket somebody else filed',
      by: 'intake:github',
    })
    const answer = await act(one.port, {
      task: came.id,
      parked: true,
      was: 'p0',
      key: 'abcdefgh12345678',
      rev: 0,
    })
    expect(answer.status).toBe(200)
    expect(parkedIn(one.home, came.id)).toBe(true)
  })

  it('is picked up at the keyboard as it always was', async () => {
    // The local door is untouched: approving a proposal is a keypress here,
    // and a rule that had broken that would have broken intake itself.
    const one = await machine()
    const came = await one.client.createTask({
      project: 'app',
      slug: 'from-a-ticket',
      intent: 'intake: a ticket somebody else filed',
      by: 'intake:github',
    })
    await one.client.parkTask(came.id, true)
    await one.client.parkTask(came.id, false)
    expect(parkedIn(one.home, came.id)).toBe(false)
  })
})

describe('letting one device act, at the machine', () => {
  it('is a keypress here, written down, and it takes effect at once', async () => {
    const one = await machine()
    await paired(one.home, one.port, [])
    await one.away.open()
    await one.away.reread()
    const body = { task: one.task, parked: true, was: 'p0', key: 'abcdefgh12345678', rev: 0 }
    expect((await act(one.port, body)).status).toBe(403)

    // The panel's own control, by name, the way the window presses it.
    one.show()
    await grant(one.away, '00112233445566aa')
    expect(one.news.join(' ')).toContain('can act')
    const answer = await act(one.port, { ...body, key: 'second0012345678' })
    expect(answer.status).toBe(200)
    expect(parkedIn(one.home, one.task)).toBe(true)
  })

  it('takes it back the same way, and the device is read-only again', async () => {
    const one = await machine()
    await paired(one.home, one.port, ['read', 'steer'])
    await one.away.open()
    await one.away.reread()
    await grant(one.away, '00112233445566aa')
    expect(one.news.join(' ')).toContain('can no longer act')
    const answer = await act(one.port, {
      task: one.task,
      parked: true,
      was: 'p0',
      key: 'abcdefgh12345678',
      rev: 0,
    })
    expect(answer.status).toBe(403)
    expect(answer.body.error).toBe('out_of_scope')
  })

  it('never takes reading away as a side effect of either', async () => {
    const one = await machine()
    await paired(one.home, one.port, [])
    await one.away.open()
    await one.away.reread()
    one.show()
    await grant(one.away, '00112233445566aa')
    const view = one.away.panel()?.away
    expect(view?.devices[0]?.mayAct).toBe(true)
    const answer = await act(one.port, {
      task: one.task,
      parked: true,
      was: 'p0',
      key: 'abcdefgh12345678',
      rev: 0,
    })
    expect(answer.status).toBe(200)
  })

  it('refuses while the setting is off, rather than writing a grant that does nothing', async () => {
    const one = await machine({ acting: false })
    await paired(one.home, one.port, [])
    await one.away.open()
    await one.away.reread()
    one.show()
    await grant(one.away, '00112233445566aa')
    // Said on the panel where the control was pressed, never swallowed.
    expect(one.away.panel()?.away?.problem).toContain('Let a paired device act')
  })

  it('says so when there is no such device', async () => {
    const one = await machine()
    await one.away.open()
    one.show()
    await grant(one.away, 'ffffffffffffffff')
    expect(one.away.panel()?.away?.problem).toContain('not paired')
  })
})

/** Press the panel's own grant control, the way a click reaches the subject. */
async function grant(away: Away, device: string): Promise<void> {
  const submit = away.submits().away
  if (submit === undefined) throw new Error('the away panel has no submit')
  await submit(awayPanel(), `${AWAY_CONTROLS.act}${device}`)
}

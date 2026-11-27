import { afterEach, describe, expect, it } from 'vitest'
import type { Outcome, WebActing } from '../src/acting.ts'
import { appendDevice, readDevices } from '../src/devices.ts'
import { mintOwner, type Owner } from '../src/owner.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { VERBS } from '../src/verbs.ts'
import {
  type Answer,
  actingStub,
  ask,
  closeAll,
  pair,
  type Running,
  said,
  start,
} from './harness.ts'

// A machine the person paired as owner reaches everything a paired phone
// reaches here, which is everything. Amir, after ipax refused a
// Remove and a Run as account from his Mac: "there should be no difference
// between controlling ipax's agents and local ones", and "when I add a machine
// per default I have all permissions so this doesn't happen again".
//
// Asked of a real listener over a real socket, on this machine's own door with
// the owner's session as `tade web pair --owner` mints it — which every way of
// adding a machine runs there (`tade host`, `tade remote add`, the window's
// add-a-machine, the setup over ssh).

afterEach(closeAll)

const TASK = 'tade/away-action-gate'
const PROJECT = 'tade'

/** One valid body per verb, by name: `verbs.test.ts`'s, each with a key of its own. */
const BODIES: Readonly<Record<string, Record<string, unknown>>> = {
  park: { parked: true },
  answer: { approval: 'req-1', allow: true },
  steer: { said: 'try the other migration' },
  queue: { change: 'pause' },
  done: { confirm: true, summary: 'the migration runs' },
  note: { text: 'the fix is in the adapter' },
  context: { add: 'the ticket says the column is nullable' },
  intake: { confirm: true },
  stop: { confirm: true },
  reopen: {},
  close: { confirm: true },
  open: {},
  start: {},
  remove: { confirm: true },
  rename: { title: 'the migration agent' },
  model: { model: 'anthropic/claude-opus-5' },
  thinking: { level: 'high' },
  account: { account: 'work' },
  harness: { harness: 'claude-code' },
  move: { machine: 'vps', confirm: true },
}

function bodyOf(verb: string, n: number): Record<string, unknown> {
  const own = BODIES[verb]
  if (own === undefined) throw new Error(`no body written for ${verb}`)
  const target =
    VERBS.find((one) => one.name === verb)?.on === 'project'
      ? { project: PROJECT, was: 'o1.c0' }
      : { task: TASK, was: 'p0' }
  return { ...target, key: `key${String(n).padStart(13, '0')}`, rev: 0, ...own }
}

/** A window that does every verb it is asked, and remembers which. */
function windowOf(): { acting: WebActing; asked: string[] } {
  const asked: string[] = []
  const did = (verb: string) => (): Promise<Outcome> => {
    asked.push(verb)
    return Promise.resolve({ did: true, rev: 'after', said: `${verb} done` })
  }
  return {
    asked,
    acting: actingStub(Object.fromEntries(VERBS.map((verb) => [verb.name, did(verb.name)]))),
  }
}

/** The listener, acting on, with this machine's Tade's own window behind it. */
async function listening(): Promise<{ one: Running; asked: string[]; port: number }> {
  const made = windowOf()
  const one = await start({ acting: true }, { acting: made.acting })
  return { one, asked: made.asked, port: Number(one.host.split(':')[1]) }
}

/** One verb, asked by the owner's session the way another machine's link sends it. */
function actAs(one: Running, owner: Owner, verb: string, n: number): Promise<Answer> {
  return ask(one, `/api/act/${verb}`, {
    method: 'POST',
    headers: {
      host: owner.host,
      origin: `http://${owner.host}`,
      cookie: `tade_away=${owner.cookie}`,
      'content-type': 'application/json',
      [CSRF_HEADER]: owner.csrf,
    },
    body: JSON.stringify(bodyOf(verb, n)),
  })
}

/** An owner line as an older Tade wrote it: every scope and grant it knew of, which is fewer. */
async function pairedByAnOlderTade(home: string, port: number): Promise<Owner> {
  const owner = await mintOwner(home, { port, label: 'mac', from: '' }, Date.now())
  const { devices } = await readDevices(home)
  const now = devices.find((one) => one.id === owner.device)
  if (now === undefined) throw new Error('the owner was not written')
  // The same device, written again as 0.4.2 would have: the paired line
  // replaces the one before it, with the lists it had then.
  await appendDevice(home, {
    kind: 'paired',
    device: owner.device,
    at: new Date().toISOString(),
    label: 'mac',
    digest: now.digest,
    host: owner.host,
    csrf: owner.csrf,
    until: new Date(owner.until).toISOString(),
    scopes: ['read', 'answer', 'steer', 'ask'],
    projects: null,
    granted: ['titles', 'intent', 'notes'],
    from: '',
    owner: true,
  })
  return owner
}

describe('a machine the person paired as owner', () => {
  it('is paired as the person’s own, with nothing to switch on afterwards', async () => {
    const { one, port } = await listening()
    const owner = await mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
    const device = (await readDevices(one.home)).devices.find((d) => d.id === owner.device)
    expect(device).toMatchObject({ owner: true, clear: false })
  })

  it('reaches every verb a device may ask, remove and run as account included', async () => {
    const { one, asked, port } = await listening()
    const owner = await mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
    let n = 0
    for (const verb of VERBS) {
      const answer = await actAs(one, owner, verb.name, n++)
      expect(answer.status, `${verb.name}: ${answer.text}`).toBe(200)
      expect(said(answer), verb.name).toMatchObject({ did: true, said: `${verb.name} done` })
    }
    expect(asked).toEqual(VERBS.map((verb) => verb.name))
  })

  it('gets it on its next start when an older Tade paired it, without pairing again', async () => {
    const { one, asked, port } = await listening()
    const owner = await pairedByAnOlderTade(one.home, port)
    const device = (await readDevices(one.home)).devices.find((d) => d.id === owner.device)
    expect(device).toMatchObject({ owner: true, clear: false })
    for (const [n, verb] of ['remove', 'account', 'harness', 'move', 'stop'].entries()) {
      const answer = await actAs(one, owner, verb, n)
      expect(answer.status, `${verb}: ${answer.text}`).toBe(200)
    }
    expect(asked).toEqual(['remove', 'account', 'harness', 'move', 'stop'])
  })
})

describe('a device that is not the owner’s link', () => {
  it('reaches the same verbs from a paired phone, every one being the person’s own', async () => {
    const { one, asked } = await listening()
    const phone = await pair(one)
    for (const [n, verb] of ['remove', 'account', 'harness', 'move'].entries()) {
      const answer = await ask(one, `/api/act/${verb}`, {
        method: 'POST',
        headers: {
          cookie: phone.cookie,
          origin: one.origin,
          'content-type': 'application/json',
          [CSRF_HEADER]: phone.csrf,
        },
        body: JSON.stringify(bodyOf(verb, n)),
      })
      expect(answer.status, `${verb}: ${answer.text}`).toBe(200)
    }
    expect(asked).toEqual(['remove', 'account', 'harness', 'move'])
  })

  it('is never widened by the owner rule: an owner line bound to a public name is read as written', async () => {
    const { one } = await listening()
    const at = new Date().toISOString()
    await appendDevice(one.home, {
      kind: 'paired',
      device: '00112233445566aa',
      at,
      label: 'forged',
      digest: 'a'.repeat(64),
      host: 'tade.example.com',
      csrf: 'x'.repeat(43),
      until: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: ['read', 'agents'],
      projects: null,
      granted: [],
      from: '',
      owner: true,
    })
    const device = (await readDevices(one.home)).devices.find((d) => d.id === '00112233445566aa')
    expect(device).toMatchObject({ owner: false })
  })
})

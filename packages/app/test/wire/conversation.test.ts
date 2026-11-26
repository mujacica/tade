import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, machineLabel } from '@tade/core'
import {
  type ConversationFormat,
  derivedHex,
  OneConversation,
  SharedConversation,
} from '@tade/harnesses-core'
import type { Answer } from '@tade/remotes-core'
import { STARTING } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { FleetConversation } from '../../src/wire/conversation.ts'

// The heart's and the window's half of one orchestrator conversation on every
// machine (`conversation.ts`): the hub is the machine the config names, asked
// over the link the window holds; the far half is the heart's door; a hub with
// no such door says to upgrade it; and the beat takes in what another machine
// said and has it drawn. Two homes, the request through JSON as the wire
// carries it. The exchange and the gate are `@tade/harnesses-core`'s, tested there.

const TOY: ConversationFormat = {
  read(line) {
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch (err) {
      if (err instanceof SyntaxError) return { kind: 'unknown', why: 'not JSON' }
      throw err
    }
    return {
      kind: 'entry',
      id: String(entry.id),
      parent: (entry.parent as string | null) ?? null,
      at: String(entry.at),
      message: true,
      opens: entry.role === 'user',
      side: false,
      text: line,
    }
  },
  localised: (text) => text,
  copied: (text, to) => JSON.stringify({ ...JSON.parse(text), id: to.id, parent: to.parent }),
  marker: ({ id, parent, text, at }) => JSON.stringify({ role: 'user', id, parent, at, text }),
  pointer: () => null,
  header: () => null,
  idFor: (seed) => derivedHex(seed).slice(0, 12),
}

let made = 0

/** One machine: a home, its record, its gate, and the window's half over a wiring that has what it reads. */
function side(name: string, remotes: Record<string, unknown> = {}, harness = 'toy') {
  const home = tmp(`tade-fleet-conv-${name}-`)
  const record = join(home, 'record.jsonl')
  mkdirSync(home, { recursive: true })
  const id = `00000000-0000-4000-8000-${String(++made).padStart(12, '0')}`
  const said: string[] = []
  let drawn = 0
  const wire = {
    opts: {
      home,
      config: ConfigSchema.parse({ remotes }),
      client: { machine: { id }, log: { append: async () => {} } },
    },
    now: () => Date.now(),
    note: () => {},
  } as unknown as Wiring
  const fleet = new FleetConversation(wire, {
    say: (text) => said.push(text),
    later: () => {
      drawn++
    },
  })
  const place = fleet.place()
  const shared = new SharedConversation({
    home,
    me: place.me(),
    harness,
    format: TOY,
    record,
    take: async (lines) => {
      if (lines.length > 0) appendFileSync(record, `${lines.join('\n')}\n`)
    },
  })
  const one = new OneConversation({
    shared,
    hub: () => place.hub(),
    reload: async () => {},
    say: (text) => place.say(text),
    warn: (text) => said.push(`warn: ${text}`),
    took: () => place.took(),
    now: () => place.now(),
    clock: (at) => place.clock(at),
  })
  place.use(one)
  return { name, home, record, fleet, one, said, drawn: () => drawn }
}

const REMOTE = {
  ssh: 'north',
  tade: 'tade',
  device: '0123456789abcdef',
  session: '0123456789abcdef.abcdefghijklmnopqrstuvwx',
  csrf: 'abcdefghijklmnopqrstuvwx',
  host: 'localhost:7654',
}

/** The window's link to the hub, answering through the hub's own door as JSON. */
function linkTo(hub: ReturnType<typeof side>, status = 200) {
  return (name: string) => ({
    live: true,
    remote: { name } as never,
    link: {
      request: async (_name: string, path: string, body: unknown): Promise<Answer> => {
        expect(path).toBe('/api/conversation')
        if (status !== 200) return { status, body: { said: 'nothing here' } }
        const answer = await hub.fleet.web()(JSON.parse(JSON.stringify(body)))
        // As the door answers it (`@tade/web`'s `shared-conversation.ts`).
        if (answer === STARTING)
          return { status: 503, body: { error: 'starting', said: 'starting', after: 5 } }
        return { status: 200, body: JSON.parse(JSON.stringify(answer)) }
      },
    } as never,
  })
}

describe('one conversation, from the heart and the window', () => {
  it('asks the hub the config names over the window’s link, and takes in its turns on the beat', async () => {
    const vps = side('vps')
    const mac = side('mac', { vps: REMOTE })
    mac.fleet.withReach(linkTo(vps))
    appendFileSync(
      vps.record,
      `${JSON.stringify({ role: 'user', id: 'v1', parent: null, at: '2026-11-23T10:00:00.000Z', text: 'heron' })}\n`,
    )
    expect(mac.fleet.hub()).toMatchObject({ name: 'vps', up: true })
    expect(mac.fleet.oneWith()).toBeNull()
    mac.fleet.beat(false)
    await waitFor(() => mac.drawn() > 0)
    expect(mac.said).toEqual([])
    // One conversation with the hub now, so a turn there is escape's to stop from here.
    expect(mac.fleet.oneWith()).toBe('vps')
  })

  it('is not one with a hub that runs another harness, whose turns stay its own', async () => {
    const vps = side('vps', {}, 'other')
    const mac = side('mac', { vps: REMOTE })
    mac.fleet.withReach(linkTo(vps))
    // Named as the hub: its turns are this strip's until it says otherwise.
    expect(mac.fleet.sharesWith()).toBe('vps')
    await mac.one.before(true)
    expect(mac.said.join('\n')).toContain('the same harness')
    expect(mac.one.joined).toBeNull()
    expect(mac.fleet.oneWith()).toBeNull()
    // It keeps its own, so its tab comes back and nothing of it is folded in.
    expect(mac.fleet.sharesWith()).toBeNull()
    expect(vps.fleet.joinedBy(machineLabel())).toBe(false)
    await mac.one.after()
  })

  it('knows, as the hub, which machines that link here are this conversation, by the name their copy is kept under', async () => {
    const vps = side('vps')
    const mac = side('mac', { vps: REMOTE })
    mac.fleet.withReach(linkTo(vps))
    // Each side asks under this machine's own label, as a machine's window does.
    const asker = machineLabel()
    expect(vps.fleet.joinedBy(asker)).toBe(false)
    await mac.one.before(true)
    await mac.one.after()
    expect(vps.fleet.joinedBy(asker)).toBe(true)
    expect(vps.fleet.joinedBy(asker.toUpperCase())).toBe(true)
    expect(vps.fleet.joinedBy('another')).toBe(false)
    // The hub itself names no hub, so nothing of its own is folded from anywhere but its copies.
    expect(vps.fleet.sharesWith()).toBeNull()
  })

  it('keeps the lease itself where no hub is named, and its door answers a machine that links here', async () => {
    const vps = side('vps')
    expect(vps.fleet.hub()).toBeNull()
    await vps.one.before(true)
    const answer = await vps.fleet.web()({
      from: { id: '99999999-9999-4999-8999-999999999999', name: 'mac' },
      harness: 'toy',
      lease: { op: 'take', key: 'k' },
    })
    expect(answer).toMatchObject({
      lease: { granted: false, holder: { name: expect.any(String) } },
    })
    await vps.one.after()
  })

  it('says to upgrade a hub with no such door, and carries on here', async () => {
    const vps = side('vps')
    const mac = side('mac', { vps: REMOTE })
    mac.fleet.withReach(linkTo(vps, 404))
    await mac.one.before(true)
    expect(mac.said.join('\n')).toContain(
      'vps runs a Tade with no one conversation across machines: upgrade Tade there',
    )
    expect(mac.said.join('\n')).toContain('carrying on here')
    expect(mac.fleet.oneWith()).toBeNull()
    await mac.one.after()
  })

  it('waits for a hub whose orchestrator is starting, warning of nothing, and is one with it once it is up', async () => {
    // TADE-A: an exchange while the hub's orchestrator came up was a 500,
    // reported as trouble from this machine on every start of the hub.
    const vps = side('vps')
    vps.fleet.place().use('starting')
    const mac = side('mac', { vps: REMOTE })
    mac.fleet.withReach(linkTo(vps))
    await mac.one.idle(false)
    expect(mac.said).toEqual([])
    await mac.one.before(true)
    expect(mac.said).toEqual([
      "vps's orchestrator is starting: carrying on here; this conversation is merged with vps's when it is up.",
    ])
    await mac.one.after()
    expect(mac.fleet.oneWith()).toBeNull()
    vps.fleet.place().use(vps.one)
    await mac.one.idle(false)
    expect(mac.said.filter((line) => line.startsWith('warn:'))).toEqual([])
    expect(mac.fleet.oneWith()).toBe('vps')
  })

  it('tells a machine that links here to wait until the orchestrator has started, and not after', async () => {
    const asks = {
      from: { id: '99999999-9999-4999-8999-999999999999', name: 'mac' },
      harness: 'toy',
    }
    const fresh = side('fresh')
    fresh.fleet.place().use('starting')
    expect(await fresh.fleet.web()(asks)).toBe(STARTING)
    // A start that failed, or a harness that keeps no conversation: said, not waited on.
    fresh.fleet.place().use(null)
    await expect(fresh.fleet.web()(asks)).rejects.toThrow('not running on a harness')
  })

  it('refuses a machine that links here while the orchestrator is not sharing its conversation', async () => {
    const lone = side('lone')
    lone.fleet.place().use(null)
    await expect(
      lone.fleet.web()({
        from: { id: '99999999-9999-4999-8999-999999999999', name: 'mac' },
        harness: 'toy',
      }),
    ).rejects.toThrow('not running on a harness that keeps one conversation on every machine')
  })
})

describe('how the orchestrator stands, as another machine is told it', () => {
  it('is starting, then up and one with the hub it exchanged with, then what stopped it', async () => {
    const vps = side('vps')
    const mac = side('mac', { vps: REMOTE })
    mac.fleet.withReach(linkTo(vps))
    expect(mac.fleet.standing()).toEqual({
      state: 'starting',
      said: null,
      shares: true,
      joined: null,
      model: null,
    })
    mac.fleet.started()
    mac.fleet.beat(false)
    await waitFor(() => mac.fleet.oneWith() === 'vps')
    expect(mac.fleet.standing()).toMatchObject({ state: 'up', shares: true, joined: 'vps' })
    // Started again, and that start did not come up: why, in Tade's words.
    mac.fleet.place().use('starting')
    expect(mac.fleet.standing()).toMatchObject({ state: 'starting', shares: false })
    mac.fleet.place().use(null)
    mac.fleet.failed('Claude Code is not signed in here')
    expect(mac.fleet.standing()).toEqual({
      state: 'failed',
      said: 'Claude Code is not signed in here',
      shares: false,
      joined: null,
      model: null,
    })
  })
})

async function waitFor(check: () => boolean): Promise<void> {
  const end = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

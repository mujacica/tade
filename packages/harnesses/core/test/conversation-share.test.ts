import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationAsk } from '@tade/core'
import { describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type ConversationFormat, derivedHex, entriesOf } from '../src/conversation.ts'
import {
  type ConversationAnswer,
  conversationCopies,
  conversationCopyPath,
  LEASE_MS,
  RENEW_MS,
  SharedConversation,
  TurnLease,
} from '../src/conversation-share.ts'
import { type HubLink, OneConversation } from '../src/one-conversation.ts'

// Each machine's half of one conversation, two homes on one disk: the
// exchange brings each the other's entries, a line too long for one request
// goes in pieces, a partition is merged once by whoever holds the lease and
// adopted by the other, and the gate around a turn waits, refuses and carries
// on apart in words.

const TOY: ConversationFormat = {
  read(line) {
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch (err) {
      if (err instanceof SyntaxError) return { kind: 'unknown', why: 'a line that is not JSON' }
      throw err
    }
    if (entry.kind === 'cost') return { kind: 'kept' }
    if (entry.kind !== 'say')
      return { kind: 'unknown', why: `an entry of kind ${String(entry.kind)}` }
    return {
      kind: 'entry',
      id: String(entry.id),
      parent: (entry.parent as string | null) ?? null,
      at: String(entry.at),
      message: true,
      opens: entry.role === 'user',
      side: false,
      text: JSON.stringify({ ...entry, cwd: '' }),
    }
  },
  localised: (text, here) => JSON.stringify({ ...JSON.parse(text), cwd: here.cwd }),
  copied: (text, to) => JSON.stringify({ ...JSON.parse(text), id: to.id, parent: to.parent }),
  marker: ({ id, parent, text, at }) =>
    JSON.stringify({ kind: 'say', role: 'user', id, parent, at, text, cwd: '' }),
  pointer: () => null,
  header: () => null,
  idFor: (seed) => derivedHex(seed).slice(0, 12),
}

interface Machine {
  id: string
  name: string
  home: string
  record: string
  shared: SharedConversation
  leaf: string | null
}

let made = 0
function machine(name: string): Machine {
  const home = tmp(`tade-conv-${name}-`)
  const record = join(home, 'record', 'conversation.jsonl')
  mkdirSync(join(home, 'record'), { recursive: true })
  const id = `00000000-0000-4000-8000-${String(++made).padStart(12, '0')}`
  const one: Machine = {
    id,
    name,
    home,
    record,
    leaf: null,
    shared: new SharedConversation({
      home,
      me: { id, name },
      harness: 'toy',
      format: TOY,
      record,
      take: async (lines) => {
        if (lines.length === 0) return
        appendFileSync(
          record,
          `${lines.map((line) => TOY.localised(line, { cwd: `/${name}` })).join('\n')}\n`,
        )
      },
    }),
  }
  return one
}

/** One turn written on a machine: the person, then a reply, and its own bookkeeping. */
function turn(on: Machine, said: string, at: string, size = 40): void {
  const ask = `${on.name}-${said}-u`
  const reply = `${on.name}-${said}-a`
  appendFileSync(
    on.record,
    `${[
      JSON.stringify({
        kind: 'say',
        role: 'user',
        id: ask,
        parent: on.leaf,
        at,
        text: said,
        cwd: `/${on.name}`,
      }),
      JSON.stringify({ kind: 'cost', usd: 1 }),
      JSON.stringify({
        kind: 'say',
        role: 'assistant',
        id: reply,
        parent: ask,
        at,
        text: 'r'.repeat(size),
        cwd: `/${on.name}`,
      }),
    ].join('\n')}\n`,
  )
  on.leaf = reply
}

/** What one machine says, as the other's link would carry it: through JSON, as a request does. */
function via(
  to: Machine,
  lease?: TurnLease,
): (ask: ConversationAsk) => Promise<ConversationAnswer> {
  return async (ask) => {
    const parsed = JSON.parse(JSON.stringify(ask)) as ConversationAsk
    const answer = await to.shared.answer(parsed)
    const leased =
      parsed.lease && lease
        ? { lease: lease.ask(parsed.lease.op, parsed.from, parsed.lease.key, Date.now()) }
        : {}
    return JSON.parse(JSON.stringify({ ...answer, ...leased })) as ConversationAnswer
  }
}

const idsOf = (path: string) => {
  const read = entriesOf(TOY, { name: 'x', lines: readFileSync(path, 'utf8').trim().split('\n') })
  if (!read.ok) throw new Error(read.why)
  return read.entries.map((one) => one.id)
}

describe('each machine’s half of one conversation', () => {
  it('exchanges both ways until each holds the other’s, and gives nothing twice', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    turn(mac, 'heron', '2026-11-23T10:00:00.000Z')
    turn(vps, 'kestrel', '2026-11-23T10:05:00.000Z')
    const first = await mac.shared.exchange(via(vps))
    expect(first.took).toBe(2)
    expect(idsOf(conversationCopyPath(mac.home, vps.id))).toEqual(idsOf(vps.record))
    expect(idsOf(conversationCopyPath(vps.home, mac.id))).toEqual(idsOf(mac.record))
    // The bookkeeping stayed where it was written.
    expect(readFileSync(conversationCopyPath(vps.home, mac.id), 'utf8')).not.toContain('cost')
    // Nothing moved: one request to say who it is, one to find nothing to give.
    let asked = 0
    const again = await mac.shared.exchange(async (ask) => {
      asked++
      return via(vps)(ask)
    })
    expect(again.took).toBe(0)
    expect(asked).toBe(2)
  })

  it('sends a line too long for one request in pieces, both ways', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    turn(mac, 'long', '2026-11-23T10:00:00.000Z', 150_000)
    turn(vps, 'longer', '2026-11-23T10:00:00.000Z', 200_000)
    await mac.shared.exchange(via(vps))
    expect(idsOf(conversationCopyPath(vps.home, mac.id))).toEqual(idsOf(mac.record))
    expect(idsOf(conversationCopyPath(mac.home, vps.id))).toEqual(idsOf(vps.record))
    expect(readFileSync(conversationCopyPath(mac.home, vps.id), 'utf8')).toContain(
      'r'.repeat(200_000),
    )
  })

  it('stops after the rounds it was given, says it is not whole, and is whole after more', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    for (let n = 0; n < 6; n++) turn(mac, `t${n}`, '2026-11-23T10:00:00.000Z', 30_000)
    const first = await mac.shared.exchange(via(vps), undefined, 2)
    expect(first.complete).toBe(false)
    expect(idsOf(conversationCopyPath(vps.home, mac.id)).length).toBeLessThan(
      idsOf(mac.record).length,
    )
    const rest = await mac.shared.exchange(via(vps))
    expect(rest.complete).toBe(true)
    expect(idsOf(conversationCopyPath(vps.home, mac.id))).toEqual(idsOf(mac.record))
  })

  it('makes a copy’s path out of a machine id and nothing else', () => {
    const home = tmp('tade-conv-path-')
    expect(conversationCopyPath(home, '00000000-0000-4000-8000-000000000001')).toBe(
      join(home, 'machines', '00000000-0000-4000-8000-000000000001', 'conversation.jsonl'),
    )
    for (const id of ['../../etc', 'vps', '', '00000000-0000-4000-8000-00000000000/']) {
      expect(() => conversationCopyPath(home, id)).toThrow('kept only by a machine id')
    }
  })

  it('refuses a machine whose orchestrator runs on another harness, in words', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    const done = await mac.shared.exchange(async (ask) => via(vps)({ ...ask, harness: 'pi' }))
    expect(done.refused).toBe(
      'every machine has to run the orchestrator on the same harness for it to be one conversation: mac runs pi and vps runs toy, so each keeps its own until one of them is changed (orchestrator.harness)',
    )
  })

  it('merges a partition once, where the lease is held, and the other machine adopts it', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    turn(mac, 'heron', '2026-11-23T10:00:00.000Z')
    await mac.shared.exchange(via(vps))
    expect(await vps.shared.settle(true)).toEqual([{ from: 'mac', took: 2, merged: null }])
    vps.leaf = mac.leaf
    // Apart: each carries on.
    turn(mac, 'wren', '2026-11-23T11:00:00.000Z')
    turn(vps, 'kestrel', '2026-11-23T12:00:00.000Z')
    await mac.shared.exchange(via(vps))
    // Without the lease nothing forked is merged.
    expect(await mac.shared.settle(false)).toEqual([{ from: 'vps', took: 0 }])
    const merged = await mac.shared.settle(true)
    expect(merged[0]).toMatchObject({ from: 'vps', merged: { trunk: 'mac', other: 'vps' } })
    // The vps takes the merge as it is: adopted, no marker of its own.
    await mac.shared.exchange(via(vps))
    expect(await vps.shared.settle(true)).toMatchObject([{ from: 'mac', merged: null }])
    expect(new Set(idsOf(vps.record))).toEqual(new Set(idsOf(mac.record)))
    for (const record of [mac.record, vps.record]) {
      expect(readFileSync(record, 'utf8').match(/\[Tade\] While/g)).toHaveLength(1)
    }
    // And again: nothing left to take on either side.
    await mac.shared.exchange(via(vps))
    expect(await mac.shared.settle(true)).toEqual([{ from: 'vps', took: 0 }])
    expect(await vps.shared.settle(true)).toEqual([{ from: 'mac', took: 0 }])
  })

  it('stops at a line nobody knows, and keeps the copy as it was', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    turn(vps, 'heron', '2026-11-23T10:00:00.000Z')
    appendFileSync(vps.record, `${JSON.stringify({ kind: 'telepathy', id: 'z' })}\n`)
    await mac.shared.exchange(via(vps))
    // The Mac takes what it knows of the vps's: the strange line never travelled.
    expect(await mac.shared.settle(true)).toEqual([{ from: 'vps', took: 2, merged: null }])
    // The vps's own record holds it, and it says so rather than taking anything in.
    turn(mac, 'wren', '2026-11-23T11:00:00.000Z')
    await mac.shared.exchange(via(vps))
    const before = readFileSync(vps.record, 'utf8')
    const refused = await vps.shared.settle(true)
    expect(refused[0]).toMatchObject({ from: 'mac', took: 0 })
    expect((refused[0] as { refused?: string }).refused).toContain('an entry of kind telepathy')
    expect(readFileSync(vps.record, 'utf8')).toBe(before)
  })
})

describe('the turn lease the hub keeps', () => {
  const mac = { id: 'm', name: 'mac' }
  const vps = { id: 'v', name: 'vps' }

  it('is one machine’s at a time, renewed by its holder, and runs out by itself', () => {
    const lease = new TurnLease()
    expect(lease.ask('take', mac, 'k1', 0)).toEqual({ granted: true })
    expect(lease.ask('take', vps, 'k2', 1_000)).toEqual({
      granted: false,
      holder: { name: 'mac', since: 0 },
    })
    expect(lease.ask('look', vps, 'k2', 1_000)).toEqual({
      granted: false,
      holder: { name: 'mac', since: 0 },
    })
    expect(lease.ask('renew', mac, 'k1', LEASE_MS - 1)).toEqual({ granted: true })
    expect(lease.ask('take', vps, 'k2', LEASE_MS + 1)).toMatchObject({ granted: false })
    // Not renewed again: it runs out, and the next asker has it.
    expect(lease.ask('take', vps, 'k2', 2 * LEASE_MS)).toEqual({ granted: true })
    // Letting go of one that is not yours lets go of nothing.
    lease.ask('release', mac, 'k1', 2 * LEASE_MS)
    expect(lease.holder(2 * LEASE_MS)).toMatchObject({ name: 'vps' })
    lease.ask('release', vps, 'k2', 2 * LEASE_MS)
    expect(lease.holder(2 * LEASE_MS)).toBeNull()
  })
})

describe('the gate around a turn', () => {
  function gate(on: Machine, hub: () => HubLink | null) {
    const said: string[] = []
    let reloads = 0
    const one = new OneConversation({
      shared: on.shared,
      hub,
      reload: async () => {
        reloads++
      },
      say: (text) => said.push(text),
      warn: (text) => said.push(`warn: ${text}`),
      now: () => Date.now(),
      clock: () => '14:02',
      pause: async () => {},
    })
    return { one, said, reloads: () => reloads }
  }

  it('takes the hub’s lease, waits while another machine’s turn holds it, and refuses a phone rather than make it wait', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    const hubSide = gate(vps, () => null)
    const link: HubLink = {
      name: 'vps',
      up: true,
      downSince: null,
      send: (ask) => hubSide.one.answer(ask),
    }
    const macSide = gate(mac, () => link)
    // The hub's own turn holds the lease.
    await hubSide.one.before(true)
    await expect(macSide.one.before(false)).rejects.toThrow(
      'vps is answering (since 14:02): this conversation takes one turn at a time across the machines, so say it again once it is done',
    )
    // Waiting: it goes after the hub's turn.
    const waiting = macSide.one.before(true)
    // Paced by the line itself, never a sleep.
    await vi.waitFor(() =>
      expect(macSide.said.some((line) => line.startsWith('Waiting: vps is answering'))).toBe(true),
    )
    turn(vps, 'kestrel', '2026-11-23T12:00:00.000Z')
    await hubSide.one.after()
    await waiting
    expect(macSide.one.leased).toBe(true)
    // What the hub's turn said is the Mac's now, and its harness reads it again.
    expect(idsOf(mac.record)).toEqual(idsOf(vps.record))
    expect(macSide.reloads()).toBe(1)
    // The Mac's turn, and then the hub has it.
    mac.leaf = vps.leaf
    turn(mac, 'heron', '2026-11-23T12:10:00.000Z')
    await macSide.one.after()
    expect(hubSide.one.lease.holder(Date.now())).toBeNull()
    await hubSide.one.before(true)
    expect(idsOf(vps.record)).toEqual(idsOf(mac.record))
    await hubSide.one.after()
  })

  it('carries on apart while the hub cannot be reached, says so once, and merges when it is back', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    const hubSide = gate(vps, () => null)
    let up = false
    const link = (): HubLink => ({
      name: 'vps',
      up,
      downSince: 0,
      send: (ask) => hubSide.one.answer(ask),
    })
    const macSide = gate(mac, link)
    await macSide.one.before(true)
    turn(mac, 'wren', '2026-11-23T11:00:00.000Z')
    await macSide.one.after()
    await macSide.one.before(true)
    await macSide.one.after()
    expect(macSide.said.filter((line) => line.includes('carrying on here'))).toEqual([
      'vps not linked since 14:02: carrying on here; this conversation is merged with vps’s when it is back.'.replace(
        '’',
        "'",
      ),
    ])
    await hubSide.one.before(true)
    turn(vps, 'kestrel', '2026-11-23T12:00:00.000Z')
    await hubSide.one.after()
    up = true
    await macSide.one.before(true)
    expect(macSide.said.some((line) => line.includes('vps is linked again'))).toBe(true)
    expect(
      macSide.said.some((line) => line.startsWith('While mac and vps could not reach each other')),
    ).toBe(true)
    await macSide.one.after()
    // The hub takes the merge in between turns, as every screen would show it.
    await hubSide.one.idle(false)
    expect(new Set(idsOf(vps.record))).toEqual(new Set(idsOf(mac.record)))
  })
})

describe('what goes wrong around a turn, said rather than lost', () => {
  function gated(on: Machine, hub: () => HubLink | null) {
    const said: string[] = []
    const one = new OneConversation({
      shared: on.shared,
      hub,
      reload: async () => {},
      say: (text) => said.push(text),
      warn: (text) => said.push(`warn: ${text}`),
      now: () => Date.now(),
      clock: () => '14:02',
      pause: async () => {},
    })
    return { one, said }
  }

  it('carries on here when the link goes in the middle of an exchange, and writes down why', async () => {
    const mac = machine('mac')
    const link: HubLink = {
      name: 'vps',
      up: true,
      downSince: null,
      send: async () => {
        throw new Error('the connection to vps closed')
      },
    }
    const { one, said } = gated(mac, () => link)
    await one.before(true)
    expect(said).toContain(
      'warn: the conversation could not be exchanged with vps: the connection to vps closed',
    )
    expect(said.some((line) => line.includes('carrying on here'))).toBe(true)
    // What the turn said could not be given back either: written down, and given next time.
    await one.after()
    expect(said).toContain(
      'warn: what this turn said could not be given to vps yet: the connection to vps closed',
    )
  })

  it('runs a turn on what is here while a first copy is still crossing, and merges nothing meanwhile', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    for (let n = 0; n < 70; n++) turn(mac, `t${n}`, '2026-11-23T10:00:00.000Z', 45_000)
    const hub = gated(vps, () => null)
    const { one, said } = gated(mac, () => ({
      name: 'vps',
      up: true,
      downSince: null,
      send: (ask) => hub.one.answer(ask),
    }))
    await one.before(true)
    expect(said).toContain(
      'The conversation is still being copied to and from vps: this turn runs on what is here, and what went apart is merged once the copy is whole.',
    )
    expect(one.leased).toBe(true)
    await one.after()
  })

  it('refuses a phone on the hub while a machine that links to it holds the lease', async () => {
    const vps = machine('vps')
    const { one } = gated(vps, () => null)
    await one.answer({
      from: { id: '99999999-9999-4999-8999-999999999999', name: 'mac' },
      harness: 'toy',
      lease: { op: 'take', key: 'k' },
    })
    await expect(one.before(false)).rejects.toThrow(
      'mac is answering (since 14:02): this conversation takes one turn at a time across the machines',
    )
    expect(one.leased).toBe(false)
  })

  it('renews the lease once a tick while a turn runs, never while the link is down, and writes down one that failed', async () => {
    // Paced by the interval itself, never by the clock: setInterval is faked,
    // so each `tick` fires the renewal exactly once, and what is counted is
    // renewals per tick — no stretch of real time is ever measured.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const mac = machine('mac')
      const vps = machine('vps')
      const hub = gated(vps, () => null)
      const renewals: string[] = []
      let failing = false
      let up = true
      const link = (): HubLink => ({
        name: 'vps',
        up,
        downSince: null,
        send: async (ask) => {
          if (ask.lease?.op === 'renew') {
            renewals.push(failing ? 'failed' : 'renewed')
            if (failing) throw new Error('vps did not answer')
          }
          return hub.one.answer(ask)
        },
      })
      const tick = () => vi.advanceTimersByTime(RENEW_MS)
      const { one, said } = gated(mac, link)
      await one.before(true)
      tick()
      expect(renewals).toEqual(['renewed'])
      failing = true
      tick()
      expect(renewals).toEqual(['renewed', 'failed'])
      await vi.waitFor(() =>
        expect(said).toContain(
          'warn: the turn lease at vps could not be renewed: vps did not answer',
        ),
      )
      // Down for three ticks: nothing asked of a hub it cannot reach.
      up = false
      tick()
      tick()
      tick()
      expect(renewals).toEqual(['renewed', 'failed'])
      // Back: the next tick renews again.
      up = true
      failing = false
      tick()
      expect(renewals).toEqual(['renewed', 'failed', 'renewed'])
      await one.after()
      expect(hub.one.lease.holder(Date.now())).toBeNull()
      // And none once the turn is over.
      tick()
      expect(renewals).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says once that the conversation is not one across the machines while its record holds a line nobody knows', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    turn(vps, 'kestrel', '2026-11-23T10:00:00.000Z')
    await mac.shared.exchange(via(vps))
    appendFileSync(mac.record, `${JSON.stringify({ kind: 'telepathy', id: 'z' })}\n`)
    const { one, said } = gated(mac, () => null)
    await one.before(true)
    await one.after()
    await one.before(true)
    await one.after()
    const refused = said.filter((line) => line.startsWith('The conversation is not one'))
    expect(refused).toHaveLength(1)
    expect(refused[0]).toContain('an entry of kind telepathy')
  })

  it('looks oftener while another machine’s turn holds the lease, and leaves a hub that is down alone', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    const hub = gated(vps, () => null)
    let up = true
    const { one, said } = gated(mac, () => ({
      name: 'vps',
      up,
      downSince: null,
      send: (ask) => hub.one.answer(ask),
    }))
    await hub.one.before(true)
    await one.idle(false)
    expect(one.othersTurn).toBe(true)
    await hub.one.after()
    await one.idle(false)
    expect(one.othersTurn).toBe(false)
    // Down: nothing asked, nothing said.
    up = false
    await one.idle(false)
    // Nothing between turns while a turn is going.
    await one.idle(true)
    expect(said).toEqual([])
    // Taking in what came fails: written down, never thrown at the beat.
    up = true
    turn(vps, 'kestrel', '2026-11-23T10:00:00.000Z')
    const broken = gated(
      {
        ...mac,
        shared: Object.assign(Object.create(mac.shared), {
          settle: async () => Promise.reject(new Error('disk full')),
        }),
      },
      () => ({ name: 'vps', up: true, downSince: null, send: (ask) => hub.one.answer(ask) }),
    )
    await broken.one.idle(false)
    expect(broken.said).toContain('warn: the conversation could not be taken in: disk full')
  })
})

describe('a home that restarts, and lines given out of step', () => {
  it('takes up the copies it keeps, by the names they were kept under', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    turn(mac, 'heron', '2026-11-23T10:00:00.000Z')
    await mac.shared.exchange(via(vps))
    // The hub starts again: a new half over the same home and record.
    const again = new SharedConversation({
      home: vps.home,
      me: { id: vps.id, name: 'vps' },
      harness: 'toy',
      format: TOY,
      record: vps.record,
      take: async (lines) => {
        if (lines.length > 0) appendFileSync(vps.record, `${lines.join('\n')}\n`)
      },
    })
    const kept = await conversationCopies(vps.home)
    expect(kept).toEqual([{ id: mac.id, name: 'mac' }])
    // Its own id, and a folder a remote's name keeps, are not copies to take up.
    mkdirSync(join(vps.home, 'machines', 'vps-by-name'), { recursive: true })
    await again.known([...(await conversationCopies(vps.home)), { id: vps.id, name: 'vps' }])
    expect(await again.settle(false)).toEqual([{ from: 'mac', took: 2, merged: null }])
    expect(await conversationCopies(tmp('tade-conv-empty-'))).toEqual([])
  })

  it('takes nothing given after a place it does not hold, and says where it stands instead', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    const from = { id: mac.id, name: 'mac' }
    const line = JSON.stringify({
      kind: 'say',
      role: 'user',
      id: 'x',
      parent: null,
      at: 'a',
      text: 'hi',
      cwd: '',
    })
    const answer = await vps.shared.answer({
      from,
      harness: 'toy',
      give: { after: 5, h: 'a'.repeat(64), lines: [line] },
    })
    expect(answer.held).toMatchObject({ after: 0 })
    expect(answer.refused).toBeUndefined()
    expect(answer.lines).toEqual([])
  })

  it('drops a piece out of step and starts the line again from its first piece', async () => {
    const vps = machine('vps')
    const from = { id: '33333333-3333-4333-8333-333333333333', name: 'mac' }
    const start = '0'.repeat(64)
    const line = JSON.stringify({
      kind: 'say',
      role: 'user',
      id: 'long',
      parent: null,
      at: 'a',
      text: 'y'.repeat(100),
      cwd: '',
    })
    const give = (text: string, at: number, done: boolean) =>
      vps.shared.answer({
        from,
        harness: 'toy',
        give: { after: 0, h: start, lines: [], piece: { text, from: at, done } },
      })
    await give(line.slice(0, 40), 0, false)
    // Out of step: what was held is dropped, and the giver is told to start the line again.
    expect((await give(line.slice(60), 60, true)).held).toEqual({ after: 0, h: start })
    // Begun again from its first piece, and finished.
    await give(line.slice(0, 50), 0, false)
    expect((await give(line.slice(50), 50, false)).held).toMatchObject({ piece: line.length })
    const done = await give('', line.length, true)
    expect(done.held.after).toBe(1)
  })

  it('refuses a line that is not an entry of the conversation, and keeps the copy as it was', async () => {
    const vps = machine('vps')
    const from = { id: '44444444-4444-4444-8444-444444444444', name: 'mac' }
    const answer = await vps.shared.answer({
      from,
      harness: 'toy',
      give: { after: 0, h: '0'.repeat(64), lines: [JSON.stringify({ kind: 'cost', usd: 1 })] },
    })
    expect(answer.refused).toBe(
      'a line from mac is not an entry of the conversation Tade knows (the harness’s own bookkeeping), so its copy here stays as it was',
    )
    expect(answer.held.after).toBe(0)
  })
})

describe('the rest of what the gate and the copies say', () => {
  function gated(on: Machine, hub: () => HubLink | null) {
    const said: string[] = []
    const one = new OneConversation({
      shared: on.shared,
      hub,
      reload: async () => {},
      say: (text) => said.push(text),
      warn: (text) => said.push(`warn: ${text}`),
      now: () => Date.now(),
      clock: () => '14:02',
      pause: async () => {},
    })
    return { one, said }
  }

  it('says once that a hub on another harness keeps its own conversation, and runs the turn here', async () => {
    const mac = machine('mac')
    const vps = machine('vps')
    const hub = gated(vps, () => null)
    const link: HubLink = {
      name: 'vps',
      up: true,
      downSince: null,
      send: (ask) => hub.one.answer({ ...ask, harness: 'pi' }),
    }
    const { one, said } = gated(mac, () => link)
    await one.before(true)
    await one.after()
    await one.before(true)
    await one.after()
    expect(said.filter((line) => line.includes('the same harness'))).toHaveLength(1)
    // The beat says nothing new about it either.
    await one.idle(false)
    expect(said.filter((line) => line.includes('the same harness'))).toHaveLength(1)
  })

  it('waits on the hub for a machine that links to it, and says so once', async () => {
    const vps = machine('vps')
    const { one, said } = gated(vps, () => null)
    const mac = { id: '55555555-5555-4555-8555-555555555555', name: 'mac' }
    await one.answer({ from: mac, harness: 'toy', lease: { op: 'take', key: 'k' } })
    const waiting = one.before(true)
    await vi.waitFor(() =>
      expect(said).toContain(
        'Waiting: mac is answering (since 14:02), and this goes after its turn.',
      ),
    )
    await one.answer({ from: mac, harness: 'toy', lease: { op: 'release', key: 'k' } })
    await waiting
    expect(one.leased).toBe(true)
    await one.after()
  })

  it('writes down an exchange on the beat that failed, and throws nothing at it', async () => {
    const mac = machine('mac')
    const { one, said } = gated(mac, () => ({
      name: 'vps',
      up: true,
      downSince: null,
      send: async () => {
        throw new Error('vps hung up')
      },
    }))
    await one.idle(false)
    expect(said).toEqual(['warn: the conversation could not be exchanged with vps: vps hung up'])
  })

  it('starts a copy over from line one where it is given from the start again', async () => {
    const vps = machine('vps')
    const from = { id: '66666666-6666-4666-8666-666666666666', name: 'mac' }
    const say = (id: string) =>
      JSON.stringify({ kind: 'say', role: 'user', id, parent: null, at: 'a', text: id, cwd: '' })
    const start = '0'.repeat(64)
    await vps.shared.answer({
      from,
      harness: 'toy',
      give: { after: 0, h: start, lines: [say('a'), say('b')] },
    })
    const again = await vps.shared.answer({
      from,
      harness: 'toy',
      give: { after: 0, h: start, lines: [say('c')] },
    })
    expect(again.held.after).toBe(1)
    expect(idsOf(conversationCopyPath(vps.home, from.id))).toEqual(['c'])
  })

  it('reads the same entry twice in one record as one', () => {
    const line = JSON.stringify({
      kind: 'say',
      role: 'user',
      id: 'twice',
      parent: null,
      at: 'a',
      text: 'x',
      cwd: '',
    })
    const read = entriesOf(TOY, { name: 'mac', lines: [line, line] })
    expect(read.ok && read.entries.map((one) => one.id)).toEqual(['twice'])
  })
})

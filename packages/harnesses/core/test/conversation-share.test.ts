import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationAsk } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type ConversationFormat, derivedHex, entriesOf } from '../src/conversation.ts'
import {
  type ConversationAnswer,
  conversationCopyPath,
  LEASE_MS,
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
    [
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
    ].join('\n') + '\n',
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
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(macSide.said.some((line) => line.startsWith('Waiting: vps is answering'))).toBe(true)
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

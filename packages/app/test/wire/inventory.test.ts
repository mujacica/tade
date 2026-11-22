import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ConfigSchema,
  type EventFilter,
  type Inventory,
  type InventoryItem,
  type TadeEvent,
} from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type AppState, initialState } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Inventories, type InventoryThere } from '../../src/wire/inventory.ts'

// What this machine has, as the window holds it (`inventory.ts`): looked at,
// written to the journal an item at a time as set or missing and never again
// for the same, a sign-in running out on another machine written and said
// once, what a machine that links here told it kept in this home, and the
// orchestrator's move refused until the person's own words ask for it.

const NOW = Date.parse('2026-11-22T12:00:00.000Z')
const DAY = 86_400_000

/** The window as the subject reaches it: a home, a journal, a clock, and what it says. */
function wired(said: string[] = []) {
  const home = tmp('tade-inventory-home-')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.yaml'), '')
  const journal: TadeEvent[] = []
  let state: AppState = initialState()
  const wire = {
    now: () => NOW,
    draw: () => {},
    put: (next: AppState) => {
      state = next
    },
    get state() {
      return state
    },
    live: null,
    opts: {
      home,
      config: ConfigSchema.parse({}),
      extensions: undefined,
      client: {
        accounts: async () => [],
        events: async (filter: EventFilter) => [
          ...journal.filter(
            (one) => filter.types === undefined || filter.types.includes(one.type as never),
          ),
          ...(filter.types?.includes('said' as never)
            ? said.map((text, seq) => line(seq, 'said', { text }))
            : []),
        ],
        log: {
          append: async (input: { type: string; detail: Record<string, unknown> }) => {
            journal.push(line(journal.length, input.type, input.detail))
          },
        },
      },
    },
  } as unknown as Wiring
  return { wire, journal, home, notices: () => state.transcript }
}

function line(seq: number, type: string, detail: Record<string, unknown>): TadeEvent {
  return {
    seq,
    ts: new Date(NOW).toISOString(),
    type,
    urgency: 'routine',
    task: null,
    lane: null,
    run: null,
    detail,
  } as TadeEvent
}

function item(fields: Partial<InventoryItem> & Pick<InventoryItem, 'id'>): InventoryItem {
  return {
    kind: 'sign-in',
    label: fields.id,
    state: 'set',
    digest: null,
    until: null,
    where: [],
    said: null,
    variables: [],
    service: null,
    ...fields,
  }
}

describe('what this machine has, as the window holds it', () => {
  it('looks, writes each item set or missing once, and writes nothing again for a look that found the same', async () => {
    const { wire, journal } = wired()
    const inventories = new Inventories(wire, { news: () => {} })
    const first = await inventories.look()
    expect(first?.items.length).toBeGreaterThan(0)
    const lines = journal.filter((one) => one.type === 'inventory_changed')
    expect(lines.length).toBeGreaterThan(0)
    for (const one of lines) expect(Object.keys(one.detail).sort()).toEqual(['item', 'now'])
    await inventories.look()
    expect(journal.filter((one) => one.type === 'inventory_changed')).toHaveLength(lines.length)
    expect(inventories.latest()).not.toBeNull()
  })

  it('finds a sign-in running out on another machine, and writes and says it once', async () => {
    const { wire, journal } = wired()
    const told: string[] = []
    const vps: Inventory = {
      machine: 'vps',
      at: new Date(NOW).toISOString(),
      shell: 'bash',
      service: true,
      items: [item({ id: 'sign-in:claude-code', label: 'claude-code', until: NOW + 2 * DAY + 1 })],
    }
    const there: InventoryThere[] = [{ name: 'vps', inventory: vps, at: NOW, said: null }]
    const inventories = new Inventories(wire, {
      news: (said) => told.push(said),
      remotes: () => there,
    })
    await inventories.look()
    await inventories.look(true)
    const found = journal.filter((one) => one.type === 'machine_finding')
    expect(found).toHaveLength(1)
    expect(found[0]?.detail).toMatchObject({
      kind: 'expiry',
      machine: 'vps',
      item: 'sign-in:claude-code',
    })
    expect(told).toEqual([
      'claude-code on vps runs out in 2 days, on 2026-11-24: sign in there again before then',
    ])
  })

  it('keeps what a machine that links here told it, as a column of its own', async () => {
    const { wire, home } = wired()
    const inventories = new Inventories(wire, { news: () => {} })
    const mac: Inventory = {
      machine: 'Amirs-Mac.local',
      at: new Date(NOW).toISOString(),
      shell: 'zsh',
      service: false,
      items: [],
    }
    expect(await inventories.heard(mac, 'device-1')).toBe(true)
    expect(inventories.columns().map((one) => one.machine)).toContain('amirs-mac-local')
    const { readInventory, keptInventoryPath } = await import('@tade/workbench/inventory')
    expect(
      (await readInventory(keptInventoryPath(home, 'amirs-mac-local') ?? ''))?.inventory,
    ).toEqual(mac)
  })

  it('refuses the orchestrator a move until the person’s own words ask for one, and says what it would do first', async () => {
    const { wire } = wired(['how are the agents doing'])
    const tools = new Inventories(wire, { news: () => {} }).tools()
    const plan = JSON.parse(await tools.move({ said: '', move: false })) as { diff: string[] }
    expect(Array.isArray(plan.diff)).toBe(true)
    await expect(tools.move({ said: '', move: true })).rejects.toThrow('pass what they said')
    await expect(tools.move({ said: 'move my keys', move: true })).rejects.toThrow(
      'Nothing they have said asks for their keys to be moved',
    )
    const read = JSON.parse(await tools.read()) as { machines: { machine: string }[] }
    expect(read.machines).toHaveLength(1)
  })
})

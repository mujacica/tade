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
import { machinesFrom } from '../../src/wire/web-machines.ts'

// What this machine has, as the window holds it (`inventory.ts`): looked at,
// written to the journal an item at a time as set or missing and never again
// for the same, a sign-in running out on another machine written and said
// once, what a machine that links here told it kept in this home, and the
// orchestrator's move refused until the person's own words ask for it.

const NOW = Date.parse('2026-11-22T12:00:00.000Z')
const DAY = 86_400_000
/** This machine's id, and two others' (`machine.json`). */
const HERE_ID = '00000000-0000-4000-8000-000000000001'
const IPAX_ID = '00000000-0000-4000-8000-000000000002'
const OTHER_ID = '00000000-0000-4000-8000-000000000003'

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
        machine: { id: HERE_ID, epoch: { id: 'epoch-1', at: new Date(NOW).toISOString() } },
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
    expect(inventories.latest()?.id).toBe(HERE_ID)
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

  it('draws where a machine that links here stands under its column, though the column is its folder name', async () => {
    const { wire } = wired()
    const label = 'Build_Box.example-company-lab'
    const inventories = new Inventories(wire, {
      news: () => {},
      synced: () => [
        { id: OTHER_ID, said: 'behind by 9 lines' },
        { id: IPAX_ID, said: 'in step' },
      ],
    })
    const box: Inventory = {
      machine: label,
      id: IPAX_ID,
      at: new Date(NOW).toISOString(),
      shell: 'bash',
      service: true,
      items: [],
    }
    expect(await inventories.heard(box, 'device-1')).toBe(true)
    await inventories.look()
    const column = inventories.shown()?.columns.find((one) => !one.here)
    expect(column?.machine).toBe('build-box-example-compan')
    expect(column?.synced).toBe('in step')
  })

  for (const said of ['in step', 'behind by 3 lines', '1 conflict']) {
    it(`draws ${said} under a machine linked as vps that calls itself ipax, on Settings and the phone alike`, async () => {
      const { wire } = wired()
      const ipax: Inventory = {
        machine: 'ipax',
        id: IPAX_ID,
        at: new Date(NOW).toISOString(),
        shell: 'bash',
        service: true,
        items: [],
      }
      const inventories = new Inventories(wire, {
        news: () => {},
        remotes: () => [
          { name: 'vps', inventory: ipax, at: NOW, said: null },
          {
            name: 'never',
            inventory: null,
            at: null,
            said: 'it has not answered yet',
            trouble: 'down',
          },
        ],
        // Under what it calls itself, as a machine that links here is: never the name given it here.
        synced: () => [
          { id: OTHER_ID, said: 'in step' },
          { id: IPAX_ID, said },
        ],
      })
      await inventories.look()
      const settings = inventories.shown()?.columns ?? []
      expect(settings.map((one) => [one.machine, one.synced])).toEqual([
        [expect.any(String), null],
        ['vps', said],
        ['never', 'cannot tell'],
      ])
      const phone = await machinesFrom(wire, inventories).shown()
      expect(phone.columns?.map((one) => [one.machine, one.synced ?? null])).toEqual([
        [expect.any(String), null],
        ['vps', said],
        ['never', 'cannot tell'],
      ])
      // What keeps one from saying is carried as its kind, for the phone's fix.
      expect(settings.map((one) => one.trouble ?? null)).toEqual([null, null, 'down'])
      expect(phone.columns?.map((one) => one.trouble ?? null)).toEqual([null, null, 'down'])
    })
  }

  it('says cannot tell under a machine whose Tade does not say who it is, never another machine’s word', async () => {
    const { wire } = wired()
    const older: Inventory = {
      machine: 'vps',
      at: new Date(NOW).toISOString(),
      shell: 'bash',
      service: true,
      items: [],
    }
    const inventories = new Inventories(wire, {
      news: () => {},
      remotes: () => [{ name: 'vps', inventory: older, at: NOW, said: null }],
      synced: () => [{ id: OTHER_ID, said: 'in step' }],
    })
    await inventories.look()
    expect(inventories.shown()?.columns[1]?.synced).toBe('cannot tell')
  })

  it('draws one column for a machine that both links here and is linked to, whatever each calls it', async () => {
    const { wire } = wired()
    const ipax: Inventory = {
      machine: 'ipax',
      id: IPAX_ID,
      at: new Date(NOW).toISOString(),
      shell: 'bash',
      service: true,
      items: [],
    }
    const inventories = new Inventories(wire, {
      news: () => {},
      remotes: () => [{ name: 'vps', inventory: ipax, at: NOW, said: null }],
    })
    expect(await inventories.heard(ipax, 'device-1')).toBe(true)
    expect(inventories.columns().map((one) => one.machine)).toHaveLength(2)
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

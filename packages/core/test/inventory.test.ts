import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import {
  driftFindings,
  EXPIRY_DAYS,
  expiryFindings,
  findingsWritten,
  type Inventory,
  type InventoryItem,
  inventoryChanges,
  inventoryFrom,
  inventoryIn,
  lackedOn,
  machineGrid,
  recentFindings,
  versusOf,
} from '../src/inventory.ts'

// What a machine has, by name and digest: compared across machines, folded to
// `set`/`missing` for the journal, and read for what is worth saying once.

const NOW = Date.parse('2026-11-22T12:00:00.000Z')
const DAY = 86_400_000
const digest = (n: number) => String(n).padStart(64, '0')

function item(fields: Partial<InventoryItem> & Pick<InventoryItem, 'id'>): InventoryItem {
  return {
    kind: 'secret',
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

function inventory(machine: string, items: InventoryItem[], at = NOW): Inventory {
  return { machine, at: new Date(at).toISOString(), items, shell: 'zsh', service: false }
}

describe('comparing two machines', () => {
  const source = inventory('mac', [
    item({ id: 'secret:extensions.jev.key', digest: digest(1) }),
    item({ id: 'secret:extensions.sentry.token', digest: digest(2) }),
    item({ id: 'secret:accounts.work.key', digest: digest(3) }),
    item({ id: 'sign-in:claude-code', kind: 'sign-in' }),
  ])

  it('a target missing two of the source’s three secrets lists exactly those two', () => {
    const target = inventory('vps', [
      item({ id: 'secret:extensions.jev.key', digest: digest(1) }),
      item({ id: 'secret:extensions.sentry.token', state: 'missing' }),
      item({ id: 'sign-in:claude-code', kind: 'sign-in' }),
    ])
    expect(lackedOn(source, target, 'secret').map((one) => one.item.id)).toEqual([
      'secret:extensions.sentry.token',
      'secret:accounts.work.key',
    ])
  })

  it('says a key set on both with another digest is different, and one it cannot tell is unknown', () => {
    const target = inventory('vps', [
      item({ id: 'secret:extensions.jev.key', digest: digest(9) }),
      item({ id: 'secret:extensions.sentry.token', state: 'unknown' }),
    ])
    const by = Object.fromEntries(versusOf(source, target).map((one) => [one.item.id, one.there]))
    expect(by['secret:extensions.jev.key']).toBe('different')
    expect(by['secret:extensions.sentry.token']).toBe('unknown')
  })

  it('a target that never said is unknown throughout, never missing', () => {
    expect(new Set(versusOf(source, null).map((one) => one.there))).toEqual(new Set(['unknown']))
  })
})

describe('the grid', () => {
  it('draws ✓ ✗ ≠ — and ?, and the days a sign-in has left', () => {
    const here = inventory('mac', [
      item({ id: 'sign-in:claude-code', kind: 'sign-in', until: NOW + 10 * DAY + 5 }),
      item({ id: 'secret:a', digest: digest(1) }),
      item({ id: 'env:OPENROUTER_API_KEY', kind: 'env', digest: digest(4) }),
    ])
    const vps = inventory('vps', [
      item({ id: 'sign-in:claude-code', kind: 'sign-in', state: 'missing' }),
      item({ id: 'secret:a', digest: digest(2) }),
      item({ id: 'mcp:linear', kind: 'mcp', state: 'unknown' }),
    ])
    const rows = machineGrid(
      [
        { machine: 'mac', inventory: here, asOf: null },
        { machine: 'vps', inventory: vps, asOf: NOW - 60_000 },
        { machine: 'box', inventory: null, asOf: null },
      ],
      NOW,
    )
    const marks = Object.fromEntries(rows.map((row) => [row.id, row.cells.map((one) => one.mark)]))
    expect(marks['sign-in:claude-code']).toEqual(['✓', '✗', '?'])
    expect(marks['secret:a']).toEqual(['✓', '≠', '?'])
    // An environment key a machine does not list is one it does not have.
    expect(marks['env:OPENROUTER_API_KEY']).toEqual(['✓', '✗', '?'])
    expect(marks['mcp:linear']).toEqual(['—', '?', '?'])
    expect(rows.find((row) => row.id === 'sign-in:claude-code')?.cells[0]?.days).toBe(10)
    // Ordered by the steps of a setup: sign-ins first.
    expect(rows[0]?.kind).toBe('sign-in')
  })
})

describe('the journal', () => {
  it('is told set or missing, an item at a time, and only what changed', () => {
    const now = inventory('mac', [
      item({ id: 'secret:a', digest: digest(1) }),
      item({ id: 'secret:b', state: 'missing' }),
      item({ id: 'secret:c', state: 'unknown' }),
    ])
    const first = inventoryChanges(new Map(), now)
    expect(first).toEqual([
      { item: 'secret:a', now: 'set', was: null },
      { item: 'secret:b', now: 'missing', was: null },
    ])
    const events = first.map((one, seq) =>
      line(seq, 'inventory_changed', { item: one.item, now: one.now }),
    )
    expect(inventoryChanges(inventoryFrom(events), now)).toEqual([])
    // Nothing key-shaped goes in: an item's id and its state.
    for (const event of events) expect(Object.keys(event.detail).sort()).toEqual(['item', 'now'])
  })
})

describe('findings', () => {
  it('a sign-in running out within the week is found, keyed by the day it runs out', () => {
    const columns = [
      {
        machine: 'vps',
        inventory: inventory('vps', [
          item({ id: 'sign-in:codex', kind: 'sign-in', label: 'codex', until: NOW + 2 * DAY + 1 }),
          item({ id: 'sign-in:pi', kind: 'sign-in', until: NOW + 30 * DAY }),
        ]),
        asOf: null,
      },
    ]
    const found = expiryFindings(columns, NOW)
    expect(found).toHaveLength(1)
    expect(found[0]?.key).toBe('expiry:vps:sign-in:codex:2026-11-24')
    expect(found[0]?.said).toContain('runs out in 2 days')
    expect(expiryFindings(columns, NOW, 1)).toEqual([])
    expect(EXPIRY_DAYS).toBe(7)
  })

  it('a key changed on one machine and not another that still has the old one is drift', () => {
    const before = new Map([
      [
        'mac',
        inventory('mac', [item({ id: 'env:OPENROUTER_API_KEY', kind: 'env', digest: digest(1) })]),
      ],
    ])
    const after = new Map([
      [
        'mac',
        inventory(
          'mac',
          [
            item({
              id: 'env:OPENROUTER_API_KEY',
              label: 'OPENROUTER_API_KEY',
              kind: 'env',
              digest: digest(2),
            }),
          ],
          NOW + 1,
        ),
      ],
      [
        'vps',
        inventory('vps', [item({ id: 'env:OPENROUTER_API_KEY', kind: 'env', digest: digest(1) })]),
      ],
    ])
    const found = driftFindings(before, after)
    expect(found.map((one) => [one.machine, one.item])).toEqual([['mac', 'env:OPENROUTER_API_KEY']])
    expect(found[0]?.said).toBe(
      'OPENROUTER_API_KEY changed on mac and not on vps, which still has the one it replaced',
    )
    expect(found[0]?.said).not.toMatch(/[0-9a-f]{16}/)
  })

  it('is written once, and the brief says each of the week’s once', () => {
    const events = [
      line(1, 'machine_finding', { key: 'k1', said: 'one' }),
      line(2, 'machine_finding', { key: 'k1', said: 'one' }),
      line(3, 'machine_finding', { key: 'k2', said: 'two' }, NOW - 30 * DAY),
    ]
    expect(findingsWritten(events)).toEqual(new Set(['k1', 'k2']))
    expect(recentFindings(events, NOW)).toEqual(['one'])
  })
})

describe('what another machine sent', () => {
  it('is read for its shape, and refused when it is not one', () => {
    const one = inventory('vps', [item({ id: 'secret:a', digest: digest(1) })])
    expect(inventoryIn(JSON.parse(JSON.stringify(one)))).toEqual(one)
    expect(inventoryIn({ ...one, items: [{ id: 'x' }] })).toBeNull()
    expect(inventoryIn({ ...one, items: [item({ id: 'a', digest: 'not-a-digest' })] })).toBeNull()
  })
})

function line(seq: number, type: string, detail: Record<string, unknown>, at = NOW): TadeEvent {
  return {
    seq,
    ts: new Date(at).toISOString(),
    type,
    urgency: 'routine',
    detail,
  } as unknown as TadeEvent
}

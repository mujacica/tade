import { z } from 'zod'
import type { TadeEvent } from './events.ts'

// What a machine has, by name: which harness is signed in and until when,
// which keys it holds and where each comes from, which environment keys its
// files set, its MCP servers, its git identity and whether origin answers with
// its credentials, its per-machine apps and its public name — published by
// that machine alone, and compared across machines by name and by digest,
// never by value.
//
// **Three places, three depths.** The whole of it, digests and all, is the
// live answer to an owner's `/api/machine` and the copy kept in Tade's home
// (`0600`, beside the config that holds the keys themselves). The journal is
// told only `set` or `missing` per item (`inventory_changed`, `inventoryChanges`),
// because "keys are never in the journal" is easier to keep true when nothing
// key-shaped is. Telemetry is told nothing.
//
// **Unknown is an answer.** A harness that would not say, a `gh` that timed
// out, an origin nobody could ask: `unknown`, drawn `?`, and never `✗` — a
// look that could not be had is not a look that found nothing.
//
// Pure: inventories in, rows and findings out; `now` is passed.

/** What kind of thing an item is, which is which step of a guided setup walks it. */
export const ITEM_KINDS = [
  'sign-in',
  'secret',
  'env',
  'mcp',
  'git',
  'origin',
  'app',
  'public',
] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

/** How an item stands on one machine. */
export type ItemState = 'set' | 'missing' | 'unknown'

/** One thing a machine has or lacks. */
export interface InventoryItem {
  /**
   * The same on every machine, and the only thing the journal says of it:
   * `sign-in:claude-code`, `sign-in:claude-code:work`, `secret:extensions.jev.key`,
   * `env:OPENROUTER_API_KEY`, `mcp:linear`, `git:identity`, `git:github`,
   * `origin:<project>`, `app:github`, `public`.
   */
  id: string
  kind: ItemKind
  /** As a person reads it: `Claude Code · work`, `Jev's API key`, `OPENROUTER_API_KEY`. */
  label: string
  state: ItemState
  /** SHA-256 of what it holds, for comparing across machines; null where there is nothing to hash. */
  digest: string | null
  /** When a sign-in runs out, in this machine's clock; null where nobody wrote it down. */
  until: number | null
  /** Where it comes from, as places: `$OPENROUTER_API_KEY`, `config.yaml`, `~/.zshenv:14`. */
  where: string[]
  /** Why it could not say, or what having it missing turns off: a clause. */
  said: string | null
  /** The environment variables it is read from, for the line that sets it on another machine. */
  variables: string[]
  /**
   * For an environment key on a machine that runs `tade serve` under its own
   * service manager: whether the service reads it — false for a key only a
   * shell's own files set. Null where there is no such service.
   */
  service: boolean | null
}

/** One machine's inventory. */
export interface Inventory {
  /** What the machine calls itself. */
  machine: string
  /** When it was looked at, in its own clock, as ISO. */
  at: string
  items: InventoryItem[]
  /** The login shell a consolidation is checked with, by name: `zsh`. Null where none is known. */
  shell: string | null
  /** Whether `tade serve` is kept running here by a service manager's unit. */
  service: boolean
}

/** How many items one inventory carries: past it, the rest is cut and said. */
export const ITEMS_MOST = 400

const Clause = z.string().max(600)

/** One item, as another machine sent it: read for its shape, every value bounded. */
export const InventoryItemSchema = z.object({
  id: z.string().min(1).max(300),
  kind: z.enum(ITEM_KINDS),
  label: z.string().max(300),
  state: z.enum(['set', 'missing', 'unknown']),
  digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  until: z.number().finite().nullable(),
  where: z.array(z.string().max(300)).max(16),
  said: Clause.nullable(),
  variables: z.array(z.string().max(120)).max(8),
  service: z.boolean().nullable(),
})

/** An inventory, as another machine sent it. */
export const InventorySchema = z.object({
  machine: z.string().max(120),
  at: z.string().max(40),
  items: z.array(InventoryItemSchema).max(ITEMS_MOST),
  shell: z.string().max(40).nullable(),
  service: z.boolean(),
})

/** An inventory read off what another machine sent, or null for one that is not one. */
export function inventoryIn(value: unknown): Inventory | null {
  const read = InventorySchema.safeParse(value)
  return read.success ? read.data : null
}

/** The mark a cell is drawn with: set, missing, set to something else, not used there, cannot tell. */
export type Mark = '✓' | '✗' | '≠' | '—' | '?'

/** One machine's column of the grid. */
export interface GridColumn {
  machine: string
  /** Null for a machine that never said. */
  inventory: Inventory | null
  /** When what it said was heard, in this machine's clock; null for now. */
  asOf: number | null
}

/** One cell. */
export interface GridCell {
  mark: Mark
  /** Whole days a sign-in has left, where it says; null otherwise. */
  days: number | null
  where: readonly string[]
  said: string | null
}

/** One row of Settings › Machines. */
export interface GridRow {
  id: string
  kind: ItemKind
  label: string
  /** One per column, in the columns' order. */
  cells: GridCell[]
}

const DAY_MS = 86_400_000

/** Whole days from `now` to `until`, never below nought; null where there is no date. */
export function daysLeft(until: number | null, now: number): number | null {
  return until === null ? null : Math.max(0, Math.floor((until - now) / DAY_MS))
}

/**
 * Settings › Machines: a row per item any machine has, a column per machine —
 * derived on every draw, never kept. `≠` is set on both with digests that
 * differ from the first column that holds it set, which is this machine's
 * where it does: a different key.
 */
export function machineGrid(columns: readonly GridColumn[], now: number): GridRow[] {
  const order: { id: string; kind: ItemKind; label: string }[] = []
  const seen = new Set<string>()
  for (const column of columns) {
    for (const item of column.inventory?.items ?? []) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      order.push({ id: item.id, kind: item.kind, label: item.label })
    }
  }
  order.sort((a, b) => kindRank(a.kind) - kindRank(b.kind))
  return order.map((row) => {
    const held = columns.map((column) => column.inventory?.items.find((one) => one.id === row.id))
    const reference = held.find((one) => one?.state === 'set' && one.digest !== null)?.digest
    return {
      ...row,
      cells: held.map((item, at) => {
        if (columns[at]?.inventory === null) return { mark: '?', days: null, where: [], said: null }
        // An environment key is listed only where it is set, so one a machine does
        // not list is one it lacks; anything else it does not list it does not use.
        if (item === undefined) {
          return { mark: row.kind === 'env' ? '✗' : '—', days: null, where: [], said: null }
        }
        const mark: Mark =
          item.state === 'unknown'
            ? '?'
            : item.state === 'missing'
              ? '✗'
              : reference !== undefined && item.digest !== null && item.digest !== reference
                ? '≠'
                : '✓'
        return {
          mark,
          days: item.state === 'set' ? daysLeft(item.until, now) : null,
          where: item.where,
          said: item.said,
        }
      }),
    }
  })
}

function kindRank(kind: ItemKind): number {
  return ITEM_KINDS.indexOf(kind)
}

/** How one item the source has stands on the target. */
export interface Versus {
  item: InventoryItem
  /** `different`: set on both, and the digests differ. */
  there: 'set' | 'missing' | 'different' | 'unknown'
  /** The target's own item, where it has one. */
  theirs: InventoryItem | null
}

/**
 * Each item the source has set, as it stands on the target: what a guided
 * setup walks, in the order of its steps. A target that never said is
 * `unknown` throughout — never missing.
 */
export function versusOf(source: Inventory, target: Inventory | null): Versus[] {
  return source.items
    .filter((item) => item.state === 'set')
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind))
    .map((item) => {
      const theirs = target?.items.find((one) => one.id === item.id) ?? null
      if (target === null) return { item, there: 'unknown' as const, theirs }
      if (theirs === null || theirs.state === 'missing') return { item, there: 'missing', theirs }
      if (theirs.state === 'unknown') return { item, there: 'unknown', theirs }
      const differs =
        item.digest !== null && theirs.digest !== null && item.digest !== theirs.digest
      return { item, there: differs ? 'different' : 'set', theirs }
    })
}

/** What the source has that the target lacks: missing there, or there and different. */
export function lackedOn(source: Inventory, target: Inventory | null, kind?: ItemKind): Versus[] {
  return versusOf(source, target).filter(
    (one) =>
      (kind === undefined || one.item.kind === kind) &&
      (one.there === 'missing' || one.there === 'different'),
  )
}

/** One item's state as the journal is told it. */
export interface InventoryChange {
  item: string
  now: 'set' | 'missing'
  /** What the last line said, or null for the first. */
  was: 'set' | 'missing' | null
}

/**
 * The lines to write for this look: an item whose state is not what the
 * journal last said of it. `unknown` writes nothing — a look that could not be
 * had changes nothing anybody knows — and an item that is gone from the
 * inventory is not said missing: it is not used here any more.
 */
export function inventoryChanges(
  last: ReadonlyMap<string, 'set' | 'missing'>,
  inventory: Inventory,
): InventoryChange[] {
  const out: InventoryChange[] = []
  for (const item of inventory.items) {
    if (item.state === 'unknown') continue
    const was = last.get(item.id) ?? null
    if (was !== item.state) out.push({ item: item.id, now: item.state, was })
  }
  return out
}

/** What the journal last said of each item, out of its `inventory_changed` lines. */
export function inventoryFrom(events: readonly TadeEvent[]): Map<string, 'set' | 'missing'> {
  const states = new Map<string, 'set' | 'missing'>()
  for (const event of events) {
    if (event.type !== 'inventory_changed') continue
    const { item, now } = event.detail
    if (typeof item === 'string' && (now === 'set' || now === 'missing')) states.set(item, now)
  }
  return states
}

/** A sign-in with fewer days than this left is a finding. */
export const EXPIRY_DAYS = 7

/** Something about the machines worth saying once: a sign-in running out, a key that drifted. */
export interface MachineFinding {
  /** The same thing found again is the same key, so it is written and said once. */
  key: string
  kind: 'expiry' | 'drift'
  machine: string
  item: string
  /** What is said, in Tade's words: names, never a value. */
  said: string
}

/** Each sign-in on any machine with fewer than `days` left, keyed by the day it runs out. */
export function expiryFindings(
  columns: readonly GridColumn[],
  now: number,
  days = EXPIRY_DAYS,
): MachineFinding[] {
  const out: MachineFinding[] = []
  for (const column of columns) {
    for (const item of column.inventory?.items ?? []) {
      if (item.kind !== 'sign-in' || item.state !== 'set' || item.until === null) continue
      const left = daysLeft(item.until, now)
      if (left === null || left >= days) continue
      const day = new Date(item.until).toISOString().slice(0, 10)
      out.push({
        key: `expiry:${column.machine}:${item.id}:${day}`,
        kind: 'expiry',
        machine: column.machine,
        item: item.id,
        said:
          left === 0
            ? `${item.label} on ${column.machine} runs out today: sign in there again`
            : `${item.label} on ${column.machine} runs out in ${left} day${left === 1 ? '' : 's'}, on ${day}: sign in there again before then`,
      })
    }
  }
  return out
}

/**
 * A key that changed on one machine and not on another that still holds what
 * it was: the person rotated it in one place. Read off two looks at every
 * machine — what was kept, and what is held now — and keyed by the moment the
 * newer look was taken, so the one change is written once.
 */
export function driftFindings(
  before: ReadonlyMap<string, Inventory>,
  after: ReadonlyMap<string, Inventory>,
): MachineFinding[] {
  const out: MachineFinding[] = []
  for (const [machine, now] of after) {
    const was = before.get(machine)
    if (was === undefined) continue
    for (const item of now.items) {
      const old = was.items.find((one) => one.id === item.id)
      if (!old?.digest || !item.digest || old.digest === item.digest) continue
      if (item.kind !== 'secret' && item.kind !== 'env') continue
      for (const [other, theirs] of after) {
        if (other === machine) continue
        const still = theirs.items.find((one) => one.id === item.id)
        if (still?.digest !== old.digest) continue
        out.push({
          key: `drift:${machine}:${item.id}:${other}:${now.at}`,
          kind: 'drift',
          machine,
          item: item.id,
          said: `${item.label} changed on ${machine} and not on ${other}, which still has the one it replaced`,
        })
      }
    }
  }
  return out
}

/** The keys of every finding the journal already holds: what is never written or said again. */
export function findingsWritten(events: readonly TadeEvent[]): Set<string> {
  const keys = new Set<string>()
  for (const event of events) {
    if (event.type === 'machine_finding' && typeof event.detail.key === 'string')
      keys.add(event.detail.key)
  }
  return keys
}

/** The findings of the last `days` days, newest first, one per key: what the brief says. */
export function recentFindings(
  events: readonly TadeEvent[],
  now: number,
  days = EXPIRY_DAYS,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const event of [...events].reverse()) {
    if (event.type !== 'machine_finding') continue
    const at = Date.parse(event.ts)
    if (!Number.isFinite(at) || now - at > days * DAY_MS) continue
    const { key, said } = event.detail
    if (typeof key !== 'string' || typeof said !== 'string' || seen.has(key)) continue
    seen.add(key)
    out.push(said)
  }
  return out
}

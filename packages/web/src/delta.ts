import type { SnapshotInput } from './input.ts'
import type { Budget } from './page.ts'
import type { Collection, Delta, Freshness, PageInfo, Snapshot } from './protocol.ts'
import { KEYED, PROTOCOL_VERSION } from './protocol.ts'
import { type Cursors, snapshotOf } from './snapshot.ts'

// What changed, and the one thing a clock on its own may cost.
//
// **Time alone sends nothing.** Every row here holds moments and not elapsed
// figures, so a beat on which nothing happened produces a projection that
// differs from the last one in `fresh.at` and in nothing else — and
// `deltaBetween` answers `null` to that. A row carrying an `ageMs` would
// instead differ on every beat, and a tick of the clock would resend every
// task in every project to every connected phone, for ever. (DESIGN.md §10.2
// puts `ageMs` on `TaskRow`; `input.ts`'s `movedAt` is that field corrected,
// and this is the reason.)
//
// When a client does need the server's own clock moved on, `tick` is a frame
// carrying the freshness and nothing else. It is **not a revision**: it leaves
// `rev` where it was, it never goes in a replay ring, and a client that misses
// one has an older `at` and a correct tree.
//
// Pure, like `snapshot.ts`: no `node:`, no clock, nothing to await.

const ISO = (at: number): string => new Date(at).toISOString()

/**
 * Structural equality over projection values.
 *
 * Written out rather than `JSON.stringify(a) === JSON.stringify(b)`, which is
 * the same answer only while two objects happen to be built with their keys in
 * the same order. Everything in a projection is JSON — string, number,
 * boolean, null, array, plain object — so this is total over it.
 */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((one, at) => same(one, b[at]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) if (!same(left[key], right[key])) return false
  return true
}

/** What one collection's rows became. */
interface Changed<R> {
  set: Record<string, Partial<R>>
  del: string[]
}

/**
 * One collection, diffed by id.
 *
 * A row the client has not seen before is sent **whole**, not as the fields
 * that differ from nothing — otherwise a shallow merge would be applied to an
 * absent row and the client would hold a half a task. A row it has seen is
 * sent as its changed top-level fields only.
 */
function diff<R extends object>(
  was: readonly R[],
  is: readonly R[],
  key: (row: R) => string,
): Changed<R> {
  const before = new Map(was.map((row) => [key(row), row]))
  const set: Record<string, Partial<R>> = {}
  const del: string[] = []
  for (const row of is) {
    const id = key(row)
    const old = before.get(id)
    before.delete(id)
    if (old === undefined) {
      set[id] = { ...row }
      continue
    }
    const fields: Partial<R> = {}
    let moved = false
    for (const field of Object.keys(row) as (keyof R)[]) {
      if (same(row[field], old[field])) continue
      fields[field] = row[field]
      moved = true
    }
    if (moved) set[id] = fields
  }
  for (const id of before.keys()) del.push(id)
  return { set, del }
}

/** Whether anything in the freshness but the moment and the revision moved. */
function freshMoved(was: Freshness, is: Freshness): boolean {
  return !same({ ...was, at: '', rev: 0 }, { ...is, at: '', rev: 0 })
}

/**
 * What changed between two projections, or `null` when nothing did.
 *
 * `null` is the answer whenever the only difference is `fresh.at` and
 * `fresh.rev` — which is every beat on which nothing happened, and is most of
 * them.
 *
 * The delta is stamped with `is`'s revision, so the caller advances the
 * revision on the snapshot before asking (`revise` does).
 */
export function deltaBetween(was: Snapshot, is: Snapshot): Delta | null {
  if (was.v !== is.v)
    throw new Error(`cannot diff protocol v${was.v} against v${is.v}: send a snapshot`)
  const changed: Partial<Record<Collection, Changed<object>>> = {}
  let moved = false
  for (const collection of Object.keys(KEYED) as Collection[]) {
    const key = KEYED[collection] as (row: object) => string
    const one = diff(was[collection] as readonly object[], is[collection] as readonly object[], key)
    if (Object.keys(one.set).length === 0 && one.del.length === 0) continue
    changed[collection] = one
    moved = true
  }
  const pages: Partial<Record<Collection, PageInfo>> = {}
  for (const collection of Object.keys(KEYED) as Collection[]) {
    if (same(was.pages[collection], is.pages[collection])) continue
    pages[collection] = is.pages[collection]
    moved = true
  }
  const fresh = freshMoved(was.fresh, is.fresh)
  const you = !same(was.you, is.you)
  if (!moved && !fresh && !you) return null

  // Six row types, one shape: the maps are built loosely and named once here.
  // The schema is what holds them (`DeltaSchema`), and the test that parses
  // every delta strictly is what makes that more than a comment.
  const set: Record<string, unknown> = {}
  const del: Record<string, unknown> = {}
  for (const [collection, one] of Object.entries(changed)) {
    if (Object.keys(one.set).length > 0) set[collection] = one.set
    if (one.del.length > 0) del[collection] = one.del
  }
  const delta: Delta = {
    v: PROTOCOL_VERSION,
    rev: is.fresh.rev,
    at: is.fresh.at,
    fresh: is.fresh,
    set: set as unknown as Delta['set'],
    del: del as unknown as Delta['del'],
  }
  if (Object.keys(pages).length > 0) delta.pages = pages
  if (you) delta.you = is.you
  return delta
}

/**
 * The server's clock moved on, and nothing else.
 *
 * Carries the revision it already had, because nothing about the projection
 * changed: a tick is not a revision, is never replayed out of a ring, and
 * applying it touches `fresh` alone.
 */
export function tick(snapshot: Snapshot, now: number): Delta {
  const at = ISO(now)
  return {
    v: PROTOCOL_VERSION,
    rev: snapshot.fresh.rev,
    at,
    fresh: { ...snapshot.fresh, at },
    set: {},
    del: {},
  }
}

function merge<R extends object>(
  rows: readonly R[],
  set: Record<string, Partial<R>> | undefined,
  del: readonly string[] | undefined,
  key: (row: R) => string,
): R[] {
  const gone = new Set(del ?? [])
  const out = new Map<string, R>()
  for (const row of rows) {
    const id = key(row)
    if (!gone.has(id)) out.set(id, row)
  }
  for (const [id, fields] of Object.entries(set ?? {})) {
    const old = out.get(id)
    // A row the client has not seen arrives whole (`diff`), so this cast is a
    // cast of a complete row and not of half of one.
    out.set(id, old === undefined ? ({ ...fields } as R) : { ...old, ...fields })
  }
  return [...out.values()].sort((a, b) => {
    const x = key(a)
    const y = key(b)
    return x < y ? -1 : x > y ? 1 : 0
  })
}

/**
 * A delta applied to a projection.
 *
 * Here rather than only in the browser because it is what makes the delta
 * trustworthy: a test asserts that applying `deltaBetween(a, b)` to `a` gives
 * back exactly `b`, which is the one property the whole stream rests on. A
 * client that cannot do that has to ask for a snapshot — which it may always
 * do, and which is why every failure path here is recoverable.
 */
export function applyDelta(snapshot: Snapshot, delta: Delta): Snapshot {
  if (delta.v !== snapshot.v)
    throw new Error(`cannot apply protocol v${delta.v} to v${snapshot.v}: ask for a snapshot`)
  return {
    v: snapshot.v,
    fresh: delta.fresh ?? snapshot.fresh,
    you: delta.you ?? snapshot.you,
    pages: { ...snapshot.pages, ...(delta.pages ?? {}) },
    projects: merge(snapshot.projects, delta.set.projects, delta.del.projects, KEYED.projects),
    tasks: merge(snapshot.tasks, delta.set.tasks, delta.del.tasks, KEYED.tasks),
    queue: merge(snapshot.queue, delta.set.queue, delta.del.queue, KEYED.queue),
    findings: merge(snapshot.findings, delta.set.findings, delta.del.findings, KEYED.findings),
    notes: merge(snapshot.notes, delta.set.notes, delta.del.notes, KEYED.notes),
    plans: merge(snapshot.plans, delta.set.plans, delta.del.plans, KEYED.plans),
    chat: merge(snapshot.chat, delta.set.chat, delta.del.chat, KEYED.chat),
    intake: merge(snapshot.intake, delta.set.intake, delta.del.intake, KEYED.intake),
    sources: merge(snapshot.sources, delta.set.sources, delta.del.sources, KEYED.sources),
    runs: merge(snapshot.runs, delta.set.runs, delta.del.runs, KEYED.runs),
    workflows: merge(snapshot.workflows, delta.set.workflows, delta.del.workflows, KEYED.workflows),
  }
}

/** What a beat came to. */
export type Revision =
  /** There was nothing held: this is the first projection, at the revision it was asked at. */
  | { kind: 'first'; snapshot: Snapshot; rev: number }
  /** Nothing about the projection moved. The held one stands and nothing is sent. */
  | { kind: 'unchanged'; snapshot: Snapshot; rev: number }
  /** It moved. The new projection, the revision it is, and what to send. */
  | { kind: 'changed'; snapshot: Snapshot; rev: number; delta: Delta }

/**
 * One beat: build the projection, and say what to do about it.
 *
 * The revision is advanced here and nowhere else, and only on a beat that
 * actually changed something — which is what `rev` means. It is based on
 * `input.lifetime.rev`, the revision the server holds now: the server owns its
 * own lifetime, this function only says what the next one is.
 */
export function revise(
  held: Snapshot | null,
  input: SnapshotInput,
  now: number,
  cursors: Cursors = {},
  budget?: Budget,
): Revision {
  const base = input.lifetime.rev
  const is = snapshotOf(input, now, cursors, budget)
  if (held === null) return { kind: 'first', snapshot: is, rev: base }
  const next = base + 1
  const at: Snapshot = { ...is, fresh: { ...is.fresh, rev: next } }
  const delta = deltaBetween(held, at)
  if (delta === null) return { kind: 'unchanged', snapshot: held, rev: base }
  return { kind: 'changed', snapshot: at, rev: next, delta }
}

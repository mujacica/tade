// What the page holds, and the one thing it does to it: merge a delta.
//
// **There is no second state machine here.** Every state, every reason and
// every count on the page came off the wire already decided — `deriveState`'s
// answer, `deriveState`'s own clause, `queueStateOf`'s standing, the folds that
// `spendFrom` and `statsFrom` did. This file keys rows by id, applies the
// shallow merge the protocol describes, and groups what it holds. It never
// decides that a task is blocked, that a check passed, or that queued work is
// ready; the day it did, the page and the window would disagree on the morning
// it mattered.
//
// **The merge is deliberately dumb**, and that is the protocol's doing: `set`
// is collection → id → the changed fields, `del` is collection → ids, every
// collection is keyed by a stable id, and a row arriving for the first time
// comes whole. So a merge is `Object.assign` over a `Map`, and the property that
// makes every failure path recoverable is that **a delta can always be replaced
// by a snapshot**.
//
// **A version this page does not know is refused, not guessed at.** `v` is on
// every frame for exactly this: a client served a protocol it cannot read has
// one correct move, which is to say so and stop, and it cannot make that move
// if it has to infer the version from the shape.
//
// Two honesty rules live here because they are about the data and not the
// drawing:
//
// - **A fold over a budgeted collection is a floor.** The snapshot carries at
//   most 60 tasks per project and says how many it left out; a total summed over
//   what arrived is therefore `≥`, and `spendFold` reports `partial` so the page
//   can say so rather than quietly under-reporting somebody's week.
// - **A task with no spend row is unknown, not nought.** It is counted and
//   named, never added as a zero.
//
// Nothing here touches the DOM.

/** The protocol this page speaks. A frame of any other version is refused. */
export const SPEAKS = 1

const COLLECTIONS = [
  'projects',
  'tasks',
  'queue',
  'findings',
  'notes',
  'plans',
  'chat',
  'intake',
  'sources',
  'runs',
  'workflows',
]

/** Nothing held yet: the state before the first frame arrives. */
export function emptyStore() {
  const rows = {}
  for (const name of COLLECTIONS) rows[name] = new Map()
  return {
    rows,
    pages: {},
    fresh: null,
    you: null,
    machines: [],
    host: null,
    rev: -1,
    had: false,
    // Every other machine's copy, a store each, by its name in `machines`.
    copies: new Map(),
  }
}

/**
 * The whole tree, replacing whatever was held.
 *
 * A snapshot replaces rather than merges, which is what makes dropping a run of
 * deltas correct instead of lossy: over the budget the server stops sending
 * them and owes one `resync`, and this is what answers it.
 */
export function applySnapshot(store, snapshot) {
  if (snapshot.v !== SPEAKS) return refuse(snapshot.v)
  for (const name of COLLECTIONS) {
    const held = new Map()
    for (const row of snapshot[name] ?? []) held.set(keyOf(name, row), row)
    store.rows[name] = held
  }
  store.pages = { ...snapshot.pages }
  store.fresh = snapshot.fresh
  store.you = snapshot.you
  // The person's other machines, as this one has seen them; an older Tade sends none.
  store.machines = snapshot.machines ?? []
  // This machine's own figures; an older Tade sends none, which is none and not nought.
  store.host = snapshot.host ?? null
  store.rev = snapshot.fresh.rev
  store.had = true
  return null
}

/**
 * What changed, applied over what is held.
 *
 * A tick — the server's clock moved on and nothing else did — is this with
 * `set` and `del` empty and `rev` where it was, so it costs one assignment.
 */
export function applyDelta(store, delta) {
  if (delta.v !== SPEAKS) return refuse(delta.v)
  // A delta before any snapshot has nothing to merge into: a shallow merge
  // applied to an absent row is how a page ends up holding half a task.
  if (!store.had) return 'this page has no snapshot to apply a change to'
  for (const name of COLLECTIONS) {
    const held = store.rows[name]
    for (const id of delta.del?.[name] ?? []) held.delete(id)
    const changed = delta.set?.[name]
    if (changed === undefined) continue
    for (const id of Object.keys(changed)) {
      held.set(id, { ...(held.get(id) ?? {}), ...changed[id] })
    }
  }
  if (delta.pages !== undefined) store.pages = { ...store.pages, ...delta.pages }
  if (delta.fresh !== null && delta.fresh !== undefined) store.fresh = delta.fresh
  if (delta.you !== undefined) store.you = delta.you
  if (delta.machines !== undefined) store.machines = delta.machines
  if (delta.host !== undefined) store.host = delta.host
  store.rev = delta.rev
  return null
}

/** Another machine's copy as the door passes it on (`copies.ts`); a change it is not at marks it `behind`. */
export function applyCopy(store, frame) {
  if (frame.v !== SPEAKS) return refuse(frame.v)
  if (typeof frame.machine !== 'string') return 'a machine frame named no machine'
  if (frame.kind === 'gone') {
    store.copies.delete(frame.machine)
    return null
  }
  if (frame.kind === 'whole') {
    const copy = emptyStore()
    const refused = applySnapshot(copy, frame.snapshot)
    if (refused !== null) return refused
    copy.behind = false
    store.copies.set(frame.machine, copy)
    return null
  }
  if (frame.kind !== 'change') return null
  const copy = store.copies.get(frame.machine)
  if (copy === undefined) return null
  if (copy.rev !== frame.from) {
    copy.behind = true
    return null
  }
  return applyDelta(copy, frame.delta)
}

/** How many copies are `behind`: one more after a frame is the page's cue to reopen its stream, which sends it whole. */
export function copiesBehind(store) {
  let behind = 0
  for (const copy of store.copies.values()) if (copy.behind === true) behind += 1
  return behind
}

/** Every other machine's copy the page holds, by name, in the order they were first heard. */
export function copiesOf(store) {
  return [...store.copies].map(([machine, copy]) => ({ machine, copy }))
}

/** How many copies a page says it holds when it opens its stream: the door reads no more. */
const HELD_MOST = 32

/** The stream's address, with the revision of each copy held (`copiesHeldOf`); one `behind` is not claimed. */
export function streamPath(store) {
  const query = new URLSearchParams()
  for (const [machine, copy] of store.copies) {
    if (query.getAll('held').length >= HELD_MOST) break
    if (copy.behind === true || copy.fresh === null || typeof copy.rev !== 'number') continue
    query.append('held', `${copy.fresh.epoch}:${copy.rev}:${machine}`)
  }
  const said = query.toString()
  return said === '' ? '/api/stream' : `/api/stream?${said}`
}

function refuse(version) {
  return `this page reads version ${SPEAKS} of Tade's away protocol and the machine sent version ${version}. Reload it.`
}

/** The id a row is keyed by, which `protocol.ts`'s `KEYED` decides. */
function keyOf(collection, row) {
  switch (collection) {
    case 'projects':
    case 'workflows':
      return row.name
    case 'queue':
      return row.task
    case 'findings':
      return row.key
    case 'intake':
      return row.item
    case 'sources':
      return row.source
    case 'runs':
      return row.run
    default:
      return row.id
  }
}

/**
 * One collection, in the order the wire sent it: ascending by its stable id.
 *
 * Sorted on read rather than kept sorted, because a delta inserts rows and a
 * list that drifted out of order would make two pages of the same data read
 * differently. Notes are the one exception and ask for it by name.
 */
export function rowsOf(store, collection) {
  return [...store.rows[collection].keys()].sort(byText).map((id) => store.rows[collection].get(id))
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * What wants you, and in the order it wants you.
 *
 * `wantsYou` is the window's *needs you* (its own `markOf`, carried on the
 * row), so this sorts rather than decides: whatever is waiting on a keypress
 * first, then what failed.
 */
const URGENCY = { 'needs-you': 0, failed: 1 }

export function wantsYou(store) {
  return rowsOf(store, 'tasks')
    .filter((task) => task.wantsYou)
    .sort((a, b) => (URGENCY[a.mark] ?? 9) - (URGENCY[b.mark] ?? 9) || byText(a.id, b.id))
}

/** The ids that want you, for telling what *crossed* into wanting you. */
export function wantingIds(store) {
  return new Set(wantsYou(store).map((task) => task.id))
}

/** The projects on Tade's list: a closed one is a row the window keeps, never one drawn. */
export function projectsOf(store) {
  return rowsOf(store, 'projects').filter((row) => row.open !== false)
}

export function taskAt(store, project, name) {
  return store.rows.tasks.get(`${project}/${name}`) ?? null
}

/** Queued work, newest-written preference first and then by task id. */
export function queueIn(store, project) {
  const rows = rowsOf(store, 'queue').filter((row) => project === null || row.project === project)
  return rows.sort((a, b) => order(a) - order(b) || byText(a.task, b.task))
}

/**
 * This machine's queue as the overview counts it. A row `there` stands for
 * another machine's queued work, read out of its journal; where the page holds
 * that machine's own copy, its real rows are counted from that copy instead
 * (ONE-AWAY-VIEW §5 step 4). One whose machine the page holds no copy of
 * stays, since it is the only place that work is seen.
 */
export function queuedHere(store) {
  const held = new Set(copiesOf(store).map(({ machine }) => machine))
  return queueIn(store, null).filter(
    (row) => row.state.kind !== 'there' || !held.has(row.state.machine),
  )
}

// A written `order` is **only ever a preference among the ready**, so a row
// without one sorts after every row with one rather than ahead of them.
const order = (row) => (row.order === null || row.order === undefined ? 1e9 : row.order)

/**
 * The conversation's lines, oldest first.
 *
 * Sorted by id, which is `<the moment, ISO>#<n>` and therefore the order
 * things were said — the one collection whose order *is* its meaning. Every
 * other selector here sorts for the wire's sake; this one sorts because a
 * conversation read out of order is not a conversation.
 */
export function chatOf(store) {
  return rowsOf(store, 'chat').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The conversation as it stands: the revision to echo, whether a turn is in
 * flight and whose, and whether this device may send one.
 *
 * `null` where talking is not turned on, which is **not** an empty
 * conversation: a page told there are no lines would say Tade had never been
 * spoken to, and what is true is that this surface is off.
 *
 * `undefined` before the first snapshot, which is neither: nothing has been
 * read, and a page that said *not turned on* then was reading its own empty
 * store as the machine's setting.
 */
export function talkOf(store) {
  if (!store.had) return undefined
  return store.you?.talk ?? null
}

/**
 * The requests, newest first.
 *
 * Newest first because an inbox is read that way, and **not grouped**: which
 * of them is waiting for somebody is a state the projection already decided
 * (`inboxWaiting`'s own list, copied into `glyphs.js` and held equal to it),
 * and grouping is the screen's own decision about the room it has.
 */
export function intakeOf(store, project = null) {
  return rowsOf(store, 'intake')
    .filter((row) => project === null || row.project === project)
    .sort((a, b) => byText(b.at, a.at))
}

/** The ones somebody at the machine has to answer, which is what a badge counts. */
export function intakeWaiting(store, project = null) {
  return intakeOf(store, project).filter((row) => WAITING.includes(row.state))
}

/**
 * Which inbox states want a person.
 *
 * `WAITING_STATES` in `@tade/core`'s `intake-inbox.ts`, copied because a
 * browser cannot import a `.ts` file, and held equal to it by
 * `test/store.test.ts` — the same treatment the queue's words get in
 * `glyphs.js`, for the same reason: a second reading of *is this mine to
 * answer* is a second state machine.
 */
export const WAITING = ['proposed', 'held', 'failure']

/**
 * How many of a collection are not here, which the page says out loud.
 *
 * A flat cap that said nothing would lose four repositories without a word;
 * every page of the projection carries its own count of what it left out, and
 * this is the one reader of it.
 */
export function omitted(store, collection) {
  return store.pages[collection]?.omitted ?? 0
}

/**
 * The clock the page counts ages against, and whether it is frozen.
 *
 * Live: the device's own clock, so ages tick. Anything else: **the server's own
 * last word**, so they stop — an age counting up against a snapshot nothing can
 * refresh is the lie the freshness line exists to prevent.
 */

export function asOf(store, kind, now) {
  const said = store.fresh === null ? null : Date.parse(store.fresh.at)
  if (kind === 'live' || said === null || Number.isNaN(said)) return { at: now, frozen: false }
  return { at: said, frozen: true }
}

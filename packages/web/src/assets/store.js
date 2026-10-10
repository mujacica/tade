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

/**
 * The kinds of reading a device can be granted, as the page asks about them.
 *
 * `reach.ts`'s own list, and held equal to it by `test/store.test.ts` — a word
 * here that the machine does not grant is a page asking a question nobody can
 * answer yes to, and one the machine grants that is missing here is a reading
 * the page silently treats as withheld.
 */
export const GRANTS = [
  'titles',
  'intent',
  'notes',
  'findings',
  'spend',
  'reviews',
  'accounts',
  'talk',
  'requests',
  'material',
  'workflows',
]

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
  return { rows, pages: {}, fresh: null, you: null, rev: -1, had: false }
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
  store.rev = delta.rev
  return null
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
 * `wantsYou` is the projection's own flag — `blocked | failed | review` — so
 * this sorts rather than decides. Blocked first because somebody is waiting on
 * a keypress, then failed, then work that is finished and nobody has looked at.
 */
const URGENCY = { blocked: 0, failed: 1, review: 2 }

export function wantsYou(store) {
  return rowsOf(store, 'tasks')
    .filter((task) => task.wantsYou)
    .sort((a, b) => (URGENCY[a.state] ?? 9) - (URGENCY[b.state] ?? 9) || byText(a.id, b.id))
}

/** The ids that want you, for telling what *crossed* into wanting you. */
export function wantingIds(store) {
  return new Set(wantsYou(store).map((task) => task.id))
}

export function projectsOf(store) {
  return rowsOf(store, 'projects')
}

export function tasksIn(store, project) {
  return rowsOf(store, 'tasks').filter((task) => task.project === project)
}

export function taskAt(store, project, name) {
  return store.rows.tasks.get(`${project}/${name}`) ?? null
}

export function projectAt(store, name) {
  return store.rows.projects.get(name) ?? null
}

/** Queued work, newest-written preference first and then by task id. */
export function queueIn(store, project) {
  const rows = rowsOf(store, 'queue').filter((row) => project === null || row.project === project)
  return rows.sort((a, b) => order(a) - order(b) || byText(a.task, b.task))
}

// A written `order` is **only ever a preference among the ready**, so a row
// without one sorts after every row with one rather than ahead of them.
const order = (row) => (row.order === null || row.order === undefined ? 1e9 : row.order)

/** Notes, newest first, which is the one collection that is read that way. */
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
 */
export function talkOf(store) {
  return store.you?.talk ?? null
}

export function notesOf(store) {
  return rowsOf(store, 'notes').reverse()
}

export function findingsOf(store) {
  return rowsOf(store, 'findings')
}

export function plansOf(store) {
  return rowsOf(store, 'plans')
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

export function intakeAt(store, item) {
  return store.rows.intake.get(item) ?? null
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

export function sourcesOf(store) {
  return rowsOf(store, 'sources')
}

/** The runs, newest-looking first: the one with unfinished steps before the done ones. */
export function runsOf(store, project = null) {
  return rowsOf(store, 'runs')
    .filter((row) => project === null || row.projects.includes(project))
    .sort((a, b) => done(a) - done(b) || byText(a.run, b.run))
}

const done = (run) => (run.total > 0 && run.finished === run.total ? 1 : 0)

export function runAt(store, name) {
  return store.rows.runs.get(name) ?? null
}

export function workflowsOf(store) {
  return rowsOf(store, 'workflows')
}

export function workflowAt(store, name) {
  return store.rows.workflows.get(name) ?? null
}

/**
 * The money over a set of tasks, folded — and every way it could be incomplete,
 * named.
 *
 * `partial` is the one that matters: a snapshot carries at most 60 tasks of a
 * project and says how many it left out, so a sum over what arrived is a floor
 * and the page has to draw it as one. `unknown` is how many of the tasks that
 * *did* arrive reported no money at all, which is not nought either.
 */
export function spendFold(tasks, partial = false) {
  const out = {
    usd: 0,
    usdExact: 0,
    usdEstimated: 0,
    usdListed: 0,
    usdOnPlan: 0,
    tokens: 0,
    tokensUnpriced: 0,
    tokensOnPlanUnrated: 0,
    hasCost: false,
    unknown: 0,
    partial,
  }
  for (const task of tasks) {
    const spend = task.spend
    if (spend === null || spend === undefined) {
      out.unknown += 1
      continue
    }
    out.usd += spend.usd
    out.usdExact += spend.usdExact
    out.usdEstimated += spend.usdEstimated
    out.usdListed += spend.usdListed
    out.usdOnPlan += spend.usdOnPlan
    out.tokens += spend.tokens
    out.tokensUnpriced += spend.tokensUnpriced
    out.tokensOnPlanUnrated += spend.tokensOnPlanUnrated
    out.hasCost = out.hasCost || spend.hasCost
  }
  return out
}

/**
 * The check rollups over a set of tasks, as **counts and never as one word**.
 *
 * A project is not green because the tasks that answered were: a check nobody
 * ran here is `unknown`, and folding three greens and an unknown into "green"
 * is the exact claim `deriveState` refuses to make. So this counts, and the
 * page draws a word only where there is nothing left to be unsure about.
 */
export function checksFold(tasks) {
  const out = { pass: 0, fail: 0, unknown: 0, failed: new Set(), missing: new Set(), overridden: 0 }
  for (const task of tasks) {
    const checks = task.checks
    if (checks === undefined) continue
    out[checks.state] = (out[checks.state] ?? 0) + 1
    for (const name of checks.failed) out.failed.add(name)
    for (const name of checks.missing) out.missing.add(name)
    if (checks.overridden) out.overridden += 1
  }
  return { ...out, failed: [...out.failed].sort(byText), missing: [...out.missing].sort(byText) }
}

/**
 * The word for a folded rollup, or null for *there is nothing to say yet*.
 *
 * Red the moment anything is red; green only when every task that has an
 * answer is green **and nothing is unknown**; otherwise null, and the page says
 * how many could not be looked at.
 */
export function checksWord(fold) {
  if (fold.fail > 0) return 'fail'
  if (fold.unknown > 0 || fold.pass === 0) return 'unknown'
  return 'pass'
}

/**
 * Branches offered for merge, and the work that is finished and nobody asked
 * about.
 *
 * The second list is the one worth having: *two commits ahead and nobody asked
 * for a review* is a thing to see, and it is invisible on a page that lists
 * only what a forge knows about.
 */
export function reviewsOf(store) {
  const offered = []
  const unoffered = []
  for (const task of rowsOf(store, 'tasks')) {
    if (task.review !== null && task.review !== undefined) offered.push(task)
    else if ((task.ahead ?? 0) > 0) unoffered.push(task)
  }
  return { offered, unoffered }
}

/**
 * Whether this device was granted a kind of reading.
 *
 * **The difference between two dashes.** A field that is null because nobody
 * wrote the figure down and one that is null because this device may not read
 * it are different facts, and a page that drew both as *not recorded* would be
 * telling somebody their work cost nothing. `you.reads` is what the machine
 * granted at pairing, and it is the only way to tell them apart from here.
 */
export function mayRead(store, grant) {
  return store.you?.reads.includes(grant) ?? false
}

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
 * refresh is the lie §5.10 exists to prevent.
 */
/**
 * The moment every money figure in this projection is counted from, or null.
 *
 * Off the freshness rather than worked out here: the page cannot know the
 * window's folding rule and must not guess at it (`sinceSaid`).
 */
export function spendSince(store) {
  return store.fresh?.spendSince ?? null
}

export function asOf(store, kind, now) {
  const said = store.fresh === null ? null : Date.parse(store.fresh.at)
  if (kind === 'live' || said === null || Number.isNaN(said)) return { at: now, frozen: false }
  return { at: said, frozen: true }
}

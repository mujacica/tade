// The last view: a handful of numbers this device may keep, so that opening
// Tade with nothing to ask says *what was true, and when* rather than nothing
// at all.
//
// **It is counts and a moment, and there is no text in it.** No title, no
// intent, no note, no request's words, no approval, no project name, no task
// name — and that is not a redaction applied to a snapshot, it is a different
// value built from one. A snapshot is the whole tree including somebody's own
// words and a stranger's; a phone in a pocket is the place where *what was
// downloaded cannot be taken back*, so what goes on its disk is the smallest
// thing that answers the question somebody opens the app on a train to ask.
//
// Three properties, each held by `test/offline.test.ts`:
//
// - **The allow-list is applied on the way in and on the way out.** A record
//   written by another version of this page, or by anything else that can
//   reach this origin's caches, cannot carry a field along: `onlyKept` is run
//   over what is read as well as over what is written.
// - **It is stamped with when it was true** and drawn with that age, never as
//   though it were now. The page already refuses to let an age count up
//   against a snapshot nothing can refresh; this is the same rule for a view
//   that outlived the tab it was made in.
// - **Nothing can be done from it.** There is no control on this screen, and
//   that is structural rather than a decision made here: a device with no
//   answer from the machine has no session on this page, so `actsOf` has no
//   scopes to draw a control from, and every act is re-checked at the machine
//   anyway.
//
// The record lives in Cache Storage under a URL the machine does not serve and
// the worker does not know, so nothing can reach it through `fetch` and no
// cache of it can be mistaken for an answer. Cache Storage rather than the
// other stores for one more reason: everything this page keeps is then named
// under one prefix, and signing out is one loop.

import { el, into } from './dom.js'
import { clockOf, count, duration } from './figures.js'
import { CACHE_PREFIX } from './install.js'
import { intakeWaiting, omitted, rowsOf } from './store.js'

/**
 * The whole of what may be on that disk.
 *
 * Written out as a list rather than described, because the failure this is
 * against is a field that rode along — and a list is the only form of that
 * rule a test can check against a record nobody wrote by hand.
 */
export const KEPT = [
  'savedAt',
  'at',
  'projects',
  'tasks',
  'working',
  'wantsYou',
  'queue',
  'inbox',
  'runs',
]

/** Where the record is kept. Not a path the machine serves, deliberately. */
export const VIEW_KEY = '/last-view'

/**
 * The cache it is kept in, under the one prefix a clear-out loops over.
 *
 * The page knows this name rather than being told it, because the moment it
 * is read is the moment there is nothing to ask: a cold open with no machine
 * answering. `test/offline.test.ts` holds it equal to `installable.ts`'s.
 */
export const VIEW_CACHE = `${CACHE_PREFIX}view`

/** The counts, out of what the page is holding now. */
export function countsOf(store, savedAt) {
  const tasks = rowsOf(store, 'tasks')
  return {
    savedAt,
    // The machine's own last word about when this was true, as a number of
    // milliseconds rather than as the instant's own spelling. Two reasons, and
    // the second is the one that matters: a record of numbers has no string in
    // it anywhere, which is a claim a test can make in one line and nothing
    // can quietly weaken.
    at: store.fresh === null ? null : Date.parse(store.fresh.at),
    projects: store.rows.projects.size,
    tasks: tasks.length,
    working: tasks.filter((task) => task.state === 'working').length,
    wantsYou: tasks.filter((task) => task.wantsYou === true).length,
    queue: store.rows.queue.size + omitted(store, 'queue'),
    inbox: intakeWaiting(store).length,
    runs: store.rows.runs.size + omitted(store, 'runs'),
  }
}

/**
 * A record with nothing on it but `KEPT`, and numbers where numbers belong.
 *
 * Run over what is written *and* over what is read. The second is the one that
 * matters: a record is a value in a store this origin's own pages share, and
 * the version of Tade that wrote one is not always the version reading it.
 */
export function onlyKept(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out = {}
  for (const name of KEPT) {
    const held = value[name]
    if (typeof held === 'number' && Number.isFinite(held)) out[name] = held
    else out[name] = null
  }
  return out.savedAt === null ? null : out
}

/** Keep it, or answer false — a store this browser will not open is not an error. */
export async function saveView(counts) {
  if (self.caches === undefined) return false
  try {
    const cache = await self.caches.open(VIEW_CACHE)
    await cache.put(
      VIEW_KEY,
      new Response(JSON.stringify(onlyKept(counts)), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    return true
  } catch {
    // A quota, a private window, a browser that keeps no storage for this
    // origin. None of them is a reason the page stops working, and the only
    // thing lost is the answer on the next cold open.
    return false
  }
}

/** What was kept, or null — and null is also what a record this cannot read is. */
export async function readView() {
  if (self.caches === undefined) return null
  try {
    const cache = await self.caches.open(VIEW_CACHE)
    const held = await cache.match(VIEW_KEY)
    if (held === undefined) return null
    return onlyKept(await held.json())
  } catch {
    return null
  }
}

/** Remove it. Turning the setting off, signing out and being revoked all do. */
export async function forgetView() {
  if (self.caches === undefined) return
  try {
    await self.caches.delete(VIEW_CACHE)
  } catch {
    // Nothing to do about a store that will not open, and nothing to say: the
    // caller is on its way to the pairing screen either way.
  }
}

/**
 * What the last view looks like: a time, some numbers, and what it is not.
 *
 * The heading is the age and not a count, because the age is the thing that
 * decides whether any of the numbers under it are worth reading. The sentence
 * under them is the one §5.10 is about, said for a page that is not merely
 * stale but was drawn from a disk: nothing here is now, and nothing here can
 * be done.
 */
export function lastSeenScreen(view, now) {
  const node = el('div', { class: 'column' })
  // `typeof`, not a null check: a record this could not read answers null, and
  // a caller with nothing at all hands an empty object. Both draw the heading
  // without an age rather than `NaN ago`, which is the shape a subtraction
  // against `undefined` takes.
  const since = typeof view.savedAt === 'number' ? Math.max(0, now - view.savedAt) : null
  // **The age is this device's clock against this device's clock**, and the
  // wall time is the machine's against the machine's. Mixing them is what a
  // single timestamp would have forced: the phone is somewhere else, and
  // *2pm* there is not *2pm* here.
  const told = typeof view.at === 'number' ? clockOf(view.at) : null
  into(
    node,
    el('h1', { text: since === null ? 'Last seen' : `Last seen ${duration(since)} ago` }),
    el('p', {
      class: 'caveat',
      text: `This device cannot reach the machine.${told === null ? '' : ` Nothing here is newer than ${told}.`} What is below is what this page was told when it last could — not what is happening now, and nothing here can be acted on.`,
    }),
  )
  const list = el('ul', { class: 'rows' })
  for (const [said, n] of [
    ['working', view.working],
    ['wants you', view.wantsYou],
    ['queued', view.queue],
    ['waiting in the inbox', view.inbox],
    ['runs', view.runs],
    ['projects', view.projects],
  ]) {
    const row = el('li')
    into(row, el('span', { class: 'figure', text: count(n ?? 0) }), el('span', { text: said }))
    into(list, row)
  }
  into(
    node,
    list,
    el('p', {
      class: 'caveat',
      // **What to do, rather than a promise this screen cannot keep.** It has
      // no beat and patches nothing — there is nothing to refresh into — so
      // saying it fills in by itself would be a page waiting for something
      // that is never coming.
      text: 'Tade answers only while its window is open on the machine. Open it there, then reload this page.',
    }),
  )
  return { node, update() {} }
}

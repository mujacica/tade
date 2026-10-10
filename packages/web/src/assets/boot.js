// The entry: it decides which of two pages this is, holds **one** stream, and
// moves between screens without reloading anything.
//
// Three absolute rules, and they hold against script that got onto this page
// rather than against anything a network does:
//
// 1. **No file here builds markup.** Every value reaches the DOM through
//    `textContent` or `setAttribute`, built in `dom.js`, and
//    `test/assets.test.ts` asserts no module in this folder reaches for
//    `innerHTML`. The content policy has no `unsafe-inline` to fall back on.
// 2. **The ticket leaves the address bar immediately.** It arrives in the
//    fragment — which a browser never sends to a server, so it is in no access
//    log, no `Referer` and no error report — and the first thing this does is
//    read it and replace the history entry, so it is not in the visible URL or
//    the back stack either.
// 3. **One `EventSource`, for the life of the page.** Navigating between
//    screens does not open a second one and does not close this one; the stream
//    is the page's, not a screen's. It is closed for good when the server says
//    why — `notice`, `revoked`, `too_many` — and reopened on a bounded backoff
//    otherwise, with its ceiling, because a phone in a pocket must not ask
//    every second for an hour.
//
// And the rule the whole design is downstream of: **unreachable is never
// stopped.** A dropped stream adds a bar and changes no row, no glyph and no
// count. Nothing here ever draws the page empty because it could not ask.

import { actsOf } from './acts.js'
import { classOn, el, textIn } from './dom.js'
import { backoffAt, connectionOf, standingOf } from './live.js'
import {
  checksScreen,
  devicesScreen,
  findingsScreen,
  moreScreen,
  notesScreen,
  nowhereScreen,
  pairScreen,
  queueScreen,
  reviewsScreen,
  spendScreen,
} from './pages.js'
import { viewOf } from './routes.js'
import { nowScreen, projectScreen, taskScreen } from './screens.js'
import {
  barsFor,
  barsIn,
  crossing,
  freshIn,
  heldOn,
  navCounts,
  navOn,
  shell,
  titleFor,
} from './shell.js'
import {
  applyDelta,
  applySnapshot,
  asOf,
  emptyStore,
  GRANTS,
  mayRead,
  omitted,
  rowsOf,
  wantingIds,
} from './store.js'

/** The ticket out of the fragment, taken out of the address bar as it is read. */
function ticketIn() {
  const hash = location.hash
  const found = /^#t=([A-Za-z0-9_-]{27})$/.exec(hash)
  // Replaced whatever was in the fragment, including something that was not a
  // ticket: a value nobody here understands is still a value nobody needs in
  // their address bar.
  if (hash !== '') history.replaceState(null, '', location.pathname)
  return found === null ? null : found[1]
}

const held = { ticket: null, session: null, devices: null, store: emptyStore() }

/** One request. JSON in, JSON out, and the token a form cannot send. */
async function ask(method, path, body) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  const csrf = held.session?.csrf
  if (csrf !== undefined && csrf !== null) headers['x-tade-csrf'] = csrf
  let answer = null
  try {
    answer = await fetch(path, {
      method,
      headers,
      // Same-origin and nothing else: this page has no other origin to talk to,
      // and the policy's `connect-src 'self'` means it could not if it did.
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    // Unreachable, which is a state and not an exception. The caller draws it.
    return { status: 0, body: null }
  }
  let said = null
  try {
    said = await answer.json()
  } catch {
    said = null
  }
  return { status: answer.status, body: said }
}

/** Tade's own sentence for what happened, or this page's for what it cannot name. */
function sentence(answer) {
  if (answer.status === 0) return 'The machine is not answering.'
  if (answer.body !== null && typeof answer.body.said === 'string') return answer.body.said
  return 'Something went wrong here.'
}

const shown = shell()
const ctx = {
  ask,
  sentence,
  ticket: () => held.ticket,
  session: () => held.session,
  devices: () => held.devices,
  /**
   * The projection revision the screen being looked at is of.
   *
   * Sent with every act, so the machine can refuse one made from a tab left
   * open overnight before the entity check has to explain itself. Read at the
   * moment of the press and never remembered: a value held from a draw would
   * be the staleness it exists to catch.
   */
  revOf: () => held.store.fresh?.rev ?? 0,
  go: (path, opts = {}) => go(path, opts),
  /**
   * Ask the machine for the device list again.
   *
   * It is **not on the stream** — a device being let in or disconnected is not
   * a projection change — so a page that read it once at start would show a
   * phone somebody revoked yesterday. The Devices screen asks when it opens,
   * which is the only moment anybody is looking at it.
   */
  freshen: async () => {
    const mine = await ask('GET', '/api/devices')
    if (mine.status === 200 && mine.body !== null) {
      tookDevices(mine.body)
      paint()
    }
  },
}

let screen = null
let where = { view: 'now' }
let seen = { open: false, lastAt: Date.now(), ended: null }
let tries = 0
let source = null
let wanted = null
/** A read that failed, kept as a bar until one succeeds. */
let broke = []

/* ── the router ────────────────────────────────────────────────────────────── */

const SCREENS = {
  now: () => nowScreen(),
  project: (at) => projectScreen(at),
  task: (at) => taskScreen(at, ctx),
  queue: () => queueScreen(),
  checks: () => checksScreen(),
  reviews: () => reviewsScreen(),
  spend: () => spendScreen(),
  findings: () => findingsScreen(),
  notes: () => notesScreen(),
  devices: () => devicesScreen(ctx),
  pair: () => pairScreen(ctx),
  more: () => moreScreen(),
  nowhere: () => nowhereScreen(),
}

/**
 * Go somewhere, and **build the screen fresh**.
 *
 * A navigation is the one moment the page is allowed to replace a region: it is
 * what the person asked for, and focus moving to the top of the new screen is
 * correct. Every other redraw patches (`screen.update`).
 */
function go(path, opts = {}) {
  if (opts.reload === true) {
    location.replace(path)
    return
  }
  if (opts.replace === true) history.replaceState(null, '', path)
  else if (path !== location.pathname) history.pushState(null, '', path)
  draw(viewOf(path))
}

function draw(at) {
  where = at
  const make = SCREENS[at.view] ?? SCREENS.nowhere
  screen = make(at)
  shown.main.replaceChildren(screen.node)
  document.title = titleFor(at)
  navOn(shown.links, at)
  // Focus goes to the region, not to its first link: a screen reader then reads
  // the heading it arrived at, and the keyboard's next Tab is the first thing
  // on the new screen rather than the top of the page.
  shown.main.setAttribute('tabindex', '-1')
  shown.main.focus({ preventScroll: true })
  paint()
}

/** Every in-page link, taken over once, at the document. */
function wireLinks() {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const link = event.target.closest?.('a')
    if (link === null || link === undefined) return
    const href = link.getAttribute('href') ?? ''
    // An outbound link and an in-page anchor are both somebody else's job: the
    // first opens a new tab, the second is the browser's own scrolling.
    if (link.target === '_blank' || href.startsWith('#') || !href.startsWith('/')) return
    event.preventDefault()
    go(href)
  })
  addEventListener('popstate', () => draw(viewOf(location.pathname)))
}

/* ── drawing ───────────────────────────────────────────────────────────────── */

/**
 * One paint: the freshness, the bars, the counts, and the screen's own update.
 *
 * Called on a frame, on a beat, and after a navigation — never in a loop. The
 * screen patches what it already drew, so this costs text assignments and no
 * layout thrash on a phone.
 */
function paint() {
  const now = Date.now()
  const connection = connectionOf(seen, now)
  const standing = standingOf(connection, tries)
  const clock = asOf(held.store, standing, now)
  freshIn(shown, standing, connection, held.store, now)
  barsIn(shown, barsFor(standing, connection, held.store, now, tries, broke))
  heldOn(document.body, standing)
  if (held.store.had) {
    navCounts(shown.links, {
      wantsYou: rowsOf(held.store, 'tasks').filter((task) => task.wantsYou).length,
      queue: held.store.rows.queue.size + omitted(held.store, 'queue'),
      reviews: rowsOf(held.store, 'tasks').filter((task) => task.review !== null).length,
      findings: held.store.rows.findings.size,
      notes: held.store.rows.notes.size + omitted(held.store, 'notes'),
    })
  }
  screen?.update({
    store: held.store,
    standing,
    asOf: clock.at,
    frozen: clock.frozen,
    now,
    where,
    // What this device was granted, read once a paint rather than per row.
    may: {
      ...Object.fromEntries(GRANTS.map((grant) => [grant, mayRead(held.store, grant)])),
      // **A drawing hint and never an authority.** It is the scopes on this
      // device's own session, so a control it was not granted is *absent*
      // rather than drawn and refused — and the machine re-asks every part of
      // it at the act anyway: the setting, the origin, the project and the
      // state the screen said. A page that lied here would get a `403`, which
      // is the right way round.
      //
      // Per verb and not one flag, because the two tiers are two scopes: a
      // device granted `answer` and not `steer` draws the approval control and
      // nothing else.
      acts: actsOf(held.session),
    },
  })
}

/** What crossed into wanting you, said once, to anybody listening. */
function announce() {
  const is = wantingIds(held.store)
  const words = crossing(wanted, is)
  wanted = is
  if (words !== '') textIn(shown.announce, words)
}

/* ── the one stream ────────────────────────────────────────────────────────── */

/**
 * The one stream, opened once and reopened on a bounded backoff.
 *
 * Six frames and each has one job. `snapshot` and `delta` are the tree;
 * `resync` says this page fell behind and a snapshot is following; `notice`,
 * `revoked` and `too_many` are the server saying **why**, which is the one
 * answer no timeout can improve on — so each of them closes the stream for
 * good rather than retrying into a door that has been shut.
 */
function openStream() {
  source = new EventSource('/api/stream')
  source.addEventListener('open', () => {
    seen = { ...seen, open: true, lastAt: Date.now() }
    tries = 0
    paint()
  })
  source.addEventListener('snapshot', (event) => took(event, applySnapshot))
  source.addEventListener('delta', (event) => took(event, applyDelta))
  source.addEventListener('resync', (event) => {
    // Said, not swallowed: this page fell behind and what follows replaces
    // what it held. A snapshot always follows one, so there is nothing to do
    // but tell somebody.
    alive()
    broke = [
      {
        key: 'resync',
        tone: 'is-stale',
        glyph: '◴',
        lead: 'This page fell behind.',
        under: `${toldIn(event.data)} It is being redrawn from the machine.`,
      },
    ]
    paint()
  })
  source.addEventListener('notice', (event) => {
    seen = { ...seen, ended: toldIn(event.data, 'Tade is closing, so this stream is ending') }
    source?.close()
    paint()
  })
  source.addEventListener('revoked', () => {
    source?.close()
    // Signed out is the pairing screen, which is where this device now is.
    // Anything else would be a page pretending it still has a session.
    held.session = null
    go('/pair', { replace: true, reload: true })
  })
  source.addEventListener('too_many', () => {
    seen = { ...seen, ended: 'This device has too many pages of Tade open.' }
    source?.close()
    paint()
  })
  source.addEventListener('error', () => {
    // Open and failing is the browser retrying on its own; closed is ours to
    // retry, and a `204` — which is how a dead session is answered, because a
    // non-200 kills an `EventSource` for good — arrives here as a close.
    seen = { ...seen, open: false }
    paint()
    if (source?.readyState !== 2) return
    source.close()
    setTimeout(() => void again(), backoffAt(tries))
  })
}

/**
 * Try again, having first asked whether this device still *has* a session.
 *
 * Without that question a page whose session went while the tab was closed
 * reopens a stream the server answers `204` to, for as long as the phone is
 * awake, and says nothing about it. With it, the one honest outcome — *this
 * device was signed out* — reaches the person on the second try.
 */
async function again() {
  const mine = await ask('GET', '/api/devices')
  if (mine.status === 401 || mine.status === 403) {
    held.session = null
    go('/pair', { replace: true, reload: true })
    return
  }
  if (mine.status === 200 && mine.body !== null) tookDevices(mine.body)
  tries += 1
  openStream()
}

function alive() {
  seen = { ...seen, open: true, lastAt: Date.now() }
}

/** A frame arrived: merge it, say what crossed, and draw. */
function took(event, apply) {
  alive()
  let frame = null
  try {
    frame = JSON.parse(event.data)
  } catch {
    // A frame this page cannot read is not a reason to say the machine has
    // gone: the connection is plainly alive. Said as a bar rather than thrown.
    broke = [failedBar('a frame from the machine could not be read')]
    paint()
    return
  }
  const refused = apply(held.store, frame)
  if (refused !== null) {
    broke = [failedBar(refused)]
    paint()
    return
  }
  broke = []
  announce()
  paint()
}

function failedBar(said) {
  return { key: 'broke', tone: 'is-gone', glyph: '▲', lead: 'Could not read this.', under: said }
}

/** Tade's own sentence out of a frame, or the one this page has for it. */
function toldIn(data, instead = '') {
  try {
    const frame = JSON.parse(data)
    return typeof frame.said === 'string' ? frame.said : instead
  } catch {
    return instead
  }
}

/**
 * The slow beat, and the two moments worth an immediate try.
 *
 * The beat redraws so the freshness parenthesis moves and a stream that went
 * quiet becomes visibly stale without anything having arrived. Five seconds,
 * not a frame: nothing on this page animates, and a phone in a pocket is not
 * a thing to keep awake.
 */
function wireBeat() {
  setInterval(paint, 5000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    paint()
    if (source?.readyState !== 2) return
    tries = 0
    source.close()
    void again()
  })
  shown.again.addEventListener('click', () => {
    // Forcing a resnapshot is reopening the stream: the server answers a
    // cursor from another epoch, or no cursor at all, with a whole snapshot.
    tries = 0
    source?.close()
    seen = { ...seen, open: false, ended: null }
    openStream()
  })
  shown.keys.addEventListener('click', () => {
    shown.sheet.hidden = !shown.sheet.hidden
  })
}

/* ── the keyboard ──────────────────────────────────────────────────────────── */

/**
 * `g` then a letter to go somewhere, `j`/`k` through the rows, `Enter` to open
 * one, `Escape` to go back, `?` for the list.
 *
 * Nothing is claimed that does nothing: there is no search on this page in this
 * phase, so there is no `/`. A key that looks like it works and does not is
 * worse than one that was never offered.
 */
const GOES = { n: '/', q: '/queue', s: '/spend', c: '/checks', r: '/reviews', f: '/findings' }

function wireKeys() {
  let going = false
  let on = -1
  document.addEventListener('keydown', (event) => {
    const where_ = event.target
    if (where_?.tagName === 'INPUT' || where_?.tagName === 'TEXTAREA') return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (going) {
      going = false
      const path = GOES[event.key]
      if (path !== undefined) {
        event.preventDefault()
        go(path)
      }
      return
    }
    switch (event.key) {
      case 'g':
        going = true
        return
      case '?':
        event.preventDefault()
        shown.sheet.hidden = !shown.sheet.hidden
        return
      case 'Escape':
        if (!shown.sheet.hidden) {
          shown.sheet.hidden = true
          return
        }
        history.back()
        return
      case 'j':
      case 'k': {
        const rows = [...shown.main.querySelectorAll('li > a, li > div > a')]
        if (rows.length === 0) return
        event.preventDefault()
        on = Math.max(0, Math.min(rows.length - 1, on + (event.key === 'j' ? 1 : -1)))
        rows[on]?.focus()
        for (const [at, row] of rows.entries()) {
          classOn(row.closest('li'), 'on', at === on)
        }
        return
      }
      default:
    }
  })
}

/* ── starting ──────────────────────────────────────────────────────────────── */

function tookDevices(body) {
  held.session = body.you
  held.devices = body.devices
}

async function start() {
  held.ticket = ticketIn()
  document.body.replaceChildren(...shown.parts)
  wireLinks()
  wireKeys()
  const mine = await ask('GET', '/api/devices')
  if (mine.status === 200 && mine.body !== null) {
    tookDevices(mine.body)
    draw(viewOf(location.pathname))
    wireBeat()
    openStream()
    return
  }
  // No session: the pairing screen, whatever path was asked for. Replacing the
  // address rather than keeping it, so a reload after pairing lands on a real
  // screen rather than back here.
  draw({ view: 'pair' })
  if (location.pathname !== '/pair') history.replaceState(null, '', '/pair')
}

start().catch(() => {
  // The one failure this cannot draw around: the shell is up and the first
  // request did not finish. Said in the page's own words rather than left blank.
  document.body.replaceChildren(
    el('main', { attrs: { id: 'main' } }),
    el('p', { class: 'empty', text: 'Tade is not answering. Reload this page.' }),
  )
})

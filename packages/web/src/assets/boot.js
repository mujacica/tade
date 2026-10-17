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
import { agentsScreen } from './agents.js'
import { deskParts } from './desk.js'
import { docksOn, forgetFolds } from './docks.js'
import { classOn, el, textIn } from './dom.js'
import { forget, NOT_SECURE, startInstall, takeUpdate } from './install.js'
import { backoffAt, connectionOf, outsideOf, standingOf } from './live.js'
import { countsOf, forgetView, lastSeenScreen, readView, saveView } from './offline.js'
import { taskScreen } from './pages/agent.js'
import { checksScreen } from './pages/checks.js'
import { devicesScreen } from './pages/devices.js'
import { evaluationsScreen } from './pages/evaluations.js'
import { findingsScreen } from './pages/findings.js'
import { inboxScreen, requestScreen } from './pages/inbox.js'
import { moreScreen, nowhereScreen } from './pages/more.js'
import { notesScreen } from './pages/notes.js'
import { nowScreen } from './pages/overview.js'
import { projectScreen } from './pages/project.js'
import { queueScreen } from './pages/queue.js'
import { reviewsScreen } from './pages/reviews.js'
import { runScreen, runsScreen } from './pages/runs.js'
import { settingsScreen } from './pages/settings.js'
import { spendScreen } from './pages/spend.js'
import { workflowScreen, workflowsScreen } from './pages/workflows.js'
import { pairScreen } from './pair.js'
import { palette } from './palette.js'
import { passkeys } from './passkey.js'
import { looking, resend } from './push.js'
import { movedFrom, PAGE_OF, viewOf } from './routes.js'
import {
  barsFor,
  barsIn,
  crossing,
  endingBar,
  freshIn,
  heldOn,
  insideIn,
  navCounts,
  navOn,
  shell,
  titleFor,
} from './shell.js'
import {
  agentsOf,
  applyDelta,
  applySnapshot,
  asOf,
  emptyStore,
  GRANTS,
  intakeWaiting,
  mayRead,
  omitted,
  rowsOf,
  wantingIds,
} from './store.js'
import { talkScreen } from './talk.js'
import { toasts } from './toasts.js'

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

const held = {
  ticket: null,
  session: null,
  devices: null,
  store: emptyStore(),
  /**
   * What the machine says about keeping anything: whether it offers an
   * installed shell, and whether this device may keep a few counts. Null until
   * the first answer, and null is *do nothing new* —
   * an existing registration is still brought up to date, which is how a
   * machine that turned this off tells a phone so.
   */
  shell: null,
  /** The last view read off this device's disk, where there is one. */
  lastView: null,
}

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
  // **A proof that ran out while the page was open**, answered at the act: the
  // device list is asked again, so the bar that makes a new one goes up.
  if (said?.error === 'unproven') void ctx.freshen()
  return { status: answer.status, body: said }
}

/** Tade's own sentence for what happened, or this page's for what it cannot name. */
function sentence(answer) {
  if (answer.status === 0) return 'The machine is not answering.'
  if (answer.body !== null && typeof answer.body.said === 'string') return answer.body.said
  return 'Something went wrong here.'
}

const ctx = {
  ask,
  sentence,
  ticket: () => held.ticket,
  session: () => held.session,
  devices: () => held.devices,
  /**
   * What the machine offers a device to keep and to be told, or null before
   * the first answer.
   *
   * Read through the context rather than imported, because it arrives on
   * `/api/devices` and can change under a page that is open — somebody turns
   * notifications on at the machine and `freshen` is what tells this page.
   */
  shell: () => held.shell,
  /** How a page with no session stands — `unreachable` or `unpaired` — or null with one. */
  outside: () => outside?.standing ?? null,
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

// This device's passkey (`passkey.js`): a bar with a press, where acting from
// here asks for one, and nothing anywhere else.
const proving = passkeys({
  ask,
  freshen: () => ctx.freshen(),
  paint: () => paint(),
  credentials: () => navigator.credentials,
})

// The frame, with the desk's three parts in it: built once, after the context
// they send through, and patched on every paint like a screen.
const desk = deskParts(ctx)
const shown = shell(desk)
// The three docks' folds, put back as this device left them (`docks.js`).
const docks = docksOn(shown)
// The command bar: Tade, and everywhere else, one press away (`palette.js`).
const bar = palette(ctx)
// What just changed, as a toast that links to it (`toasts.js`).
const told = toasts()

let screen = null
let where = { view: 'now' }
let seen = { open: false, lastAt: Date.now(), ended: null }
/**
 * How a page with no session stands (`outsideOf`), and the one screen it may
 * draw — or null while it has one. Nothing else is reachable from outside: a
 * screen of a store nothing filled would say *nothing is running*.
 */
let outside = null
let tries = 0
let source = null
let wanted = null
/** A read that failed, kept as a bar until one succeeds. */
let broke = []
/** Whether a new shell is installed and waiting for somebody to say when. */
let newer = false
/** Whether the page's own files changed on the machine and a reload is owed. */
let changed = false
/**
 * Why this browser kept no copy, where the machine offered one — or null.
 *
 * `insecure` is the origin, which is a thing somebody can fix; `cannot` is a
 * browser that has none of this, which is not. **Both are said**, because a
 * machine whose setting says *a device may install it* and a phone where
 * nothing happened is a silence somebody has to go and find the reason for.
 */
let refused = null
/** When the last view was last written, so a beat is not a write. */
let keptAt = 0

/* ── the router ────────────────────────────────────────────────────────────── */

const SCREENS = {
  now: () => nowScreen(ctx),
  project: (at) => projectScreen(at, ctx),
  task: (at) => taskScreen(at, ctx),
  agents: () => agentsScreen(),
  queue: () => queueScreen(),
  inbox: () => inboxScreen(),
  request: (at) => requestScreen(at, ctx),
  runs: () => runsScreen(),
  run: (at) => runScreen(at),
  workflows: () => workflowsScreen(),
  workflow: (at) => workflowScreen(at, ctx),
  checks: () => checksScreen(),
  evals: () => evaluationsScreen(ctx),
  reviews: () => reviewsScreen(ctx),
  spend: () => spendScreen(),
  findings: () => findingsScreen(),
  notes: () => notesScreen(ctx),
  talk: () => talkScreen(ctx),
  lastSeen: () => lastSeenScreen(held.lastView ?? {}, Date.now()),
  devices: () => devicesScreen(ctx),
  settings: () => settingsScreen(ctx),
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
  // Where the screen being left was scrolled to, kept on its own entry: the
  // screen scrolls itself rather than the document (`frame.css`), so the
  // browser's own restoring on Back has nothing to restore.
  history.replaceState({ top: shown.main.scrollTop }, '')
  if (opts.replace === true) history.replaceState(null, '', path)
  else if (path !== location.pathname) history.pushState(null, '', path)
  draw(viewOf(path))
}

function draw(asked, top = 0) {
  const at = outside === null ? asked : { view: outside.view }
  where = at
  // An old address (`/runs`) is the same screen; the bar says the new one.
  const moved = outside === null ? movedFrom(location.pathname) : null
  if (moved !== null) history.replaceState(history.state, '', moved)
  const make = SCREENS[at.view] ?? SCREENS.nowhere
  // **The screen being left stops whatever it was asking.** One has something
  // to stop — an agent's page asks for its screen while it is open, and the
  // asking is what keeps the machine reading that lane — and a screen that
  // was never told it had been left would go on asking from a region nobody
  // can see.
  screen?.leave?.()
  screen = make(at)
  // A navigation is the one moment a screen is built fresh, so it is the one
  // moment it rises in (`motion.css`); a delta patches and never animates it.
  screen.node.classList.add('enter')
  // The page's own sheet is scoped under this class (`pages/<page>.css`).
  const page = PAGE_OF[at.view]
  if (page !== undefined) screen.node.classList.add(`page-${page}`)
  shown.main.replaceChildren(screen.node)
  document.title = titleFor(at)
  badged = -1
  navOn(shown.links, at)
  // Focus goes to the region, not to its first link: a screen reader then reads
  // the heading it arrived at, and the keyboard's next Tab is the first thing
  // on the new screen rather than the top of the page.
  shown.main.setAttribute('tabindex', '-1')
  shown.main.focus({ preventScroll: true })
  paint()
  // A new screen opens at its top, and one gone back to where it was left.
  shown.main.scrollTop = top
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
  addEventListener('popstate', () => draw(viewOf(location.pathname), history.state?.top ?? 0))
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
  // The very first ask is *connecting*: nothing was ever read, so there is
  // nothing to be behind on and no bar to put up about it.
  const first = !held.store.had && tries === 0 && !seen.open && seen.ended === null
  const standing = outside?.standing ?? (first ? 'connecting' : standingOf(connection, tries))
  const clock = asOf(held.store, standing, now)
  freshIn(shown, standing, connection, held.store, now)
  barsIn(shown, barsFor(standing, connection, held.store, now, tries, [...broke, ...offered()]))
  // A kept view is a record and says so itself; only rows a stream drew dim.
  heldOn(document.body, outside === null ? standing : 'live')
  insideIn(shown, outside === null)
  // The counts beside the navigation, once a paint: the rail, the tab bar
  // and the More screen all draw these and nothing else.
  const counts = held.store.had
    ? {
        wantsYou: rowsOf(held.store, 'tasks').filter((task) => task.wantsYou).length,
        agents: agentsOf(held.store).length,
        queue: held.store.rows.queue.size + omitted(held.store, 'queue'),
        // **What is waiting on somebody**, not how many requests there are: a
        // badge counting forty answered tickets is a badge nobody looks at
        // twice. `intakeWaiting` is the domain's own list of states, copied
        // into `store.js` and held equal to it.
        intake: intakeWaiting(held.store).length,
        runs: held.store.rows.runs.size + omitted(held.store, 'runs'),
        workflows: held.store.rows.workflows.size + omitted(held.store, 'workflows'),
        reviews: rowsOf(held.store, 'tasks').filter((task) => task.review !== null).length,
        findings: held.store.rows.findings.size,
        notes: held.store.rows.notes.size + omitted(held.store, 'notes'),
      }
    : null
  if (counts !== null) navCounts(shown.links, counts)
  // The page's own standing, as two classes the stylesheet draws from: a
  // shimmer where figures will be before anything was read, and a line
  // sweeping under the header while the machine is asked again.
  classOn(document.body, 'is-loading', outside === null && !held.store.had)
  classOn(
    document.body,
    'is-reconnecting',
    standing === 'reconnecting' || standing === 'connecting',
  )
  badgeIn(outside === null ? (counts?.wantsYou ?? 0) : 0)
  keep(now)
  const view = {
    store: held.store,
    standing,
    asOf: clock.at,
    frozen: clock.frozen,
    now,
    where,
    counts,
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
  }
  screen?.update(view)
  if (outside === null) {
    desk.update(view)
    bar.update(view)
  }
}

/**
 * The update bar, which is the whole of how a new shell reaches somebody.
 *
 * A bar with a button and never a reload. The page may be holding a note
 * somebody typed on a train, and there is no version of *we reloaded and lost
 * it* that is worth a fresher stylesheet — so the worker waits
 * (`sw.js` never calls `skipWaiting` on install), this says so, and the swap
 * happens on a press. The second line is the half people need before they dare
 * press it.
 */
function offered() {
  const said = []
  const ending = endingBar(held.session?.until, Date.now())
  if (ending !== null && outside === null) said.push(ending)
  if (outside === null) {
    said.push(...proving.bars(held.session))
    proving.ready()
  }
  if (refused !== null) {
    // **The silent failure, said once.** A browser on a plain address over a
    // network refuses a worker, a cache and an install without a word, so a
    // person who turned this on at the machine sees nothing happen and has
    // nothing to go on. The clause for the fixable half is the domain's own.
    said.push({
      key: 'refused',
      tone: 'is-stale',
      glyph: '⚠',
      lead:
        refused === 'insecure'
          ? 'This address cannot keep a copy of this page.'
          : 'This browser will not keep a copy of this page.',
      under:
        refused === 'insecure'
          ? `Installing ${NOT_SECURE} one. Everything else here works as it is.`
          : 'Everything else here works exactly as it does now.',
    })
  }
  if (changed) {
    said.push({
      key: 'changed',
      tone: 'is-stale',
      glyph: '↻',
      lead: 'This page changed on the machine.',
      under: 'Nothing reloads while something is typed here. Reload when it is sent or kept.',
      press: { said: 'Reload', does: () => location.reload() },
    })
  }
  if (!newer) return said
  said.push({
    key: 'update',
    tone: 'is-stale',
    glyph: '↑',
    lead: 'A new version of this page is ready.',
    under: 'Nothing reloads until you tap. Anything you have typed stays where it is.',
    press: { said: 'Reload', does: () => void takeUpdate() },
  })
  return said
}

/**
 * Keep the counts, at most twice a minute.
 *
 * The beat is five seconds and this is a write to a store on a phone's disk,
 * so it is paced by the thing being written rather than by the thing that
 * calls it. It is also the only moment the allow-list matters at run time:
 * `countsOf` builds the record, and there is no path by which a row, a title
 * or a note reaches it.
 */
function keep(now) {
  if (held.shell?.keepsView !== true || !held.store.had) return
  if (now - keptAt < 30_000) return
  keptAt = now
  void saveView(countsOf(held.store, now))
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
    // Anything else would be a page pretending it still has a session — and
    // everything this device kept goes with the session.
    void signedOut()
  })
  source.addEventListener('reload', () => {
    // **The page's own files changed** — only ever said by a Tade running
    // from its repository (`reloading.ts`). Reloaded at once, unless
    // somebody has typed something into a box: then it is the bar with its
    // press, because nothing reloads a page somebody is typing in.
    alive()
    const typed = [...document.querySelectorAll('textarea, input')].some(
      (one) => one.value.trim() !== '' && one.offsetParent !== null,
    )
    if (!typed) {
      location.reload()
      return
    }
    changed = true
    paint()
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
    await signedOut()
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
  told.update(rowsOf(held.store, 'tasks'), seen.open)
  paint()
}

/** The last count the badges were given, so a beat that changed nothing writes nothing. */
let badged = -1

/**
 * What wants you, on the tab's title and on the installed app's icon.
 *
 * The title is what a desk shows in a tab strip of thirty; the badge is what a
 * home screen shows, through the Badging API where the browser has it (an
 * installed app on iOS 16.4 and up, Chrome and Edge) and nothing where it
 * does not. A count and no words — the notification rule, kept here too.
 */
function badgeIn(n) {
  if (n === badged) return
  badged = n
  const title = document.title.replace(/^\(\d+\+?\) /, '')
  document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${title}` : title
  try {
    if (n > 0) void navigator.setAppBadge?.(n)?.catch?.(() => {})
    else void navigator.clearAppBadge?.()?.catch?.(() => {})
  } catch {
    // A browser that has the method and refuses it has nothing to draw on.
  }
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
 * `/` and `⌘K` open the command bar, which is the page's search. Nothing is
 * claimed that does nothing: a key that looks like it works and does not is
 * worse than one that was never offered.
 */
const GOES = {
  n: '/',
  a: '/agents',
  q: '/queue',
  t: '/talk',
  s: '/spend',
  c: '/checks',
  r: '/reviews',
  f: '/findings',
}

function wireKeys() {
  let going = false
  let on = -1
  // **⌘K, or Ctrl+K**, from anywhere — a field included, because the bar is
  // where somebody goes *from* whatever they were typing in. Only with a
  // session: the bar's every row is a screen a paired device reads.
  document.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return
    if (outside !== null) return
    event.preventDefault()
    if (bar.isOpen()) bar.shut()
    else bar.open()
  })
  for (const press of shown.asks) press.addEventListener('click', () => bar.open(press))
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
      // The command bar, from the key every search box on the web answers to.
      case '/':
        if (outside !== null) return
        event.preventDefault()
        bar.open()
        return
      case '?':
        event.preventDefault()
        shown.sheet.hidden = !shown.sheet.hidden
        return
      // The three docks, each folded or opened by a key of its own: the menu
      // on the left, the work on the right, Tade at the foot.
      case '[':
      case ']':
      case '\\':
        if (outside !== null) return
        event.preventDefault()
        docks.toggle(event.key === '[' ? 'menu' : event.key === ']' ? 'side' : 'tade')
        return
      case 'Escape':
        if (!shown.sheet.hidden) {
          shown.sheet.hidden = true
          return
        }
        // A drawer open over the work is what Escape closes first.
        if (docks.close()) return
        history.back()
        return
      case 'j':
      case 'k': {
        // Rows, and the cards that stand in for rows: a piece of work that
        // wants you and a project are each one stop, like a row.
        const rows = [
          ...shown.main.querySelectorAll('li > a, li > div > a, a.card-link, a.proj, a.tile'),
        ].filter((one) => one.offsetParent !== null)
        if (rows.length === 0) return
        event.preventDefault()
        on = Math.max(0, Math.min(rows.length - 1, on + (event.key === 'j' ? 1 : -1)))
        rows[on]?.focus()
        for (const [at, row] of rows.entries()) {
          const item = row.closest('li')
          if (item !== null) classOn(item, 'on', at === on)
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
  held.shell = body.shell ?? null
}

/**
 * Everything this device keeps, gone — and then the pairing screen.
 *
 * The one path out of a session, taken from three places: the stream saying
 * this device was revoked, a read coming back `401`, and signing out. It is
 * done **before** the navigation rather than after it, because the reload that
 * follows is the last thing this page does.
 *
 * What it cannot do is said where somebody turns installing on: a device that
 * is not here has not been told anything, and a shell already on its disk
 * stays there until it next reaches this machine.
 */
async function signedOut() {
  held.session = null
  forgetFolds()
  await forgetView()
  await forget()
  go('/pair', { replace: true, reload: true })
}

async function start() {
  held.ticket = ticketIn()
  // The sprite the icons are drawn from stays: it is in the shell so that no
  // module has to spell the SVG namespace (`icons.js`).
  const sprite = document.querySelector('svg.sprite')
  document.body.replaceChildren(
    ...[sprite, ...shown.parts, told.node, bar.node].filter((one) => one !== null),
  )
  wireLinks()
  wireKeys()
  const mine = await ask('GET', '/api/devices')
  if (mine.status === 200 && mine.body !== null) {
    tookDevices(mine.body)
    draw(viewOf(location.pathname))
    wireBeat()
    openStream()
    // After the first draw, never before it: registering a worker is a network
    // round trip and a snapshot is what somebody opened this for. The machine
    // says whether to, and saying no still brings an existing registration up
    // to date — which is the one moment a phone can be told this was turned
    // off.
    void install()
    return
  }
  // **Unreachable is not signed out**, and the difference is the whole of what
  // a kept view is for: a `0` is a machine that did not answer, and if this
  // device kept a few counts they are what it last knew. Timestamped, with
  // nothing on it that can be pressed.
  if (mine.status === 0) {
    held.lastView = await readView()
    if (held.lastView !== null) {
      // **No beat, like the pairing screen it stands in for.** There is
      // nothing to refresh into: the numbers are a record, the screen patches
      // nothing, and a timer that repainted an unchanging page every five
      // seconds would be a phone kept awake for nothing. The way out of this
      // screen is a reload, and the screen says so.
      outside = { standing: outsideOf(mine.status), view: 'lastSeen' }
      draw({ view: 'lastSeen' })
      void install()
      return
    }
  }
  // No session: the pairing screen, whatever path was asked for. Replacing the
  // address rather than keeping it, so a reload after pairing lands on a real
  // screen rather than back here.
  outside = { standing: outsideOf(mine.status), view: 'pair' }
  draw({ view: 'pair' })
  if (location.pathname !== '/pair') history.replaceState(null, '', '/pair')
  void install()
}

/**
 * Register or refresh the shell, and clear a kept view nobody may keep.
 *
 * Both halves run whatever the answer was. The second is the quiet one: a
 * machine that has turned the last view off clears what is on the disk the
 * next time that phone reaches it, which is the same *told, not assumed* rule
 * the uninstalling worker is.
 */
async function install() {
  if (held.shell !== null && held.shell.keepsView !== true) await forgetView()
  // One word in, one bar out: `update` puts the offer up, `gone` takes it
  // down — the second is the uninstalling worker saying it has removed this
  // device's copy, which must not leave an offer to reload behind it.
  const how = await startInstall(held.shell, (what) => {
    newer = what === 'update'
    paint()
  })
  // Said only where the machine offers it: a browser that refuses something
  // nobody was offering is not a thing to put a bar up about.
  const offering = held.shell?.install === true
  refused = offering && (how === 'insecure' || how === 'cannot') ? how : null
  paint()
  // The subscription this browser already holds, told again on every visit —
  // never a new one and never a prompt (`push.js`'s `resend`) — and, while
  // somebody has this page in front of them, that this phone need not buzz.
  if (outside === null) {
    void resend(held.shell, ask)
    looking(held.shell, ask)
  }
}

start().catch(() => {
  // The one failure this cannot draw around: the shell is up and the first
  // request did not finish. Said in the page's own words rather than left blank.
  document.body.replaceChildren(
    el('main', { attrs: { id: 'main' } }),
    el('p', { class: 'empty', text: 'Tade isn’t answering · Reload this page' }),
  )
})

// The entry: it decides which of two pages this is — pair this device, or the
// overview — and holds **one** stream for it.
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
import { bellOf } from './bell.js'
import { answersWith } from './conversation.js'
import { classOn, el, textIn } from './dom.js'
import { forget, startInstall, takeUpdate } from './install.js'
import { backoffAt, connectionOf, outsideOf, standingOf } from './live.js'
import { wantsAnywhere } from './machines.js'
import { countsOf, forgetView, lastSeenScreen, readView, saveView } from './offline.js'
import { nowScreen } from './pages/overview.js'
import { pairScreen } from './pair.js'
import { passkeys } from './passkey.js'
import { looking, resend } from './push.js'
import { restarter } from './restart.js'
import { roomOn } from './room.js'
import { PAGE_OF, viewOf } from './routes.js'
import {
  barsFor,
  barsIn,
  crossing,
  endingBar,
  freshIn,
  heldOn,
  insideIn,
  machinesIn,
  nowhereScreen,
  shell,
  titleFor,
} from './shell.js'
import { shellBars } from './shell-bars.js'
import {
  applyCopy,
  applyDelta,
  applySnapshot,
  asOf,
  emptyStore,
  streamPath,
  wantingIds,
} from './store.js'
import { offerFull, typing } from './switch.js'

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

// A call's whole answer is asked for with the same `ask` as everything else.
answersWith(ask)

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
   * session that ended yesterday. A passkey made or a notification turned on
   * asks again, which is the moment it changed.
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

// Restarting Tade from the restart bar (`restart.js`): the person's own phone's.
const restarting = restarter(ctx, () => paint())

// The frame: built once, after the context it sends through, and patched on
// every paint like the screen.
const shown = shell()
// Notifications to this device, a press in the header (`bell.js`).
const bell = bellOf(
  ctx,
  () => held.shell,
  () => paint(),
)
shown.again.before(bell.node)

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
/** Whether the machine's Tade runs older code than its own files, until restarted. */
let restart = false
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
  lastSeen: () => lastSeenScreen(held.lastView ?? {}, Date.now()),
  pair: () => pairScreen(ctx),
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
    // A path this page does not draw — the full view at `/draw/`, an agent
    // opened in it — is a document of its own, which the browser goes to.
    if (viewOf(href.replace(/[?#].*$/, '')).view === 'nowhere') return
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
  // Each machine's up or down, in the header: this one is up while the stream is.
  if (outside === null) machinesIn(shown, held.store, standing === 'live')
  // The page's own standing, as two classes the stylesheet draws from: a
  // shimmer where figures will be before anything was read, and a line
  // sweeping under the header while the machine is asked again.
  classOn(document.body, 'is-loading', outside === null && !held.store.had)
  classOn(
    document.body,
    'is-reconnecting',
    standing === 'reconnecting' || standing === 'connecting',
  )
  // The icon's badge is what wants you on every machine that is up, whatever
  // the chips pick (`wantsAnywhere`): it sits outside the page.
  badgeIn(outside === null && held.store.had ? wantsAnywhere(held.store) : 0)
  keep(now)
  const view = {
    store: held.store,
    standing,
    asOf: clock.at,
    frozen: clock.frozen,
    now,
    where,
    // What this device may ask for, read once a paint rather than per row.
    may: {
      // **A drawing hint and never an authority.** Every paired device may
      // act, but one paired in the clear (`you.clear`) never does, so its
      // controls are *absent* rather than drawn and refused — and the machine
      // re-asks every part of it at the act anyway: the setting, the origin,
      // the passkey and the state the screen said.
      acts: actsOf(held.session),
    },
  }
  screen?.update(view)
}

/**
 * The bars the shell raises about the page itself, after the session's: how
 * long it has, its passkey, and then `shellBars` — a copy refused, code newer
 * than what answers, the page changed, a new version ready.
 */
function offered() {
  const said = []
  const ending = endingBar(held.session?.until, Date.now())
  if (ending !== null && outside === null) said.push(ending)
  if (outside === null) {
    said.push(...proving.bars(held.session))
    proving.ready()
    said.push(...bell.bars())
  }
  said.push(
    ...shellBars(
      { refused, restart, restarting: restarting.standing(), changed, newer },
      {
        reload: () => location.reload(),
        update: () => void takeUpdate(),
        restart: () => restarting.press(),
      },
    ),
  )
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
  // Saying which copy of each other machine it holds, so one it has is not sent again.
  source = new EventSource(streamPath(held.store))
  source.addEventListener('open', () => {
    seen = { ...seen, open: true, lastAt: Date.now() }
    tries = 0
    // A Tade that answers again says for itself whether a restart is owed.
    restart = false
    restarting.back()
    paint()
  })
  source.addEventListener('snapshot', (event) => took(event, applySnapshot))
  source.addEventListener('delta', (event) => took(event, applyDelta))
  // Another machine of the person's, as this door holds it: only ever sent to their own device.
  source.addEventListener('machine', (event) => took(event, applyCopy))
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
    source?.close()
    // Closing because it was asked from here to start again: it is coming back.
    if (restarting.going()) {
      restarting.ended()
      seen = { ...seen, open: false }
      setTimeout(() => void again(), backoffAt(tries))
      paint()
      return
    }
    seen = { ...seen, ended: toldIn(event.data, 'Tade is closing, so this stream is ending') }
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
    if (!typing()) {
      location.reload()
      return
    }
    changed = true
    paint()
  })
  source.addEventListener('restart', () => {
    alive()
    restart = true
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
  await forgetView()
  await forget()
  go('/pair', { replace: true, reload: true })
}

async function start() {
  held.ticket = ticketIn()
  // The sprite the icons are drawn from stays: it is in the shell so that no
  // module has to spell the SVG namespace (`icons.js`).
  const sprite = document.querySelector('svg.sprite')
  document.body.replaceChildren(...[sprite, ...shown.parts].filter((one) => one !== null))
  wireLinks()
  const mine = await ask('GET', '/api/devices')
  if (mine.status === 200 && mine.body !== null) {
    tookDevices(mine.body)
    draw(viewOf(location.pathname))
    wireBeat()
    openStream()
    // The full view, where the machine draws a window to share (`switch.js`).
    void offerFull(shown.modes, () => outside === null)
    // After the first draw, never before it: registering a worker is a network
    // round trip and a snapshot is what somebody opened this for. The machine
    // says whether to, and saying no still brings an existing registration up
    // to date — which is the one moment a phone can be told this was turned
    // off.
    void install()
    return
  }
  // **Unreachable is not signed out**, and the difference is the whole of what
  // a kept view is for: anything but a `401` or `403` is a machine that did
  // not answer as itself (`outsideOf`) — nothing, or a proxy's `502` while
  // Tade restarts behind it — and if this device kept a few counts they are
  // what it last knew. Timestamped, with nothing on it that can be pressed;
  // with none kept, the same screen without them.
  if (outsideOf(mine.status) === 'unreachable') {
    held.lastView = await readView()
    // **No beat, like the pairing screen it stands in for.** There is nothing
    // to refresh into: the numbers are a record and the screen patches
    // nothing. What runs is the one question — does the machine answer yet —
    // on the stream's own backoff, and an answer is a reload into whichever
    // screen it calls for (`askAgain`).
    outside = { standing: 'unreachable', view: 'lastSeen' }
    draw({ view: 'lastSeen' })
    askAgain(0)
    void install()
    return
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
 * Ask the machine again whether it answers, on the stream's backoff
 * (`backoffAt`), while it does not: the first answer that is Tade's own — a
 * session, or a `401`/`403` saying pair first — reloads the page into that
 * screen, which is a boot from the start rather than a second set of
 * listeners on this one.
 */
function askAgain(tried) {
  setTimeout(async () => {
    // `ask` never throws: no answer is a `0`, which is asked again like a `502`.
    const mine = await ask('GET', '/api/devices')
    if (mine.status === 200 || outsideOf(mine.status) === 'unpaired') {
      globalThis.location.reload()
      return
    }
    askAgain(tried + 1)
  }, backoffAt(tried))
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
    void bell.read()
  }
}

// The keyboard's room is the page's whatever it draws: the pairing field is typed in too.
roomOn()

start().catch(() => {
  // The one failure this cannot draw around: the shell is up and the first
  // request did not finish. Said in the page's own words rather than left blank.
  document.body.replaceChildren(
    el('main', { attrs: { id: 'main' } }),
    el('p', { class: 'empty', text: 'Tade isn’t answering · Reload this page' }),
  )
})

// The full view: the window itself, drawn by the phone (§10 T4 of the Duo
// plan). This is the page at `/draw/`, whose import map loads the window's own
// drawing — `view.ts`, the panels, the hit map, the keymap — and it runs that
// drawing on the state the machine sends (`far.ts`), at this screen's size, in
// Tade's tones. Nothing here draws a row the window did not: the rows are
// `FarFace.draw`'s, put into the DOM by `full-grid.js`.
//
// What happens on the phone, at once: drawing at its size and drawing again on
// a rotate, a fold or the keyboard rising (`ResizeObserver` and
// `visualViewport`); a tap, a swipe and a key, answered by the window's own
// face (`FarFace`); opening a link and copying a selection, which the machine
// says it cannot do for a phone (`ON_A_PHONE`). What crosses: where this phone
// looks and how big it is (`POST /api/window/look`), and what the window would
// *do*, one act each (`POST /api/window/act`) — answered on the stream the
// overview reads too, as `window` frames.
//
// **When the machine cannot be reached the last window stays**, marked stale
// over its foot (`FarFace.lost`), and the page asks again on the same bounded
// backoff as the overview (`live.js`); a frame it could not build on asks for
// the window whole.

import { el, into, textIn } from './dom.js'
import { fitOf } from './full-fit.js'
import { gridOn, safeLink } from './full-grid.js'
import { keysOn } from './full-keys.js'
import { touchOn } from './full-touch.js'
import { backoffAt } from './live.js'
import { MODES, modeNow, orientationOf } from './mode.js'
import { modeSwitch } from './switch.js'

/** How often a look is renewed while the page is open: well inside the window's `LOOK_MS`. */
const RENEW_MS = 8_000

const held = {
  csrf: null,
  /** The window's own drawing, once it has loaded: `browser.ts`'s namespace. */
  tade: null,
  face: null,
  last: null,
  fit: null,
  /** Acts in the order they were pressed, one after another. */
  sending: Promise.resolve(),
  tries: 0,
  source: null,
  drawing: false,
  /**
   * The agent the overview opened this page on (`/draw/?agent=<id>`, §10 T5
   * of the Duo plan), until the first window has arrived to open it in.
   */
  opening: agentAsked(),
}

/** The agent named in the address, taken out of it as it is read so a reload does not open it again. */
function agentAsked() {
  const asked = new URLSearchParams(location.search).get('agent')
  if (location.search !== '') history.replaceState(history.state, '', location.pathname)
  return asked === null || asked === '' ? null : asked
}

/* ── the page ─────────────────────────────────────────────────────────────── */

const top = el('header', { class: 'fv-top' })
const said = el('p', { class: 'fv-said', attrs: { role: 'status' } })
const copy = el('button', { class: 'fv-tap', text: 'Copy', attrs: { type: 'button' } })
const done = el('button', { class: 'fv-tap', text: 'Done', attrs: { type: 'button' } })
const typeButton = el('button', {
  class: 'fv-tap',
  text: 'Type',
  attrs: { type: 'button', 'aria-label': 'Show the keyboard' },
})
copy.hidden = true
done.hidden = true
into(top, modeSwitch('full'), said, copy, done, typeButton)
const room = el('main', { class: 'fv-room', attrs: { id: 'main' } })
const grid = gridOn(room)
const row = el('nav', { class: 'fv-keys', attrs: { 'aria-label': 'Keys' } })
document.body.replaceChildren(top, room, row)
document.body.classList.add('fv')
const keys = keysOn(row, document.body, (bytes) => key(bytes))

/** A word in the bar: what the page is doing, or what went wrong, in its own sentence. */
function say(words) {
  textIn(said, words)
}

/* ── talking to the machine ───────────────────────────────────────────────── */

async function ask(method, path, body) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (held.csrf !== null) headers['x-tade-csrf'] = held.csrf
  try {
    const answer = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    let got = null
    try {
      got = await answer.json()
    } catch (problem) {
      // An answer that is not JSON is still its status; what it was is said
      // where a refusal is, so a broken answer is never a silent one.
      got = { said: `The machine’s answer could not be read: ${String(problem).slice(0, 120)}` }
    }
    return { status: answer.status, body: got }
  } catch (problem) {
    // Unreachable, which is a state and not an exception: said with its why.
    return {
      status: 0,
      body: { said: `The machine is not answering: ${String(problem).slice(0, 120)}` },
    }
  }
}

/** Where this phone looks and how big it is; `whole` asks for the window whole. */
async function look(whole = false) {
  if (held.face === null || held.fit === null) return
  const answer = await ask('POST', '/api/window/look', {
    own: held.face.looking() ?? undefined,
    columns: held.fit.columns,
    rows: held.fit.rows,
    rev: whole ? null : held.face.rev,
  })
  if (answer.status === 401 || answer.status === 403) location.replace('/pair')
  else if (answer.status === 404) {
    say('This machine draws no window to share: its Tade has no window open.')
  } else if (answer.status !== 200) say(refusalOf(answer))
}

/** One act: what the window would do, in the order it was pressed. */
function act(intent) {
  const own = held.face?.looking() ?? undefined
  held.sending = held.sending.then(async () => {
    const answer = await ask('POST', '/api/window/act', { key: keyOf(), intent, own })
    if (answer.status !== 200) say(refusalOf(answer))
  })
}

/** Tade's own sentence for a refusal, or the page's for one it cannot name. */
function refusalOf(answer) {
  if (typeof answer.body?.said === 'string') return answer.body.said
  if (answer.status === 0) return 'The machine is not answering.'
  if (typeof answer.body?.error === 'string') return `Refused: ${answer.body.error}`
  return 'Something went wrong here.'
}

/** A fresh idempotency key, out of this browser's own randomness. */
function keyOf() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().replaceAll('-', '')
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((one) => one.toString(16).padStart(2, '0')).join('')
}

function openStream() {
  const source = new EventSource('/api/stream')
  held.source = source
  source.addEventListener('open', () => {
    held.tries = 0
    say('')
    // What arrived while the stream was down is not here: the window whole.
    void look(true)
  })
  source.addEventListener('window', (event) => {
    let message = null
    try {
      message = JSON.parse(event.data)
    } catch (problem) {
      say(`A frame from the machine could not be read: ${String(problem).slice(0, 120)}`)
      return
    }
    if (held.face === null) return
    if (!held.face.take(message)) void look(true)
    else if (held.opening !== null) opened()
    soon()
  })
  source.addEventListener('revoked', () => {
    source.close()
    location.replace('/pair')
  })
  const lost = (words) => {
    held.face?.lost(Date.now())
    say(words)
    soon()
  }
  source.addEventListener('notice', () => {
    source.close()
    lost('Tade is closing on the machine.')
    setTimeout(openAgain, backoffAt(held.tries))
  })
  source.addEventListener('too_many', () => {
    source.close()
    lost('This device has too many pages of Tade open.')
  })
  source.addEventListener('error', () => {
    if (source.readyState !== 2) return
    source.close()
    lost('Reconnecting…')
    setTimeout(openAgain, backoffAt(held.tries))
  })
}

function openAgain() {
  held.tries += 1
  openStream()
}

/** The agent the overview asked for, opened as a tap on its row would open it. */
function opened() {
  const task = held.opening
  held.opening = null
  const press = held.face.open(task)
  if (press.intents.length === 0 && !press.draw) say('That agent is not in the window any more.')
  pressed(press)
}

/* ── drawing ──────────────────────────────────────────────────────────────── */

/** Draw on the next frame the browser paints, once however often it is asked. */
function soon() {
  if (held.drawing) return
  held.drawing = true
  requestAnimationFrame(() => {
    held.drawing = false
    paint()
  })
}

function paint() {
  const { tade, face, fit } = held
  if (tade === null || face === null || fit === null) return
  const drawn = face.draw(
    { width: fit.columns, height: fit.rows, skin: tade.skin.COLOUR, now: Date.now() },
    held.last,
  )
  if (drawn === null) return
  grid.paint(drawn.rows)
  copy.hidden = !selecting()
  done.hidden = !selecting()
}

/** Fit the window to the room it has now; a new size is told to the machine. */
function refit() {
  const box = room.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return
  const measured = grid.measure()
  const screen = { width: globalThis.innerWidth, height: globalThis.innerHeight }
  const fit = fitOf({ width: box.width, height: box.height, screen, ...measured })
  const was = held.fit
  held.fit = fit
  grid.size(fit)
  held.face?.holdSidebar(fit.sidebar)
  document.body.classList.toggle('fv-book', fit.book)
  held.last = held.tade === null ? null : new held.tade.LastFrame()
  if (was === null || was.columns !== fit.columns || was.rows !== fit.rows) void look()
  soon()
}

/* ── what a finger and a key do ───────────────────────────────────────────── */

/** What a press came to: send what it asks, tell where it moved, draw. */
function pressed(press) {
  for (const intent of press.intents) act(intent)
  if (press.looked) void look()
  if (press.draw) soon()
}

function key(bytes) {
  if (held.face === null) return
  if (selecting()) stopSelecting()
  pressed(held.face.key(bytes))
}

function selecting() {
  return document.body.classList.contains('fv-selecting')
}

/** A long press: the row under the finger selected, for the phone's handles to widen. */
function startSelecting(clientX, clientY) {
  const cell = grid.cellAt(clientX, clientY)
  const line = cell === null ? null : grid.rowAt(cell.y)
  if (line === null) return
  document.body.classList.add('fv-selecting')
  const selection = globalThis.getSelection()
  selection?.selectAllChildren(line)
  copy.hidden = false
  done.hidden = false
}

function stopSelecting() {
  document.body.classList.remove('fv-selecting')
  globalThis.getSelection()?.removeAllRanges()
  copy.hidden = true
  done.hidden = true
}

copy.addEventListener('click', async () => {
  const text = String(globalThis.getSelection() ?? '').replace(/\s+$/gm, '')
  try {
    await navigator.clipboard.writeText(text)
    say('Copied.')
  } catch (problem) {
    say(
      `This browser would not let the page copy (${String(problem).slice(0, 80)}): hold the selection and copy from its menu.`,
    )
    return
  }
  stopSelecting()
})
done.addEventListener('click', stopSelecting)
typeButton.addEventListener('click', () => {
  if (keys.up()) keys.drop()
  else keys.raise()
})

touchOn(grid.node, {
  cellAt: (x, y) => grid.cellAt(x, y),
  rowPx: () => grid.rowPx(),
  selecting,
  longPress: startSelecting,
  tap: (clientX, clientY, cell, clicks) => {
    if (held.face === null) return
    // A link drawn as one is this phone's to open, wherever it is.
    const drawnLink = grid.linkAt(clientX, clientY)
    if (drawnLink !== null) {
      open(drawnLink)
      return
    }
    if (cell === null) return
    const tapped = held.face.tap(cell.x, cell.y, { clicks })
    if (tapped.link !== undefined) {
      open(tapped.link)
      return
    }
    pressed(tapped)
  },
  swipe: (x, y, rows) => {
    if (held.face !== null) pressed(held.face.swipe(x, y, rows))
  },
})

/** A link, opened on this phone: never in this page, which is the window. */
function open(url) {
  const safe = safeLink(url)
  if (safe === null) {
    say('That link is not one this page opens.')
    return
  }
  globalThis.open(safe, '_blank', 'noopener,noreferrer')
}

/* ── starting ─────────────────────────────────────────────────────────────── */

/** The overview, when the way up the screen is held says so: a phone turned upright. */
function followMode() {
  let way = orientationOf(globalThis.innerWidth, globalThis.innerHeight)
  addEventListener('resize', () => {
    const now = orientationOf(globalThis.innerWidth, globalThis.innerHeight)
    if (now === way) return
    way = now
    if (modeNow(globalThis.innerWidth, globalThis.innerHeight) === 'overview') {
      location.assign(MODES.overview)
    }
  })
}

async function start() {
  say('Loading the window…')
  const mine = await ask('GET', '/api/devices')
  if (mine.status === 401 || mine.status === 403) {
    location.replace('/pair')
    return
  }
  if (mine.status !== 200 || mine.body === null) {
    say('The machine is not answering. Reload this page to try again.')
    return
  }
  held.csrf = mine.body.you?.csrf ?? null
  const root = document.querySelector('meta[name="tade-drawing"]')?.getAttribute('content') ?? ''
  held.tade = await import(root)
  held.tade.setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  held.face = new held.tade.FarFace({ machine: 'the machine' })
  followMode()
  new ResizeObserver(() => refit()).observe(room)
  globalThis.visualViewport?.addEventListener('resize', () => {
    document.documentElement.style.setProperty(
      '--fv-room',
      `${Math.round(globalThis.visualViewport.height)}px`,
    )
    refit()
  })
  refit()
  openStream()
  setInterval(() => void look(), RENEW_MS)
  void colours()
}

/**
 * Code coloured as the machine colours it: highlight.js's core and the
 * languages the window knows, through the same import map, registered after
 * the first draw so the window is not waiting on a language list.
 */
async function colours() {
  const map = JSON.parse(document.querySelector('script[type="importmap"]')?.textContent ?? '{}')
  const mapped = map.imports ?? {}
  // Through a variable: a bare specifier is the import map's to resolve.
  const load = (specifier) => import(specifier)
  try {
    const core = (await load('highlight.js/lib/core')).default
    for (const language of held.tade.languagesNamed()) {
      const specifier = `highlight.js/lib/languages/${language}`
      if (specifier in mapped) core.registerLanguage(language, (await load(specifier)).default)
    }
    held.tade.colourWith(() => core)
    held.last = new held.tade.LastFrame()
    soon()
  } catch (problem) {
    // Code is plain where highlight.js did not load, as on a machine without
    // it — and said, so plain code is never mistaken for the colours.
    say(`Code is drawn plain here: highlight.js did not load (${String(problem).slice(0, 80)}).`)
  }
}

start().catch((problem) => {
  say(`The window could not be drawn here: ${String(problem).slice(0, 160)}`)
})

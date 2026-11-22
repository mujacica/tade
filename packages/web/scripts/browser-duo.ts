import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Outcome, WebActing } from '../src/acting.ts'
import { GRANTS, type Reach } from '../src/reach.ts'
import { projector } from '../src/reading.ts'
import { webServer } from '../src/server.ts'
import { OFF } from '../src/surface.ts'
import { Tickets } from '../src/tickets.ts'
import {
  DUO,
  DUO_LOOKS,
  type DuoLook,
  type DuoScreen,
  type Insets,
  insetsAsVars,
} from '../test/browser-duo-plan.ts'
import { exitFor, type Finding, said, sayReport, worstOf } from '../test/browser-plan.ts'
import { agentHeld, input, NOW, settingRows } from '../test/fixtures.ts'
import { harnessTalk } from './browser-chat.ts'
import { DUO_SHAPE } from './browser-snippets.ts'

// The away view on Amir's foldable iPhone Duo, in WebKit, at the four sizes it
// is held at: the outer screen upright and sideways, the inner one upright and
// sideways (`DUO` in `test/browser-plan.ts`), and the fold opened as a live
// resize, which is how iOS hands a page the other screen.
//
//   node packages/web/scripts/browser-duo.ts                  # report to stdout
//   node packages/web/scripts/browser-duo.ts --shots <dir>    # and a picture of each
//
// **WebKit, because the phone is WebKit**: Chromium lays a grid or a `dvh` out
// a pixel differently, and a 44px button that is 43.6 in Safari is the one a
// thumb misses. Playwright is optional on the machine, as for `browser.ts`, and
// so is its WebKit (`pnpm exec playwright install webkit`); without either
// every check is `unrun` with the reason.
//
// **The insets are the phone's own**, the camera column and the home
// indicator, and no browser engine emulates `env(safe-area-inset-*)`. So each
// stylesheet is answered through the route with every `env(safe-area-inset-x)`
// turned into a custom property, set on the root at the screen's numbers before
// the page draws: the stylesheets laid out are the shipped ones with nothing
// else changed, and a rule that forgot its inset is drawn under the band.
//
// Every page is looked at for a device granted everything, because the person's
// phone is: a dash fits anywhere and a figure is what runs off an edge.

const PLAYWRIGHT = 'playwright'

/** The parts of Playwright this asks for, typed here so it type-checks without it. */
export interface Playwright {
  webkit: { launch: (opts: object) => Promise<Engine> }
}

interface Engine {
  newContext: (opts: object) => Promise<Context>
  close: () => Promise<void>
}

interface Context {
  newPage: () => Promise<Page>
  route: (match: string, answer: (route: Route) => Promise<void>) => Promise<void>
  addInitScript: (script: { content: string }) => Promise<void>
  storageState: () => Promise<object>
  close: () => Promise<void>
}

interface Route {
  request: () => { url: () => string }
  fetch: () => Promise<{ text: () => Promise<string>; headers: () => Record<string, string> }>
  fulfill: (opts: object) => Promise<void>
}

interface Page {
  on: (event: 'pageerror', hear: (problem: unknown) => void) => void
  goto: (url: string, opts?: object) => Promise<unknown>
  fill: (selector: string, value: string) => Promise<void>
  click: (selector: string) => Promise<void>
  focus: (selector: string) => Promise<void>
  waitForSelector: (selector: string, opts?: object) => Promise<unknown>
  waitForURL: (url: string, opts?: object) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
  evaluate: (body: string) => Promise<unknown>
  screenshot: (opts: object) => Promise<unknown>
  setViewportSize: (size: { width: number; height: number }) => Promise<void>
}

/** What `DUO_SHAPE` answers about one screen as drawn. */
export interface DuoShape {
  /** How much wider than the screen the document, or the screen's own column, is. */
  sideways: number
  /** Content that reaches past the screen's left or right edge. */
  off: string[]
  /** Content whose visible part is under a band: the camera column, the status bar, the home indicator. */
  under: string[]
  /** A press under 44 px on either side. */
  small: string[]
  /** A press a tap at its middle does not reach: something else is drawn over it. */
  covered: string[]
  /** Words given no room, a letter or two to a line. */
  squeezed: string[]
  /** With a field focused: whether it and the header are wholly in the room above the keyboard. */
  typing: { field: boolean; head: boolean } | null
}

const shots = (() => {
  const at = process.argv.indexOf('--shots')
  return at === -1 ? null : (process.argv[at + 1] ?? null)
})()

/** The window, answering every verb, so a granted device draws every control. */
const answering: WebActing = {
  unlocked: () => true,
  park: (call) => did(call),
  answer: (call) => did(call),
  steer: (call) => did(call),
  queue: (call) => did(call),
  done: (call) => did(call),
  note: (call) => did(call),
  context: (call) => did(call),
  intake: (call) => did(call),
  stop: (call) => did(call),
  reopen: (call) => did(call),
  close: (call) => did({ was: call.was }),
  open: (call) => did({ was: call.was }),
}

function did(call: { was: string }): Promise<Outcome> {
  return Promise.resolve({ did: true, rev: call.was, said: 'done' })
}

async function serve() {
  const home = await mkdtemp(join(tmpdir(), 'tade-away-duo-'))
  const tickets = new Tickets()
  const held = new Map<string, ReturnType<typeof projector>>()
  const server = webServer({
    home,
    surface: { ...OFF, enabled: true, port: 0, acting: true, talking: true, keepsView: true },
    acting: answering,
    asking: {
      unlocked: () => true,
      ask: (call) => Promise.resolve({ did: true, rev: call.was, said: 'Tade is answering' }),
      stop: (call) => Promise.resolve({ did: true, rev: call.was, said: 'stopped' }),
    },
    readingFor: (reach: Reach) => {
      const mine = held.get(reach.device)
      if (mine !== undefined) return mine
      const made = projector(input({ reach, talk: harnessTalk(12) }), NOW, {
        agent: () => agentHeld(),
        settings: () => ({ groups: settingRows(), known: [] }),
      })
      held.set(reach.device, made)
      return made
    },
    tickets,
    tell: () => {},
    confirm: async () => ({ let: true, projects: null, granted: [...GRANTS] }),
  })
  const bound = await server.listen()
  const at = bound.find((one) => one.startsWith('127.0.0.1'))
  if (at === undefined) throw new Error(`nothing bound on loopback: ${bound.join(', ')}`)
  return { server, origin: `http://${at}`, tickets }
}

/**
 * A context shaped as the phone: its size, @3x, a touch screen that lays the
 * page out as a phone does, and every stylesheet answered with its insets as
 * custom properties (`insetsAsVars`). No service worker, so the route is what
 * answers and not a cache.
 */
async function phoneAt(engine: Engine, screen: DuoScreen, state?: object): Promise<Context> {
  const context = await engine.newContext({
    viewport: { width: screen.width, height: screen.height },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
    ...(state === undefined ? {} : { storageState: state }),
  })
  await context.route('**/assets/**/*.css', async (route) => {
    const answer = await route.fetch()
    await route.fulfill({
      status: 200,
      headers: { ...answer.headers(), 'cache-control': 'no-store' },
      body: insetsAsVars(await answer.text()),
    })
  })
  await context.addInitScript({ content: insetsScript(screen) })
  await context.addInitScript({ content: KEYBOARD })
  return context
}

/** The screen's insets on the root, before anything draws. */
function insetsScript(screen: DuoScreen): string {
  const { top, right, bottom, left } = screen.insets
  return `(() => { const put = () => { const root = document.documentElement; if (!root) return false;
    root.style.setProperty('--duo-inset-top', '${top}px');
    root.style.setProperty('--duo-inset-right', '${right}px');
    root.style.setProperty('--duo-inset-bottom', '${bottom}px');
    root.style.setProperty('--duo-inset-left', '${left}px'); return true }
    if (!put()) document.addEventListener('DOMContentLoaded', put) })()`
}

/**
 * **The keyboard, as iOS raises it**: the window keeps its height and the
 * visual viewport shrinks to the room above the keyboard, saying so with a
 * `resize`. No engine on a Mac raises one, so the visual viewport is stood in
 * for with one that does exactly that, and `__duoKeyboard(px)` raises it —
 * which is the path the page's own `room.js` reads on the phone.
 */
const KEYBOARD = `(() => {
  const view = new EventTarget()
  let covered = 0
  const said = {
    width: () => innerWidth, height: () => innerHeight - covered, offsetTop: () => 0,
    offsetLeft: () => 0, pageTop: () => scrollY, pageLeft: () => scrollX, scale: () => 1,
  }
  for (const [name, read] of Object.entries(said)) Object.defineProperty(view, name, { get: read })
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => view })
  window.__duoKeyboard = (px) => { covered = px; view.dispatchEvent(new Event('resize')) }
})()`

async function pairIn(page: Page, origin: string, ticket: string): Promise<void> {
  await page.goto(`${origin}/pair#t=${ticket}`, { waitUntil: 'load' })
  await page.waitForSelector('#label', { timeout: 10_000 })
  await page.fill('#label', 'the duo')
  await page.click('button.pair-press')
  await page.waitForURL(`${origin}/`, { timeout: 15_000 })
  await page.waitForSelector('header .brand', { timeout: 10_000 })
}

/**
 * Open a look the way a person arrives at it, and do what it says before
 * measuring. False where the size draws no press for it.
 */
async function open(page: Page, origin: string, look: DuoLook, path = look.path): Promise<boolean> {
  await page.goto(`${origin}${path}`, { waitUntil: 'load' })
  await page.waitForSelector(look.ready ?? 'main', { timeout: 10_000 })
  if (look.press !== undefined) {
    const drawn = await page.evaluate(
      `document.querySelector(${JSON.stringify(look.press)})?.checkVisibility() === true`,
    )
    if (drawn !== true) return false
    await page.click(look.press)
  }
  if (look.focus !== undefined) await page.focus(look.focus)
  // A screen rises in; its tiles follow. Measured once it has stopped moving.
  await page.waitForTimeout(400)
  return true
}

function judge(found: Finding[], where: string, shape: DuoShape): void {
  const say = (check: string, bad: string[], good: string) =>
    found.push(
      bad.length > 0
        ? { check, where, verdict: 'fail', said: bad.slice(0, 4).join('; ') }
        : { check, where, verdict: 'pass', said: good },
    )
  say(
    'sideways',
    shape.sideways > 1 ? [`${shape.sideways}px wider than the screen`, ...shape.off] : shape.off,
    'nothing runs off an edge',
  )
  say('insets', shape.under, 'nothing under the camera, the status bar or the home indicator')
  say('targets', shape.small, 'every press is at least 44 by 44')
  say('covered', shape.covered, 'every press is what a tap at its middle reaches')
  say('squeezed', shape.squeezed, 'no words squeezed a letter to a line')
  if (shape.typing !== null) {
    say(
      'keyboard',
      [
        shape.typing.field ? '' : 'the field is not wholly above the keyboard',
        shape.typing.head ? '' : 'the header is pushed off the screen',
      ].filter((one) => one !== ''),
      'the field and the header both in the room above the keyboard',
    )
  }
}

async function measure(page: Page, insets: Insets, room: number | null = null): Promise<DuoShape> {
  return (await page.evaluate(DUO_SHAPE(insets, room))) as DuoShape
}

/** A picture of what is on the glass: with the keyboard up, the room above it. */
async function picture(page: Page, name: string, room?: { width: number; height: number }) {
  if (shots === null) return
  await mkdir(shots, { recursive: true })
  const clip = room === undefined ? {} : { clip: { x: 0, y: 0, ...room } }
  await page.screenshot({ path: join(shots, `${name}.png`), ...clip })
}

/** One look at one screen: opened, measured, and its picture taken. */
async function lookAt(
  page: Page,
  origin: string,
  screen: DuoScreen,
  look: DuoLook,
  found: Finding[],
  path?: string,
): Promise<void> {
  const where = `${look.name} @ ${screen.name}`
  try {
    if (!(await open(page, origin, look, path))) {
      found.push({ check: 'drawn', where, verdict: 'pass', said: 'no such press at this size' })
      return
    }
    if (look.keyboard === true) {
      await page.evaluate(`window.__duoKeyboard(${screen.keyboard})`)
      await page.waitForTimeout(300)
      // The keyboard covers the home indicator: the room's foot is its top.
      const room = screen.height - screen.keyboard
      judge(found, where, await measure(page, { ...screen.insets, bottom: 0 }, room))
      await picture(page, `${screen.name}-${look.name}`, { width: screen.width, height: room })
      await page.evaluate('window.__duoKeyboard(0)')
      return
    }
    judge(found, where, await measure(page, screen.insets))
    await picture(page, `${screen.name}-${look.name}`)
  } catch (problem) {
    found.push({ check: 'drawn', where, verdict: 'fail', said: said(problem) })
  }
}

/** Every look at one screen, on a device already paired. */
async function lookAll(
  engine: Engine,
  origin: string,
  screen: DuoScreen,
  state: object,
  found: Finding[],
): Promise<void> {
  const context = await phoneAt(engine, screen, state)
  const page = await context.newPage()
  const noise: string[] = []
  page.on('pageerror', (problem) => noise.push(said(problem)))
  try {
    for (const look of DUO_LOOKS) {
      if (look.paired !== false) await lookAt(page, origin, screen, look, found)
    }
    found.push(
      noise.length > 0
        ? {
            check: 'quiet',
            where: screen.name,
            verdict: 'fail',
            said: noise.slice(0, 2).join('; '),
          }
        : { check: 'quiet', where: screen.name, verdict: 'pass', said: 'nothing thrown' },
    )
  } finally {
    await context.close()
  }
}

/**
 * The fold, opened and closed with the page up: the outer screen's size and
 * insets, then the inner one's, then back, each as a resize and never a load.
 */
async function folded(
  engine: Engine,
  origin: string,
  state: object,
  found: Finding[],
): Promise<void> {
  const outer = DUO.find((one) => one.name === 'outer-upright')
  const inner = DUO.find((one) => one.name === 'inner-landscape')
  if (outer === undefined || inner === undefined) return
  const context = await phoneAt(engine, outer, state)
  const page = await context.newPage()
  try {
    for (const look of DUO_LOOKS) {
      if (look.keyboard === true || look.paired === false || look.press !== undefined) continue
      await open(page, origin, look)
      for (const screen of [inner, outer]) {
        await page.setViewportSize({ width: screen.width, height: screen.height })
        await page.evaluate(insetsScript(screen))
        await page.waitForTimeout(300)
        judge(found, `${look.name} @ folded to ${screen.name}`, await measure(page, screen.insets))
      }
    }
  } catch (problem) {
    found.push({ check: 'drawn', where: 'folded', verdict: 'fail', said: said(problem) })
  } finally {
    await context.close()
  }
}

export async function duo(playwright: Playwright | null, why = ''): Promise<Finding[]> {
  const found: Finding[] = []
  if (playwright === null) {
    return [{ check: 'duo', where: '—', verdict: 'unrun', said: why }]
  }
  let engine: Engine
  try {
    engine = await playwright.webkit.launch({ headless: true })
  } catch (problem) {
    return [
      {
        check: 'duo',
        where: '—',
        verdict: 'unrun',
        said: `WebKit could not start: ${said(problem)}`,
      },
    ]
  }
  const { server, origin, tickets } = await serve()
  try {
    // The pairing page first, as the phone sees it with the code just scanned.
    const pairing = DUO_LOOKS.find((one) => one.paired === false)
    for (const screen of DUO) {
      if (pairing === undefined) break
      const context = await phoneAt(engine, screen)
      const ticket = tickets.mint(`${origin}/pair`, Date.now()).value
      await lookAt(await context.newPage(), origin, screen, pairing, found, `/pair#t=${ticket}`)
      await context.close()
    }
    const first = DUO[0]
    if (first === undefined) return found
    const context = await phoneAt(engine, first)
    await pairIn(await context.newPage(), origin, tickets.mint(`${origin}/pair`, Date.now()).value)
    const state = await context.storageState()
    await context.close()
    for (const screen of DUO) await lookAll(engine, origin, screen, state, found)
    await folded(engine, origin, state, found)
  } finally {
    await engine.close()
    await server.close()
  }
  return found
}

async function main(): Promise<void> {
  let playwright: Playwright | null = null
  let why = ''
  try {
    playwright = (await import(PLAYWRIGHT)) as Playwright
  } catch {
    why = 'playwright is not installed on this machine'
  }
  const found = await duo(playwright, why)
  process.stdout.write(sayReport(found))
  process.exitCode = exitFor(worstOf(found))
}

if (process.argv[1] === import.meta.filename) await main()

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drawingDoor } from '@tade/web'
import { drawingFor } from '@tade/web/drawing'
import {
  type Context,
  type Engine,
  type Page,
  type Playwright,
  pairIn,
  phoneAt,
} from '../../web/scripts/browser-duo.ts'
import type { Reach } from '../../web/src/reach.ts'
import { projector } from '../../web/src/reading.ts'
import { webServer } from '../../web/src/server.ts'
import { OFF } from '../../web/src/surface.ts'
import { Tickets } from '../../web/src/tickets.ts'
import type { WindowDoor, WindowIntent } from '../../web/src/windowed.ts'
import { FULL_SIZES, type FullSize } from '../../web/test/browser-full-plan.ts'
import { exitFor, type Finding, said, sayReport, worstOf } from '../../web/test/browser-plan.ts'
import { input, NOW, task } from '../../web/test/fixtures.ts'
import { ownOf } from '../src/faces.ts'
import { farFrame, farHeart, farWhole } from '../src/far.ts'
import { focusTask, initialState, withProjects, withTasks } from '../src/model.ts'
import { drawingPlan } from '../src/wire/drawing.ts'
import { frame, tasks } from '../test/screens/scenarios/fixtures.ts'

// The full view in a real browser, at the sizes it is held at (§10 T4 of the
// Duo plan): the Duo's six and two slab iPhones each way up
// (`FULL_SIZES`), in WebKit, because the phone is WebKit.
//
//   node packages/app/scripts/browser-full.ts                 # report to stdout
//   node packages/app/scripts/browser-full.ts --shots <dir>   # and a picture of each
//
// **Everything is the shipped page but the machine's window.** The real
// server, pairing through the real page, the drawing served at `/draw/` as a
// phone is sent it, the page's own `full.js`; the window behind the door is
// scripted — every look is answered with the golden scenarios' window whole
// (`scenarios/fixtures.ts`), every act is written down — so what is measured
// is the page: that it draws the window, at how many columns, inside the
// phone's insets, with presses a thumb can hit, the sidebar's edge on the fold
// where there is one, and that a tap, the wheel, a key and the keyboard rising
// each do what they say. And the switch: the overview turned sideways goes to
// the full view, the full view turned upright goes back, and a choice is kept.
//
// A swipe is a finger's touches made in the page (`swipe`): Playwright's
// touchscreen only taps, and mobile WebKit has no wheel. Exit 0 all pass, 1
// any fail, 2 unrun — no Playwright, or no WebKit.

const PLAYWRIGHT = 'playwright'

/** The parts of a page this asks for beyond the Duo harness's. */
interface FullPage extends Page {
  url: () => string
  reload: (opts?: object) => Promise<unknown>
  touchscreen: { tap: (x: number, y: number) => Promise<void> }
}

const shots = (() => {
  const at = process.argv.indexOf('--shots')
  return at === -1 ? null : (process.argv[at + 1] ?? null)
})()

/** Where a run's home is made: beside the dependencies, and never committed. */
const SCRATCH = fileURLToPath(new URL('../../../node_modules/.cache/', import.meta.url))

/** What the scripted window was asked. */
interface Asked {
  looks: { device: string; columns: number; rows: number }[]
  acts: WindowIntent[]
}

async function serve(home: string, asked: Asked) {
  const tickets = new Tickets()
  const plan = await drawingPlan()
  // The scenarios' window, with agents enough that the sidebar scrolls on every
  // screen here, the tallest upright included: a swipe needs something to move.
  const many = Array.from({ length: 40 }, (_, at) => ({
    task: `checkout/agent-${String(at + 1).padStart(2, '0')}`,
    state: 'working' as const,
    lane: `checkout/agent-${String(at + 1).padStart(2, '0')}/agent`,
  }))
  const state = focusTask(
    withTasks(withProjects(initialState(), ['checkout', 'search', 'infra']), [...tasks, ...many]),
    'checkout/stripe-v15',
  )
  const whole = farWhole(1, farHeart(state), farFrame(frame()), ownOf(state)).message
  const held = new Map<string, ReturnType<typeof projector>>()
  let server: ReturnType<typeof webServer> | null = null
  const window: WindowDoor = {
    unlocked: () => true,
    look: (device, look) => {
      asked.looks.push({ device, columns: look.columns, rows: look.rows })
      // The window whole for a phone that holds nothing it can build on.
      if (look.rev !== 1) {
        setTimeout(() => server?.streams.window(device, whole, Date.now()), 0)
      }
      return { rev: look.rev === 1 ? 1 : null }
    },
    act: (_device, intent) => {
      asked.acts.push(intent)
      return { did: true, rev: '1', said: `window ${intent.kind}` }
    },
    leave: () => {},
  }
  server = webServer({
    home,
    surface: { ...OFF, enabled: true, port: 0, acting: true },
    readingFor: (reach: Reach) => {
      const mine = held.get(reach.device)
      if (mine !== undefined) return mine
      const made = projector(input({ reach, tasks: [task()] }), NOW)
      held.set(reach.device, made)
      return made
    },
    drawing: drawingDoor(() => drawingFor(plan)),
    window,
    tickets,
    tell: () => {},
    confirm: async () => ({ let: true }),
  })
  const bound = await server.listen()
  const at = bound.find((one) => one.startsWith('127.0.0.1'))
  if (at === undefined) throw new Error(`nothing bound on loopback: ${bound.join(', ')}`)
  return { server, origin: `http://${at}`, tickets }
}

/** What the page drew, read off the glass. */
interface Drawn {
  rows: string[]
  grid: { left: number; top: number; right: number; bottom: number; cell: number; row: number }
  room: { bottom: number }
  wide: number
  view: { width: number; height: number }
  small: string[]
  field: number
}

const READ = `(() => {
  const grid = document.querySelector('.fv-grid')
  const rows = [...document.querySelectorAll('.fv-row')].map((row) => row.textContent ?? '')
  const box = grid?.getBoundingClientRect()
  const keys = document.querySelector('.fv-keys')?.getBoundingClientRect()
  const columns = Math.max(1, ...rows.map((row) => row.length))
  const small = [...document.querySelectorAll('.fv-key, .fv-tap:not([hidden]), .fv-top .mode')]
    .filter((one) => { const b = one.getBoundingClientRect(); return b.width > 0 && (b.width < 43.5 || b.height < 43.5) })
    .map((one) => (one.textContent ?? '').trim())
  const field = document.querySelector('.fv-type')
  return {
    rows,
    grid: box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
      cell: box.width / columns, row: rows.length > 0 ? box.height / rows.length : 0 } : null,
    room: { bottom: keys ? keys.top : innerHeight },
    wide: document.documentElement.scrollWidth,
    view: { width: innerWidth, height: innerHeight },
    small,
    field: field ? Number.parseFloat(getComputedStyle(field).fontSize) : 0,
  }
})()`

/**
 * A finger put down at `x`, `y`, moved up `rise` px in steps and lifted: the
 * touches a phone sends, made in the page, because Playwright's touchscreen
 * only taps and mobile WebKit has no wheel. WebKit will not construct a
 * `Touch` from script (as iOS will not), so each is an event of the touch's
 * type carrying the points the page's handler reads. True once sent.
 */
function swipe(x: number, y: number, rise: number): string {
  return `(() => {
    const target = document.elementFromPoint(${x}, ${y})
    if (target === null) return 'nothing under the finger'
    const send = (type, dy, held) => {
      const point = { identifier: 1, target, clientX: ${x}, clientY: ${y} - dy }
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'touches', { value: held ? [point] : [] })
      Object.defineProperty(event, 'changedTouches', { value: [point] })
      target.dispatchEvent(event)
    }
    send('touchstart', 0, true)
    for (let step = 1; step <= 6; step++) send('touchmove', (${rise} * step) / 6, true)
    send('touchend', ${rise}, false)
    return true
  })()`
}

async function read(page: FullPage): Promise<Drawn> {
  return (await page.evaluate(READ)) as Drawn
}

/** The full view drawn, or the reason it was not. */
async function drawnOn(page: FullPage): Promise<Drawn> {
  await page.waitForSelector('.fv-row', { timeout: 30_000 })
  // The first whole lands after the stream opens: wait until rows have text.
  for (let tries = 0; tries < 100; tries++) {
    const drawn = await read(page)
    if (drawn.rows.length > 5 && drawn.rows.some((row) => row.includes('refunds'))) return drawn
    await page.waitForTimeout(100)
  }
  throw new Error('the full view drew no window in ten seconds')
}

async function lookAt(
  engine: Engine,
  origin: string,
  size: FullSize,
  state: object,
  asked: Asked,
  found: Finding[],
): Promise<void> {
  const where = size.name
  const say = (check: string, pass: boolean, words: string) =>
    found.push({ check, where, verdict: pass ? 'pass' : 'fail', said: words })
  const context: Context = await phoneAt(engine, { ...size, keyboard: 0 }, state)
  try {
    const page = (await context.newPage()) as FullPage
    const thrown: string[] = []
    page.on('pageerror', (problem) => thrown.push(said(problem)))
    await page.goto(`${origin}/draw/`, { waitUntil: 'load' })
    let drawn: Drawn
    try {
      drawn = await drawnOn(page)
    } catch (problem) {
      say(
        'drew',
        false,
        `${said(problem)}${thrown.length > 0 ? ` — the page threw: ${thrown[0]}` : ''}`,
      )
      return
    }
    const columns = Math.max(...drawn.rows.map((row) => row.length))
    const even = drawn.rows.every((row) => row.length === columns)
    say(
      'drew',
      even && thrown.length === 0,
      `${columns} × ${drawn.rows.length}${even ? '' : ', rows of unequal width'}${thrown.length > 0 ? `, threw: ${thrown[0]}` : ''}`,
    )
    if (size.columns !== undefined) {
      const ok = columns >= size.columns.least && columns <= size.columns.most
      say('columns', ok, `${columns}, asked ${size.columns.least}–${size.columns.most}`)
    }
    // Inside the phone's insets, above the keys, and nothing wider than the screen.
    const g = drawn.grid
    const inside =
      g.left >= size.insets.left - 0.5 &&
      g.right <= drawn.view.width - size.insets.right + 0.5 &&
      g.bottom <= drawn.room.bottom + 0.5 &&
      g.top >= size.insets.top - 0.5 &&
      drawn.wide <= drawn.view.width
    say(
      'fits',
      inside,
      `grid ${Math.round(g.left)}–${Math.round(g.right)} × ${Math.round(g.top)}–${Math.round(g.bottom)}, keys at ${Math.round(drawn.room.bottom)}, page ${drawn.wide} wide of ${drawn.view.width}`,
    )
    say(
      'targets',
      drawn.small.length === 0,
      drawn.small.length === 0
        ? 'every press 44px or more'
        : `under 44px: ${drawn.small.join(', ')}`,
    )
    say('no zoom', drawn.field >= 16, `the field the keyboard types into is ${drawn.field}px`)
    if (size.fold) {
      // The sidebar's edge: the column most body rows draw `│` at.
      const at = new Map<number, number>()
      for (const row of drawn.rows.slice(2, -4)) {
        const column = [...row].findIndex((char, i) => char === '│' && i > 8)
        if (column > 0) at.set(column, (at.get(column) ?? 0) + 1)
      }
      const edge = [...at.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1
      const x = g.left + (edge + 0.5) * g.cell
      const off = Math.abs(x - drawn.view.width / 2)
      say(
        'fold',
        edge === Math.floor(columns / 2) && off <= g.cell,
        `edge at column ${edge} of ${columns}, ${off.toFixed(1)}px from the centre of the glass`,
      )
    }
    // A tap on another agent looks at it, on the phone, and asks the machine nothing.
    const acted = asked.acts.length
    const before = drawn.rows.join('\n')
    const rowAt = drawn.rows.findIndex((row) => row.includes('refunds'))
    const colAt = drawn.rows[rowAt]?.indexOf('refunds') ?? -1
    if (rowAt >= 0) {
      await page.touchscreen.tap(g.left + (colAt + 1.5) * g.cell, g.top + (rowAt + 0.5) * g.row)
      await page.waitForTimeout(200)
      const after = (await read(page)).rows.join('\n')
      say(
        'tap',
        after !== before && asked.acts.length === acted,
        after === before
          ? 'a tap on an agent changed nothing'
          : 'a tap on an agent looked at it, and asked the machine nothing',
      )
    } else say('tap', false, 'no agent row drawn to tap')
    // A swipe up over the sidebar scrolls it: a finger's touches, as the phone sends them.
    const scrolled = (await read(page)).rows.join('\n')
    const swiped = await page.evaluate(swipe(g.left + 4 * g.cell, g.top + 4 * g.row, g.row * 3))
    await page.waitForTimeout(400)
    const moved = (await read(page)).rows.join('\n')
    say(
      'swipe',
      swiped === true && moved !== scrolled,
      swiped !== true
        ? `no touch could be made here: ${String(swiped)}`
        : moved === scrolled
          ? 'a swipe over the sidebar moved nothing'
          : 'a swipe over the sidebar scrolled it',
    )
    // A key from the row that only the machine can carry out goes as one act:
    // the leader first, because the agent the tap looked at has the keyboard,
    // and every other key is that agent's — on the phone as at the machine.
    await page.click('.fv-key[aria-label="The leader, ctrl+]"]')
    await page.click('.fv-key[aria-label="The keys, F1"]')
    await page.waitForTimeout(300)
    const sent = asked.acts.slice(acted)
    say(
      'keys',
      sent.some((one) => one.kind === 'run'),
      sent.length === 0
        ? 'the leader and F1 from the key row sent nothing'
        : `the leader and F1 sent ${sent.map((one) => (one.kind === 'run' ? `run ${one.action}` : one.kind)).join(', ')}`,
    )
    // The keyboard rising: the window draws again in the room above it.
    const rowsBefore = (await read(page)).rows.length
    await page.evaluate('window.__duoKeyboard?.(Math.round(innerHeight * 0.4))')
    await page.waitForTimeout(300)
    const up = await read(page)
    say(
      'keyboard',
      up.rows.length < rowsBefore && up.grid.bottom <= up.room.bottom + 0.5,
      `${rowsBefore} rows, ${up.rows.length} with the keyboard up`,
    )
    await page.evaluate('window.__duoKeyboard?.(0)')
    if (shots !== null) {
      await page.waitForTimeout(200)
      await page.screenshot({ path: join(shots, `full-${size.name}.png`) })
    }
  } finally {
    await context.close()
  }
}

/** The switch, and turning the phone: the Duo's small screen, both ways up. */
async function switched(engine: Engine, origin: string, state: object, found: Finding[]) {
  const upright = FULL_SIZES.find((one) => one.name === 'duo-outer-upright')
  const sideways = FULL_SIZES.find((one) => one.name === 'duo-outer-sideways')
  if (upright === undefined || sideways === undefined) return
  const say = (check: string, pass: boolean, words: string) =>
    found.push({ check, where: 'duo-outer', verdict: pass ? 'pass' : 'fail', said: words })
  const context = await phoneAt(engine, { ...upright, keyboard: 0 }, state)
  try {
    const page = (await context.newPage()) as FullPage
    await page.goto(`${origin}/`, { waitUntil: 'load' })
    await page.waitForSelector('main .page-overview', { timeout: 15_000 })
    await page.waitForSelector('.top .mode-switch:not([hidden])', { timeout: 10_000 })
    say(
      'upright',
      new URL(page.url()).pathname === '/',
      `upright opens ${new URL(page.url()).pathname}`,
    )
    await page.setViewportSize({ width: sideways.width, height: sideways.height })
    await page.waitForURL(`${origin}/draw/`, { timeout: 10_000 }).catch(() => {})
    say(
      'turned',
      new URL(page.url()).pathname === '/draw/',
      `turned sideways, it is at ${new URL(page.url()).pathname}`,
    )
    await drawnOn(page)
    await page.setViewportSize({ width: upright.width, height: upright.height })
    await page.waitForURL(`${origin}/`, { timeout: 10_000 }).catch(() => {})
    say(
      'turned back',
      new URL(page.url()).pathname === '/',
      `turned upright again, it is at ${new URL(page.url()).pathname}`,
    )
    // Sideways, the overview chosen: kept, and the page stays the overview.
    await page.setViewportSize({ width: sideways.width, height: sideways.height })
    await page.waitForURL(`${origin}/draw/`, { timeout: 10_000 }).catch(() => {})
    await drawnOn(page)
    await page.click('.fv-top .mode:not([aria-current])')
    await page.waitForURL(`${origin}/`, { timeout: 10_000 }).catch(() => {})
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('main .page-overview', { timeout: 15_000 })
    await page.waitForTimeout(800)
    say(
      'kept',
      new URL(page.url()).pathname === '/',
      `the overview chosen sideways, a reload stays at ${new URL(page.url()).pathname}`,
    )
    await page.click('.top .mode:not([aria-current])')
    await page.waitForURL(`${origin}/draw/`, { timeout: 10_000 }).catch(() => {})
    say(
      'switch',
      new URL(page.url()).pathname === '/draw/',
      `the header's Full view goes to ${new URL(page.url()).pathname}`,
    )
  } catch (problem) {
    say('switch', false, said(problem))
  } finally {
    await context.close()
  }
}

export async function full(playwright: Playwright | null, why = ''): Promise<Finding[]> {
  if (playwright === null) return [{ check: 'full', where: '—', verdict: 'unrun', said: why }]
  let engine: Engine
  try {
    engine = await playwright.webkit.launch({ headless: true })
  } catch (problem) {
    return [
      {
        check: 'full',
        where: '—',
        verdict: 'unrun',
        said: `WebKit could not start: ${said(problem)}`,
      },
    ]
  }
  const found: Finding[] = []
  await mkdir(SCRATCH, { recursive: true })
  if (shots !== null) await mkdir(shots, { recursive: true })
  const home = await mkdtemp(join(SCRATCH, 'tade-away-full-'))
  const asked: Asked = { looks: [], acts: [] }
  try {
    const { server, origin, tickets } = await serve(home, asked)
    try {
      const first = FULL_SIZES[0]
      if (first === undefined) return found
      const pairing = await phoneAt(engine, { ...first, keyboard: 0 })
      await pairIn(
        await pairing.newPage(),
        origin,
        tickets.mint(`${origin}/pair`, Date.now()).value,
      )
      const state = await pairing.storageState()
      await pairing.close()
      for (const size of FULL_SIZES) {
        try {
          await lookAt(engine, origin, size, state, asked, found)
        } catch (problem) {
          found.push({ check: 'full', where: size.name, verdict: 'fail', said: said(problem) })
        }
      }
      await switched(engine, origin, state, found)
    } finally {
      await server.close()
    }
  } finally {
    try {
      await engine.close()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
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
  const found = await full(playwright, why)
  process.stdout.write(sayReport(found))
  process.exitCode = exitFor(worstOf(found))
}

if (process.argv[1] === import.meta.filename) await main()

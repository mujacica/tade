import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Moved, NotOffered, type Outcome, type WebActing } from '../src/acting.ts'
import type { ChatIn, TalkIn } from '../src/input.ts'
import type { Reach } from '../src/reach.ts'
import { projector } from '../src/reading.ts'
import { webServer } from '../src/server.ts'
import { OFF } from '../src/surface.ts'
import { Tickets } from '../src/tickets.ts'
import {
  allUnrun,
  axeRefused,
  CUT_ALLOWED,
  exitFor,
  type Finding,
  LOOKS,
  NOT_FOR_A_GRANTED_DEVICE,
  READY,
  said,
  sayReport,
  WIDTHS,
  worstOf,
} from '../test/browser-plan.ts'
import { blocked, input, NOW, task } from '../test/fixtures.ts'
import { chatAt, harnessTalk } from './browser-chat.ts'
import { doingAt, type Running } from './browser-doing.ts'
import { asPwa } from './browser-pwa.ts'
import {
  AXE,
  CONTROLS,
  CUT,
  HOLD,
  HOLD_AGAIN,
  OUTSIDE,
  RECEIVED,
  SAID_MOVED,
  SAID_SOMETHING,
  SHAPE,
  STATUS,
} from './browser-snippets.ts'
import { until } from './browser-until.ts'

// The away view, in a real browser, against the real server and the real files.
//
//   node packages/web/scripts/browser.ts                  # report to stdout
//   node packages/web/scripts/browser.ts --shots <dir>    # and write the pictures
//
// **It needs a browser, and it says `unrun` when there is none.** Playwright
// and `axe-core` are not in this repository's lockfile and are not meant to be:
// Playwright's install pulls a few hundred megabytes of browser onto every
// contributor's machine and into every CI job, and this repository holds the
// line that `pnpm install` runs two scripts and installs nothing else. So they
// are **optional, on the machine**:
//
//   pnpm add -D -w playwright@1.64.1 axe-core@4.14.0 && pnpm exec playwright install chromium
//
// **Those exact versions** (`AXE_CORE`, `PLAYWRIGHT_AT` in `browser-plan.ts`):
// with nothing in a lockfile, the install decides the verdict, so under any
// other axe-core the script refuses to run and says why.
//
// or, with a Chrome the machine already has and no download at all:
//
//   TADE_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
//     node packages/web/scripts/browser.ts
//
// With them, this answers the questions only a browser owns — does axe find
// anything, does the page scroll sideways at 360px, is every control big enough
// to hit, does pairing work when a person actually presses the button. **The
// page is two screens** (§10 T5 of the Duo plan): the overview at `/` — the
// tiles, the agents waiting on you with their quick presses, the agents
// working, and the conversation with Tade in a region of its own — and
// pairing at `/pair`. Everything else is a panel of the window, in the full
// view at `/draw/`, which `browser-duo.ts` and the browser goldens look at.
// Without
// them every one of those is reported `unrun` **with the reason**, and the last
// line says so: a missing browser must never read as a passing suite.
//
// **The snippets that run in the page are strings**, deliberately, and they are
// `browser-snippets.ts`. They execute in a browser, where `document` exists and
// this repository's `lib` has no DOM; written as closures they would be code
// `tsc` has to pretend to understand. As strings they are what they are — a
// payload handed over the debugger protocol — and in their own file this one
// stays the thing that drives a browser rather than a file half made of
// another language.
//
// What it is pointed at is the projection's own fixtures, so no real work is on
// screen and no picture of it can carry one. It binds loopback on port 0 and
// closes the listener however it ends.
//
// **Its home and its pictures are not in the temp folder.** A `tade-` name
// there is one the suite's own guard answers for (`test/own-tmp.ts`), so a run
// of this beside a full suite turned it red; both go in `node_modules/.cache`,
// and the home is removed when the run ends, however it ends.

/** Where a run's home and its pictures are made: beside the dependencies, and never committed. */
const SCRATCH = fileURLToPath(new URL('../../../node_modules/.cache/', import.meta.url))

const shots = shotsDir(process.argv)
const findings: Finding[] = []

/** The real listener, the real pairing, and a ticket to walk in with. */
async function serve() {
  await mkdir(SCRATCH, { recursive: true })
  const home = await mkdtemp(join(SCRATCH, 'tade-away-browser-'))
  const tickets = new Tickets()
  const held = new Map<string, ReturnType<typeof projector>>()
  const server = webServer({
    home,
    // **Acting on**: the route table is built with the listener, so turning it
    // on later is not a thing a harness can do. Every paired device may act,
    // and the third pass drives a real tap, a real Tab and a real refusal.
    // **`OFF` and then what this harness turns on**, so a capability added to
    // the surface arrives here off rather than as a guess.
    surface: {
      ...OFF,
      enabled: true,
      port: 0,
      acting: true,
      talking: true,
      // On, or there is no registration to ask anything of; what is precached
      // is the page, which carries nobody's work.
      installing: true,
      keepsView: true,
    },
    acting: recording,
    // **Talking on too, with the same stub treatment**: the acting pass sends
    // a real message with a real tap. **`REFUSED` is answered `gone`**, and
    // `stop` `not_offered`: a harness where everything succeeds can never show
    // that a refusal leaves what somebody typed in the composer where it was.
    asking: {
      unlocked: () => true,
      ask: (call) => {
        asked.push({ verb: 'ask', task: '', said: call.said })
        if (call.said === REFUSED) {
          return Promise.reject(new Moved('Tade started answering somebody else', call.was))
        }
        return Promise.resolve({ did: true, rev: call.was, said: 'Tade is answering' })
      },
      stop: () => Promise.reject(new NotOffered('this harness cannot stop a turn')),
    },
    readingFor: (reach: Reach) => {
      reaches.set(reach.device, reach)
      const mine = held.get(reach.device)
      if (mine !== undefined) return mine
      const made = projector(input({ reach, talk: harnessTalk(), tasks: TASKS }), NOW)
      held.set(reach.device, made)
      return made
    },
    // Tade's own conversation reads back through what the projection holds,
    // which is all of it here.
    earlier: { talk: async () => true },
    // **The full view is there, as it is behind every real window**
    // (`drawingDoor` in `@tade/app`'s `wire/web.ts`): the page asks `/draw/`
    // before it offers the Overview/Full view switch (`offerFull`), and a
    // listener with no drawing answers that ask `404` — which Chromium logs,
    // and which no real window does. The full view itself is
    // `browser-duo.ts`'s and the browser goldens'; here it only has to answer.
    drawing: {
      answer: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><title>Full view</title>')
        return true
      },
    },
    tickets,
    tell: () => {},
    // The keypress at the machine, answered yes — which is the whole of what
    // authorises a pairing, and the one thing a browser cannot press.
    confirm: async () => ({ let: true }),
  })
  const bound = await server.listen()
  const at = bound.find((one) => one.startsWith('127.0.0.1'))
  if (at === undefined) throw new Error(`nothing bound on loopback: ${bound.join(', ')}`)
  return { server, origin: `http://${at}`, tickets, held, home }
}

/** What was asked of the window, in the order it was asked. */
const asked: { verb: string; task: string; said: string }[] = []

/**
 * What the acting pass types into the composer: the one message the harness's
 * Tade refuses, `gone`, as it would were it answering somebody else.
 */
const REFUSED = 'the fix is in the adapter'

/**
 * A window that does each verb and remembers being asked — and refuses one.
 *
 * **`note` always answers `gone`**, as the composer's `REFUSED` does. The
 * others answer, so a tap and a keypress have something to prove.
 */
const recording: WebActing = {
  unlocked: () => true,
  park: (call) => did('park', call),
  answer: (call) => did('answer', call),
  steer: (call) => did('steer', call),
  queue: (call) => did('queue', call),
  done: (call) => did('done', call),
  stop: (call) => did('stop', call),
  close: (call) => did('close', { task: call.project, was: call.was }),
  start: (call) => did('start', call),
  remove: (call) => did('remove', call),
  rename: (call) => did('rename', call),
  model: (call) => did('model', call),
  account: (call) => did('account', call),
}

function did(verb: string, call: { task: string; was: string }): Promise<Outcome> {
  asked.push({ verb, task: call.task, said: '' })
  return Promise.resolve({ did: true, rev: call.was, said: `${verb}: done` })
}

/**
 * **The agent waiting on you, able to be answered**: the fixture's blocked
 * task with `answer` among what may be asked of it, so its card on the
 * overview draws every quick press there is — Allow, Deny, Done, Set aside,
 * Tell — and the command it would run, whole, above them.
 */
const ASKING = (() => {
  const one = blocked()
  return {
    ...one,
    can: [{ verb: 'answer', how: 'now' }, ...one.can],
    cannot: one.cannot.filter((no) => no.verb !== 'answer'),
  } satisfies typeof one
})()

/**
 * **An agent waiting on you with nothing to allow**: it asked a question, so
 * its card draws Done, Set aside and Tell and **no Allow or Deny** — a verb it
 * says cannot be is absent, never a dead button.
 */
const QUESTION = task({
  id: 'sentry/which-branch',
  state: 'blocked',
  reason: { kind: 'clause', said: 'asked which branch to start from' },
  question: true,
})

/** Every task the harness's projection carries: the fixture's, with the two waiting on you. */
const TASKS = [...input().tasks.map((one) => (one.id === ASKING.id ? ASKING : one)), QUESTION]

/** What the acting pass's card is: the one waiting on you that may be answered. */
const CARD = `li.ov-want:has(a[href*="${encodeURIComponent(ASKING.id)}"])`

/**
 * Playwright, if this machine has it, and the reason if it does not.
 *
 * The specifier is a variable so this file type-checks on a machine that has
 * never installed it — which is every machine in CI, and is the state the
 * `unrun` report exists for.
 */
const PLAYWRIGHT = 'playwright'

async function browser(): Promise<{ made: Engine | null; why: string }> {
  let loaded: { chromium: { launch: (opts: object) => Promise<Engine> } }
  try {
    loaded = await import(PLAYWRIGHT)
  } catch {
    return { made: null, why: 'playwright is not installed on this machine' }
  }
  // A machine may have a Chrome already and no appetite for another download:
  // `TADE_BROWSER=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  // is the way to say so, and it is why this is worth a line of code — the
  // alternative is a harness nobody can run without fetching 150MB first.
  const here = process.env.TADE_BROWSER
  const opts = { headless: true, ...(here === undefined ? {} : { executablePath: here }) }
  try {
    return { made: await loaded.chromium.launch(opts), why: '' }
  } catch (problem) {
    // Installed as a package with no browser binary behind it, which is the
    // ordinary state after an install without the download.
    return { made: null, why: `a browser could not be started: ${said(problem)}` }
  }
}

/**
 * `axe-core`'s own source, to run inside the page, or the reason there is none
 * — and the version it says it is, which `axeRefused` holds to `AXE_CORE`.
 */
async function axeSource(): Promise<{ source: string | null; why: string; version: string }> {
  let where: string
  try {
    where = import.meta.resolve('axe-core')
  } catch {
    return { source: null, why: 'axe-core is not installed on this machine', version: '' }
  }
  const own = JSON.parse(await readFile(new URL('package.json', where), 'utf8')) as {
    version?: unknown
  }
  return {
    source: await readFile(new URL(where), 'utf8'),
    why: '',
    version: typeof own.version === 'string' ? own.version : 'of no stated version',
  }
}

function found(check: string, where: string, verdict: Finding['verdict'], what: string) {
  findings.push({ check, where, verdict, said: what })
}

interface Engine {
  newContext: (opts: object) => Promise<Context>
  close: () => Promise<void>
}

interface Context {
  newPage: () => Promise<Page>
  /** Run before the page's own scripts on every load: `OVERVIEW_KEPT`. */
  addInitScript: (script: { content: string }) => Promise<void>
  /** Off, for the cold load in `browser-pwa.ts`. */
  setOffline: (offline: boolean) => Promise<void>
  close: () => Promise<void>
}

/** Playwright's own event hook, typed to the two events this listens for. */
interface Listen {
  (event: 'pageerror', hear: (problem: unknown) => void): void
  (event: 'console', hear: (line: Logged) => void): void
}

/** One line the page logged, and where: a refused fetch says only its status, so its URL is the news. */
interface Logged {
  type: () => string
  text: () => string
  location: () => { url: string }
}

/** What the page logged as an error, in one line of the report, with the URL it was about. */
function loggedOf(line: Logged): string {
  const first = line.text().split('\n')[0] ?? ''
  const url = line.location().url
  return `logged: ${first}${url === '' ? '' : ` (${url.replace(/^https?:\/\/[^/]+/, '')})`}`
}

interface Page {
  on: Listen
  waitForFunction: (body: string, opts?: object) => Promise<unknown>
  goto: (url: string, opts?: object) => Promise<unknown>
  reload: (opts?: object) => Promise<unknown>
  fill: (selector: string, value: string) => Promise<void>
  click: (selector: string) => Promise<void>
  waitForSelector: (selector: string, opts?: object) => Promise<unknown>
  waitForURL: (url: string, opts?: object) => Promise<unknown>
  /** The snippet is a string: it runs in the browser, not in this program. */
  evaluate: (body: string) => Promise<unknown>
  addScriptTag: (opts: { content: string }) => Promise<unknown>
  title: () => Promise<string>
  screenshot: (opts: object) => Promise<unknown>
  /** One element, by what it is and what it says. The acting pass taps these. */
  locator: (selector: string, opts?: { hasText?: string }) => Thing
  keyboard: { press: (key: string) => Promise<void>; type: (text: string) => Promise<void> }
  /**
   * The conversation is scrolled up the way a person does it, the wheel over
   * it, and a call in it opened with a tap where a thumb would be.
   */
  mouse: {
    click: (x: number, y: number) => Promise<void>
    move: (x: number, y: number) => Promise<void>
    wheel: (dx: number, dy: number) => Promise<void>
  }
  waitForTimeout: (ms: number) => Promise<void>
  /** The granted pass looks again at the phone's width on the device it already paired. */
  setViewportSize: (size: { width: number; height: number }) => Promise<void>
  emulateMedia: (opts: { reducedMotion: 'reduce' | 'no-preference' }) => Promise<void>
}

/** The four things the acting pass asks of one element, and nothing else. */
interface Thing {
  first: () => Thing
  nth: (at: number) => Thing
  tap: () => Promise<void>
  focus: () => Promise<void>
  fill: (value: string) => Promise<void>
  inputValue: () => Promise<string>
}

/**
 * **The Overview, chosen for a screen held sideways**, as a person does by
 * pressing it on the switch (`keepMode`, `mode.js`). Held sideways the page
 * goes to the full view unless somebody chose otherwise, and the desk's
 * 1440×900 is sideways — so without this every look at it would be at the
 * full view's stand-in rather than the overview.
 */
const OVERVIEW_KEPT = `try { localStorage.setItem('tade.mode', 'sideways=overview') } catch {}`

/** A context the harness looks through: the Overview kept, whichever way up. */
async function contextOf(made: Engine, opts: object): Promise<Context> {
  const context = await made.newContext(opts)
  await context.addInitScript({ content: OVERVIEW_KEPT })
  return context
}

async function run(axe: Awaited<ReturnType<typeof axeSource>>) {
  const { made, why } = await browser()
  if (made === null) {
    findings.push(...allUnrun(why))
    return
  }
  const { server, origin, tickets, held, home } = await serve()
  if (axe.source === null) found('axe', '—', 'unrun', axe.why)
  try {
    for (const width of WIDTHS) {
      const context = await contextOf(made, {
        viewport: { width: width.width, height: width.height },
        // The phone's own reduced-motion setting, because a page that only
        // works with its transitions is one nobody can read on a train.
        reducedMotion: width.narrow === true ? 'reduce' : 'no-preference',
      })
      const page = await context.newPage()
      // **Anything the page throws or logs as an error is a failure.** There is
      // no build step and no typechecker over the browser's modules, so an
      // identifier nothing binds is a runtime `ReferenceError` that kills the
      // rest of an update and leaves a page that *looks* rendered — half of it
      // from the first paint, and nothing after. Without this the harness
      // walks past it: the landmarks are there, the title is right, axe is
      // happy, and the page has been dead since the first frame arrived.
      const noise: string[] = []
      page.on('pageerror', (problem) => noise.push(`threw: ${said(problem)}`))
      page.on('console', (line) => {
        if (line.type() === 'error') noise.push(loggedOf(line))
      })
      await unpairedAt(page, origin, width)
      await pairIn(page, origin, tickets.mint(`${origin}/pair`, Date.now()).value, width.name)
      for (const look of LOOKS) {
        if (look.path === '/pair') continue
        const before = noise.length
        await lookAt(page, origin, look, width, axe.source)
        const fresh = noise.slice(before)
        if (fresh.length > 0) {
          found('quiet', `${look.name} @ ${width.name}`, 'fail', fresh.slice(0, 2).join('; '))
        } else {
          found('quiet', `${look.name} @ ${width.name}`, 'pass', 'nothing thrown, nothing logged')
        }
      }
      await deltaUnder(page, origin, server, held, width.name)
      await context.close()
    }
    await asGranted(made, origin, tickets, axe.source, server, held)
    await asActing(made, origin, tickets, server, held)
  } finally {
    try {
      await made.close()
      await server.close()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
}

/**
 * Every screen again, at the widest width and then at the phone's, on one
 * device resized, with the same questions asked of it.
 *
 * **The phone is the device the person actually holds**, and a page with real
 * figures in it is the one most likely to be wider than 360px or to draw a
 * control too small to hit — a dash fits anywhere. The desk is kept because it
 * draws the agents and the conversation side by side, each scrolling itself.
 * The tablet is left out: the two ends are where it overflows.
 *
 * **One device, resized**, rather than a pairing per width: the harness pairs
 * exactly five times, which is the server's limit per address in ten minutes,
 * so a sixth would be refused. The phone look takes reduced motion, as the
 * first pass's phone does.
 */
async function asGranted(
  made: Engine,
  origin: string,
  tickets: Tickets,
  axe: string | null,
  server: Served,
  held: Map<string, ReturnType<typeof projector>>,
) {
  const desk = [...WIDTHS].sort((a, b) => b.width - a.width)[0]
  const phone = WIDTHS.find((one) => one.narrow === true)
  if (desk === undefined) return
  const context = await contextOf(made, {
    viewport: { width: desk.width, height: desk.height },
  })
  const page = await context.newPage()
  const noise: string[] = []
  page.on('pageerror', (problem: unknown) => noise.push(`threw: ${said(problem)}`))
  page.on('console', (line: Logged) => {
    if (line.type() === 'error') noise.push(loggedOf(line))
  })
  const at = `${desk.name} granted`
  await pairIn(page, origin, tickets.mint(`${origin}/pair`, Date.now()).value, at)
  const lookAll = async (at: string) => {
    for (const look of LOOKS) {
      if (look.path === '/pair') continue
      const before = noise.length
      await lookAt(page, origin, look, { name: at }, axe)
      const fresh = noise.slice(before)
      if (fresh.length > 0) {
        found('quiet', `${look.name} @ ${at}`, 'fail', fresh.slice(0, 2).join('; '))
      } else {
        found('quiet', `${look.name} @ ${at}`, 'pass', 'nothing thrown, nothing logged')
      }
    }
  }
  await lookAll(at)
  await chatAt(page, origin, at, arrival(page, server, held), found, heldLines)
  await doingAt(page, origin, at, busyWith(page, server, held), arrival(page, server, held), found)
  if (phone !== undefined && phone !== desk) {
    await page.setViewportSize({ width: phone.width, height: phone.height })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await lookAll(`${phone.name} granted`)
    await chatAt(
      page,
      origin,
      `${phone.name} granted`,
      arrival(page, server, held),
      found,
      heldLines,
    )
    await doingAt(
      page,
      origin,
      `${phone.name} granted`,
      busyWith(page, server, held),
      arrival(page, server, held),
      found,
    )
  }
  await context.close()
}

/**
 * The overview's presses, for a paired device: every one may act.
 *
 * **The three things only a browser can answer**, and each is a real failure
 * somebody would otherwise find on a phone:
 *
 * - `controls` — that what a card waiting on you says may be asked of it is
 *   what is drawn, as quick presses a thumb's size, with the command Allow
 *   would allow whole above them — and that a verb a card says cannot be is
 *   **absent**, rather than a dead button.
 * - `touch` — that a real tap on a real target does it. A `click()` in a test
 *   runner proves a listener is bound; a pointer event at coordinates proves
 *   the thing is reachable with a thumb.
 * - `typing` — that the answer to a press outlives the next frame, and that a
 *   refusal leaves what somebody typed in the composer where it was. Tade here
 *   answers `REFUSED` with `gone`, so this is the one check that exercises the
 *   path, and it is the one failure a person cannot undo.
 */
async function asActing(
  made: Engine,
  origin: string,
  tickets: Tickets,
  server: Served,
  held: Map<string, ReturnType<typeof projector>>,
) {
  const width = [...WIDTHS].find((one) => one.narrow === true) ?? WIDTHS[0]
  if (width === undefined) return
  const context = await contextOf(made, {
    viewport: { width: width.width, height: width.height },
    hasTouch: true,
  })
  const page = await context.newPage()
  const at = `${width.name} acting`
  await pairIn(page, origin, tickets.mint(`${origin}/pair`, Date.now()).value, at)
  const device = await deviceIn(page)
  if (device === null) {
    found('controls', at, 'unrun', 'the page never said which device this is')
    await context.close()
    return
  }
  try {
    await page.goto(`${origin}/`, { waitUntil: READY })
    await page.waitForSelector(`${CARD} .quick`, { timeout: 10_000 })
    const shape = (await page.evaluate(CONTROLS(CARD, QUESTION_CARD))) as {
      drawn: string[]
      other: string[]
      command: string
      small: string[]
    }
    // Against the fixture's own lists, so this is the page and the projection
    // held equal rather than the page against a literal: the card that may be
    // answered draws every press, and the one that asked a question every
    // press but the two that answer.
    const wanted = ['allow', 'deny', 'done', 'park', 'tell']
    const unanswered = wanted.filter((one) => one !== 'allow' && one !== 'deny')
    const differs = (drawn: string[], want: string[]) =>
      drawn.length !== want.length || want.some((one) => !drawn.includes(one))
    if (differs(shape.drawn, wanted)) {
      found(
        'controls',
        at,
        'fail',
        `drew ${shape.drawn.join(', ') || 'nothing'}; wanted ${wanted.join(', ')}`,
      )
    } else if (differs(shape.other, unanswered)) {
      found(
        'controls',
        at,
        'fail',
        `a card with nothing to allow drew ${shape.other.join(', ') || 'nothing'}; wanted ${unanswered.join(', ')}`,
      )
    } else if (shape.command !== ASKING.approval?.command) {
      found('controls', at, 'fail', `Allow is drawn under "${shape.command}"`)
    } else if (shape.small.length > 0) {
      found('controls', at, 'fail', `too small to hit: ${shape.small.slice(0, 3).join('; ')}`)
    } else {
      found(
        'controls',
        at,
        'pass',
        `${shape.drawn.length} presses under the command, ${shape.other.length} where nothing waits to be allowed`,
      )
    }

    // A real tap, on the one press that takes no second tap and no typing.
    const before = asked.length
    const press = page.locator(`${CARD} button`, { hasText: 'Set aside' }).first()
    await press.tap()
    await until(page, SAID_SOMETHING)
    const tapped = asked.slice(before)
    if (tapped.length === 1 && tapped[0]?.verb === 'park') {
      found('touch', at, 'pass', 'a tap on a 44px target asked for one park')
    } else {
      found('touch', at, 'fail', `a tap asked for ${tapped.map((one) => one.verb).join(', ')}`)
    }

    // The keyboard, on the same press: focused by Tab order and pressed with
    // Enter, which is what a `<button>` owes and a `<div>` with a listener
    // does not.
    const was = asked.length
    await press.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    const keyed = asked.slice(was)
    if (keyed.length === 1 && keyed[0]?.verb === 'park') {
      found('touch', `${at} keyboard`, 'pass', 'Enter on the focused press asked for one park')
    } else {
      found('touch', `${at} keyboard`, 'fail', `Enter asked for ${keyed.length} acts`)
    }

    // **The answer to a press outlives the next frame.** A node carrying both
    // what came of a press and a fact about the harness would have the delta
    // two seconds later rewrite the second and take the first with it — so a
    // press with a new answer (Deny, after two parks), and then a delta to
    // the very card it is on.
    const quiet = String(await page.evaluate(STATUS))
    await page.locator(`${CARD} button`, { hasText: 'Deny' }).first().tap()
    await until(page, `${STATUS} !== ${JSON.stringify(quiet)}`)
    const answered = String(await page.evaluate(STATUS))
    // **A real delta, pushed**, because the thing being checked is what a
    // frame does to the answer: nothing in this harness beats, so a wait alone
    // would pass whatever the page did.
    await nudge(server, held, device)
    await until(page, RECEIVED)
    const later = String(await page.evaluate(STATUS))
    if (later === answered) {
      found('typing', `${at} kept`, 'pass', 'the answer to a press outlived a real delta')
    } else {
      found('typing', `${at} kept`, 'fail', `"${answered}" became "${later}"`)
    }

    // What somebody typed into the composer, against a refusal.
    const box = page.locator('main .talk textarea[aria-label="what to say to Tade"]').first()
    await box.fill(REFUSED)
    await page.locator('main .talk button.ask-send').first().tap()
    await until(page, SAID_MOVED)
    const kept = await box.inputValue()
    if (kept === REFUSED) {
      found('typing', at, 'pass', 'a refusal left what was typed in the composer where it was')
    } else {
      found('typing', at, 'fail', `the composer holds "${kept}" after a refusal`)
    }
  } catch (problem) {
    for (const check of ['controls', 'touch', 'typing']) found(check, at, 'fail', said(problem))
  }
  // **The installed shell, on this same device**: pairing is rate limited per
  // address, the five tries are spent, and this is the right phone to ask
  // anyway — narrow, touch, granted (`browser-pwa.ts`).
  await asPwa({ context, origin, found })
  await context.close()
}

/** The card of the agent that asked a question: waiting on you, with nothing to allow. */
const QUESTION_CARD = `li.ov-want:has(a[href*="${encodeURIComponent(QUESTION.id)}"])`

/** What `deltaUnder` and `asActing` both need of the listener. */
interface Served {
  streams: {
    push: (device: string, delta: never, now: number) => void
    listening: () => string[]
  }
}

/**
 * Move the projection under a page, for real, and push the delta.
 *
 * The card waiting on you that may be answered gets a new reason — a field on
 * the very card the presses are on — and every working agent is stalled, so
 * each row of the agents working says something else. What arrives is a patch
 * to nodes the page already built, which is the shape every delta has and the
 * shape that would wipe a status node carrying two different kinds of fact.
 */
async function nudge(
  server: Served,
  held: Map<string, ReturnType<typeof projector>>,
  device: string,
): Promise<void> {
  const made = held.get(device)
  if (made === undefined) throw new Error('no projector for this device')
  const next = input({ talk: harnessTalk(), tasks: TASKS })
  const delta = made.beat(
    {
      ...next,
      tasks: next.tasks.map((one) =>
        one.id === ASKING.id
          ? { ...one, reason: { kind: 'clause', said: 'moved under your hands' } }
          : one.state === 'working'
            ? { ...one, stalled: true }
            : one,
      ),
    },
    NOW + 2_000,
  )
  if (delta === null) throw new Error('the projection did not move')
  server.streams.push(device, delta as never, Date.now())
}

/** How many lines `arrival` has sent after the harness's conversation, across every page. */
let arrived = 0

/**
 * Every call `busyWith` sent, as the window holds it once the turn moved on:
 * answered, in place under the same id. The window never drops a call it sent,
 * and the page keeps every line it was sent (`linesKept`), so a call left out
 * of a later beat would stay drawn as still going.
 */
const answered: ChatIn[] = []

/** The conversation the harness serves now: its own, the arrivals, and every call answered. */
const harnessNow = (): TalkIn => {
  const talking = harnessTalk(arrived)
  return { ...talking, lines: [...talking.lines, ...answered].sort((a, b) => a.at - b.at) }
}

/** Every line's id of the conversation the harness serves now, oldest first. */
const heldLines = () => harnessNow().lines.map((line) => line.id)

/** What each device may read, as the listener last asked: a delta is projected under its own. */
const reaches = new Map<string, Reach>()

/**
 * One more line of the conversation, sent to this page's device as a delta on
 * its stream — what Tade answering looks like from a phone.
 */
function arrival(
  page: Page,
  server: Served,
  held: Map<string, ReturnType<typeof projector>>,
): () => Promise<void> {
  return async () => {
    const device = await deviceIn(page)
    if (device === null) throw new Error('the page never said which device this is')
    const made = held.get(device)
    if (made === undefined) throw new Error('no projector for this device')
    arrived += 1
    const reach = reaches.get(device)
    const delta = made.beat(
      input({
        ...(reach === undefined ? {} : { reach }),
        talk: harnessNow(),
        tasks: TASKS,
      }),
      NOW + 2_000 + arrived,
    )
    if (delta === null) throw new Error('the conversation did not move')
    server.streams.push(device, delta as never, Date.now())
  }
}

/**
 * Tade answering, with a call still running as its last line: one more
 * arrival, as `arrival` sends it, with the turn in flight and the call after
 * it. The next beat ends the turn, with the call in it answered.
 */
function busyWith(
  page: Page,
  server: Served,
  held: Map<string, ReturnType<typeof projector>>,
): (call: Running) => Promise<void> {
  return async (call) => {
    const device = await deviceIn(page)
    if (device === null) throw new Error('the page never said which device this is')
    const made = held.get(device)
    if (made === undefined) throw new Error('no projector for this device')
    arrived += 1
    const reach = reaches.get(device)
    const talking = harnessNow()
    // Half a second after this arrival's line, so it is the last until the next.
    const at = Date.parse('2026-10-08T13:00:00.000Z') + (10_000 + arrived - 1) * 1000 + 500
    const running: ChatIn = {
      id: `${new Date(at).toISOString()}#0`,
      at,
      kind: 'tool',
      from: '',
      text: '',
      tool: call.tool,
      outcome: 'running',
      call: { input: call.input, result: null },
      streaming: false,
    }
    const delta = made.beat(
      input({
        ...(reach === undefined ? {} : { reach }),
        talk: { ...talking, busy: true, whose: 'device aa', lines: [...talking.lines, running] },
        tasks: TASKS,
      }),
      NOW + 2_000 + arrived,
    )
    if (delta === null) throw new Error('the conversation did not move')
    server.streams.push(device, delta as never, Date.now())
    answered.push({ ...running, outcome: 'ok', call: { input: call.input, result: 'ran' } })
  }
}

/** Which device this page is signed in as, out of the devices screen. */
async function deviceIn(page: Page): Promise<string | null> {
  const got = await page.evaluate(`fetch('/api/devices').then((r) => r.json())`)
  const found_ = (got as { you?: { device?: string } } | null)?.you?.device
  return typeof found_ === 'string' && found_ !== '' ? found_ : null
}

/**
 * Pairing, through the page a person actually uses.
 *
 * The ticket arrives in the fragment, which is what a scanned code carries, and
 * the button is pressed rather than the cookie planted — so what this proves is
 * the flow, not the server's own `POST`, which `pairing.test.ts` already covers
 * from the other side.
 */
async function pairIn(page: Page, origin: string, ticket: string, at: string) {
  try {
    await page.goto(`${origin}/pair#t=${ticket}`, { waitUntil: READY })
    await page.waitForSelector('#label', { timeout: 10_000 })
    await page.fill('#label', 'the harness')
    await page.click('button.pair-press')
    await page.waitForURL(`${origin}/`, { timeout: 15_000 })
    await page.waitForSelector('header .brand', { timeout: 10_000 })
    // And the ticket is gone from the address bar, which is rule two of the
    // whole client.
    const held = await page.evaluate('location.hash')
    if (held !== '') throw new Error(`the ticket stayed in the address bar: ${String(held)}`)
    found('pairing', at, 'pass', 'scanned, named, let in, and the ticket left the address bar')
  } catch (problem) {
    found('pairing', at, 'fail', said(problem))
  }
}

/**
 * A browser with no session, opened at the overview, before anything is paired.
 *
 * **It is the pairing screen and nothing else**: no machines, no presses of a
 * page it cannot read, no *reconnecting* over a stream it never opened and no
 * *no agent is running* — every one a claim about a machine it never asked,
 * and together a connection that looks broken when the thing to do is scan
 * the code.
 */
async function unpairedAt(page: Page, origin: string, width: { name: string }) {
  const where = `no session @ ${width.name}`
  try {
    await page.goto(`${origin}/`, { waitUntil: READY })
    // Attached, not visible: with no ticket in the address the form has
    // nothing to pair with, so the page draws the one line that says to scan
    // the code and keeps the field out of sight.
    await page.waitForSelector('#label', { timeout: 10_000, state: 'attached' })
    const shape = (await page.evaluate(OUTSIDE)) as { drawn: string[]; words: string; path: string }
    const claims = ['reconnecting', 'no agent is running', 'not turned on'].filter((one) =>
      shape.words.toLowerCase().includes(one),
    )
    if (shape.path !== '/pair') found('unpaired', where, 'fail', `left at ${shape.path}`)
    else if (shape.drawn.length > 0) {
      found('unpaired', where, 'fail', `drawn around the form: ${shape.drawn.join(', ')}`)
    } else if (claims.length > 0) found('unpaired', where, 'fail', `says ${claims.join('; ')}`)
    else if (!shape.words.includes('not paired')) found('unpaired', where, 'fail', 'never says so')
    else found('unpaired', where, 'pass', 'the pairing screen alone, and says it is not paired')
  } catch (problem) {
    found('unpaired', where, 'fail', said(problem))
  } finally {
    // Away from `/pair`, or the pairing that follows is a fragment changing
    // under a page that has already read it — no load, and no ticket taken.
    await page.goto('about:blank')
  }
}

interface Bad {
  id: string
  impact: string
  nodes: number
  /** Which elements, so a failure is a thing somebody can go and look at. */
  at: string
}

interface Shape {
  /** Everything a reader would see, for the sentences that may not be here. */
  words: string
  landmarks: string[]
  mains: number
  live: number
  skip: string
  sideways: number
  room: number
  /** How much wider than itself the screen's own content is. */
  within: number
  small: string[]
}

/** What `CUT` found: each element drawn cut, each rule asking to, and the folds with their mark. */
interface Clipped {
  cut: string[]
  rules: string[]
  folds: number
}

async function lookAt(
  page: Page,
  origin: string,
  look: { path: string; name: string },
  width: { name: string; narrow?: true },
  axe: string | null,
) {
  const where = `${look.name} @ ${width.name}`
  try {
    await page.goto(`${origin}${look.path}`, { waitUntil: READY })
    await page.waitForSelector('main', { timeout: 10_000 })
  } catch (problem) {
    found('landmarks', where, 'fail', said(problem))
    return
  }

  const shape = (await page.evaluate(SHAPE)) as Shape
  // **No `nav`**: the page has one screen and no navigation (`shell.js`); the
  // Overview/Full view switch is a `nav` once the machine draws a window to
  // share, and is not owed.
  const missing = ['header', 'main'].filter((one) => !shape.landmarks.includes(one))
  if (missing.length > 0 || shape.mains !== 1) {
    found('landmarks', where, 'fail', `missing ${missing.join(', ')}; ${shape.mains} main`)
  } else if (!shape.skip.toLowerCase().includes('skip')) {
    found('landmarks', where, 'fail', `the first focusable thing is "${shape.skip.trim()}"`)
  } else if (shape.live !== 1) {
    // One live region. Announcing more than what crossed into wanting you
    // reads the page aloud every two seconds.
    found('landmarks', where, 'fail', `${shape.live} live regions`)
  } else {
    found('landmarks', where, 'pass', 'a header, one main, one live region, skip link first')
  }

  // At every width: a desk that scrolled sideways is as broken as a phone.
  const over = Math.max(shape.sideways - shape.room, shape.within)
  if (over > 1) found('sideways', where, 'fail', `the page is ${over}px wider than the screen`)
  else found('sideways', where, 'pass', 'nothing scrolls sideways')

  if (shape.small.length > 0) {
    found('targets', where, 'fail', `too small to hit: ${shape.small.slice(0, 3).join('; ')}`)
  } else {
    found('targets', where, 'pass', 'every control is at least 44px tall')
  }

  // Nothing cut to fit, on this screen or in any rule it could draw with.
  const cut = (await page.evaluate(CUT(CUT_ALLOWED))) as Clipped
  const cuts = [...cut.cut, ...cut.rules.map((one) => `a rule asks for it: ${one}`)]
  if (cuts.length > 0) found('cut', where, 'fail', cuts.slice(0, 4).join('; '))
  else found('cut', where, 'pass', `nothing cut; ${cut.folds} folded with the mark that opens them`)

  const title = await page.title()
  if (title === '' || title === 'Tade') found('titles', where, 'fail', `the title is "${title}"`)
  else found('titles', where, 'pass', title)

  // **Nothing is withheld from a paired device**: every one is the person's
  // own, so a page that told one a thing was *not granted* is saying a thing
  // that is not true of any device.
  const withheld = NOT_FOR_A_GRANTED_DEVICE.filter((one) => shape.words.includes(one))
  if (withheld.length > 0) {
    found('granted', where, 'fail', `says ${withheld.join('; ')} to a paired device`)
  } else {
    found('granted', where, 'pass', 'nothing is said to be withheld')
  }

  if (axe !== null) await axeOn(page, where, axe)
  if (shots !== null) {
    await page.screenshot({ path: join(shots, `${width.name}-${look.name}.png`), fullPage: true })
  }
}

async function axeOn(page: Page, where: string, source: string) {
  try {
    // **Evaluated, not injected as a `<script>`.** The page's own content
    // policy has no `unsafe-inline`, so a script tag is refused — which is the
    // policy working. The debugger's own evaluation is not subject to it, so
    // this is the one way to run a checker against a page that is locked down
    // as hard as this one, and it is the reason the policy needs no exception
    // for a test.
    await page.evaluate(source)
    const bad = (await page.evaluate(AXE)) as Bad[]
    if (bad.length === 0) found('axe', where, 'pass', 'nothing serious or critical')
    else {
      const names = bad.map((one) => `${one.id} ${one.impact} ×${one.nodes} — ${one.at}`).join('; ')
      found('axe', where, 'fail', names)
    }
  } catch (problem) {
    found('axe', where, 'unrun', said(problem))
  }
}

/**
 * A real delta, into an open page, under somebody's hands.
 *
 * **The thing nothing else can check.** The page claims that a change arriving
 * twice a second does not take the keyboard's place or a half-made selection
 * with it, and that claim is about a *delta applied to a live document* — a
 * page loaded once never exercises it. So: focus a row, select some text in
 * it, move the projection, push the delta the server would really send, and
 * ask whether the same element is still focused with the same selection.
 *
 * The row's own text is changed in the same delta, so this is not the easy
 * case where nothing about the focused row moved.
 */
async function deltaUnder(
  page: Page,
  origin: string,
  server: Served,
  held: Map<string, ReturnType<typeof projector>>,
  at: string,
) {
  const where = `a delta @ ${at}`
  try {
    // The overview's agents working, one row each: the delta stalls every
    // one, so the row being held says something else once it arrives.
    await page.goto(`${origin}/`, { waitUntil: READY })
    await page.waitForSelector('main .ov-agents li a', { timeout: 10_000 })
    // Focus the second row and select inside it, which is what a person
    // reading a list on a phone has actually done.
    const before = (await page.evaluate(HOLD)) as { key: string; words: string; said: string }
    if (before.key === '') throw new Error('nothing to hold on to on this page')

    const device = server.streams.listening()[0]
    if (device === undefined) throw new Error('no stream to push into')
    // The projection really moves: the held row's agent stalls, which is what
    // the row says, and a card's reason changes, which is what is waited on.
    await nudge(server, held, device)
    await until(page, RECEIVED)

    const after = (await page.evaluate(HOLD_AGAIN)) as {
      key: string
      words: string
      said: string
      rows: number
    }
    if (after.key !== before.key) {
      found('delta', where, 'fail', `focus moved from ${before.key} to ${after.key || 'nothing'}`)
      return
    }
    if (after.words !== before.words) {
      found('delta', where, 'fail', `the selection went: "${before.words}" to "${after.words}"`)
      return
    }
    if (after.said === before.said) {
      found('delta', where, 'fail', `the held row still says "${after.said}" after the delta`)
      return
    }
    found('delta', where, 'pass', `${after.rows} rows redrawn, focus and selection kept`)
  } catch (problem) {
    found('delta', where, 'fail', said(problem))
  }
}

function shotsDir(argv: readonly string[]): string | null {
  const at = argv.indexOf('--shots')
  return at < 0 ? null : (argv[at + 1] ?? join(SCRATCH, 'tade-away-shots'))
}

// **Refused before a browser is started**, rather than run and reported: a
// report made under another axe-core reads exactly like one made under the
// pinned one, and the difference is the verdict. Exit 2, `unrun` — nothing was
// looked at.
const axe = await axeSource()
const refused = axe.source === null ? null : axeRefused(axe.version)
if (refused !== null) {
  process.stderr.write(`${refused}\n`)
  process.exitCode = 2
} else {
  if (shots !== null) await mkdir(shots, { recursive: true })
  await run(axe)
  process.stdout.write(`${sayReport(findings)}\n`)
  if (shots !== null) process.stdout.write(`\npictures in ${shots}\n`)
  process.exitCode = exitFor(worstOf(findings))
}

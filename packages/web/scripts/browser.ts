import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Moved, type Outcome, type WebActing } from '../src/acting.ts'
import { allowDevice } from '../src/devices.ts'
import { GRANTS, type Grant, type Reach } from '../src/reach.ts'
import { projector } from '../src/reading.ts'
import { webServer } from '../src/server.ts'
import { Tickets } from '../src/tickets.ts'
import {
  allUnrun,
  exitFor,
  type Finding,
  LOOKS,
  NOT_FOR_A_DEVICE_GRANTED_NOTHING,
  NOT_FOR_A_GRANTED_DEVICE,
  sayReport,
  WIDTHS,
  worstOf,
} from '../test/browser-plan.ts'
import { input, NOW } from '../test/fixtures.ts'
import {
  AXE,
  CONTROLS,
  HOLD,
  HOLD_AGAIN,
  RECEIVED,
  SAID_MOVED,
  SAID_SOMETHING,
  SHAPE,
} from './browser-snippets.ts'

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
//   pnpm add -D -w playwright axe-core && pnpm exec playwright install chromium
//
// or, with a Chrome the machine already has and no download at all:
//
//   TADE_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
//     node packages/web/scripts/browser.ts
//
// With them, this answers the questions only a browser owns — does axe find
// anything, does the page scroll sideways at 360px, is every control big enough
// to hit, does pairing work when a person actually presses the button. Without
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

const shots = shotsDir(process.argv)
const findings: Finding[] = []

/**
 * What the next pairing is granted.
 *
 * Mutable because the harness pairs **twice**: a device granted nothing, which
 * is what the honesty checks are about, and one granted everything — because
 * every figure on every screen draws differently with the grant, and a page
 * nobody has rendered with a number in it is a page axe, the tap targets and
 * the 360px overflow have never actually been asked about.
 */
let granting: Grant[] = []

/** The real listener, the real pairing, and a ticket to walk in with. */
async function serve() {
  const home = await mkdtemp(join(tmpdir(), 'tade-away-browser-'))
  const tickets = new Tickets()
  const held = new Map<string, ReturnType<typeof projector>>()
  const server = webServer({
    home,
    // **Acting on, and the controls still absent for the first two devices.**
    // The route table is built with the listener, so turning it on later is
    // not a thing a harness can do — and it changes nothing for a device the
    // page has no scope for: `actsOf` reads the scopes off its own session, so
    // the honesty passes below still render a page with no control on it. What
    // it buys is the third pass, where a device granted both tiers drives a
    // real tap, a real Tab and a real refusal.
    surface: { enabled: true, bind: 'loopback', port: 0, trustedHosts: [], acting: true },
    acting: recording,
    readingFor: (reach: Reach) => {
      const mine = held.get(reach.device)
      if (mine !== undefined) return mine
      const made = projector(input({ reach }), NOW)
      held.set(reach.device, made)
      return made
    },
    tickets,
    tell: () => {},
    // The keypress at the machine, answered yes — which is the whole of what
    // authorises a pairing, and the one thing a browser cannot press.
    confirm: async () => ({ let: true, projects: null, granted: [...granting] }),
  })
  const bound = await server.listen()
  const at = bound.find((one) => one.startsWith('127.0.0.1'))
  if (at === undefined) throw new Error(`nothing bound on loopback: ${bound.join(', ')}`)
  return { server, origin: `http://${at}`, tickets, held, home }
}

/** What was asked of the window, in the order it was asked. */
const asked: { verb: string; task: string; said: string }[] = []

/**
 * A window that does each verb and remembers being asked — and refuses one.
 *
 * **`note` always answers `gone`**, deliberately: the thing a browser is the
 * only place to check is that a refusal leaves what somebody typed in the box,
 * and a verb that always succeeds can never show it. The others answer, so a
 * tap and a keypress have something to prove.
 */
const recording: WebActing = {
  unlocked: () => true,
  park: (call) => did('park', call),
  answer: (call) => did('answer', call),
  steer: (call) => did('steer', call),
  queue: (call) => did('queue', call),
  done: (call) => did('done', call),
  note: (call) => {
    asked.push({ verb: 'note', task: call.task, said: (call as { text: string }).text })
    return Promise.reject(new Moved('somebody wrote one here first', call.was))
  },
  context: (call) => did('context', call),
  intake: (call) => did('intake', call),
}

function did(verb: string, call: { task: string; was: string }): Promise<Outcome> {
  asked.push({ verb, task: call.task, said: '' })
  return Promise.resolve({ did: true, rev: call.was, said: `${verb}: done` })
}

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

/** `axe-core`'s own source, to run inside the page, or the reason there is none. */
async function axeSource(): Promise<{ source: string | null; why: string }> {
  try {
    const where = import.meta.resolve('axe-core')
    return { source: await readFile(new URL(where), 'utf8'), why: '' }
  } catch {
    return { source: null, why: 'axe-core is not installed on this machine' }
  }
}

const said = (problem: unknown) =>
  problem instanceof Error ? (problem.message.split('\n')[0] ?? '') : String(problem)

function found(check: string, where: string, verdict: Finding['verdict'], what: string) {
  findings.push({ check, where, verdict, said: what })
}

interface Engine {
  newContext: (opts: object) => Promise<Context>
  close: () => Promise<void>
}

interface Context {
  newPage: () => Promise<Page>
  close: () => Promise<void>
}

/** Playwright's own event hook, typed to the two events this listens for. */
interface Listen {
  (event: 'pageerror', hear: (problem: unknown) => void): void
  (event: 'console', hear: (line: { type: () => string; text: () => string }) => void): void
}

interface Page {
  on: Listen
  waitForFunction: (body: string, opts?: object) => Promise<unknown>
  goto: (url: string, opts?: object) => Promise<unknown>
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
  keyboard: { press: (key: string) => Promise<void> }
  waitForTimeout: (ms: number) => Promise<void>
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

async function run() {
  const { made, why } = await browser()
  if (made === null) {
    findings.push(...allUnrun(why))
    return
  }
  const { server, origin, tickets, held, home } = await serve()
  const axe = await axeSource()
  if (axe.source === null) found('axe', '—', 'unrun', axe.why)
  try {
    for (const width of WIDTHS) {
      const context = await made.newContext({
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
        if (line.type() === 'error') noise.push(`logged: ${line.text().split('\n')[0] ?? ''}`)
      })
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
    await asGranted(made, origin, tickets, axe.source)
    await asActing(made, origin, tickets, home)
  } finally {
    await made.close()
    await server.close()
  }
}

/**
 * Every screen again, for a device granted everything.
 *
 * **The half the three widths above cannot see.** The harness's first device
 * is granted nothing on purpose, so every money figure, every note and every
 * sign-in on every screen is a dash — which means the laid-out page with
 * actual content in it, the one the owner will look at, has never been
 * rendered in a browser at all. Here it is, once, at the width with the most
 * on screen, with the same questions asked of it.
 *
 * One width rather than three: what differs with a grant is the content, not
 * the breakpoints, and a second full sweep would double a harness people
 * already have to install a browser for.
 */
async function asGranted(made: Engine, origin: string, tickets: Tickets, axe: string | null) {
  const width = [...WIDTHS].sort((a, b) => b.width - a.width)[0]
  if (width === undefined) return
  granting = [...GRANTS]
  const context = await made.newContext({
    viewport: { width: width.width, height: width.height },
  })
  const page = await context.newPage()
  const noise: string[] = []
  page.on('pageerror', (problem: unknown) => noise.push(`threw: ${said(problem)}`))
  page.on('console', (line: { type: () => string; text: () => string }) => {
    if (line.type() === 'error') noise.push(`logged: ${line.text().split('\n')[0] ?? ''}`)
  })
  const at = `${width.name} granted`
  await pairIn(page, origin, tickets.mint(`${origin}/pair`, Date.now()).value, at)
  for (const look of LOOKS) {
    if (look.path === '/pair') continue
    const before = noise.length
    await lookAt(page, origin, look, { name: at }, axe, true)
    const fresh = noise.slice(before)
    if (fresh.length > 0) {
      found('quiet', `${look.name} @ ${at}`, 'fail', fresh.slice(0, 2).join('; '))
    } else {
      found('quiet', `${look.name} @ ${at}`, 'pass', 'nothing thrown, nothing logged')
    }
  }
  await context.close()
  granting = []
}

/**
 * The controls, for a device a person granted both tiers at the machine.
 *
 * **The three things only a browser can answer**, and each is a real failure
 * somebody would otherwise find on a phone:
 *
 * - `controls` — that what the row says may be asked of it is what is drawn,
 *   and that a verb it says cannot be is **absent with its reason beside it**
 *   rather than a dead button or a hole.
 * - `touch` — that a real tap on a real target does it. A `click()` in a test
 *   runner proves a listener is bound; a pointer event at coordinates proves
 *   the thing is reachable with a thumb.
 * - `typing` — that a refusal leaves what somebody typed where it was. The
 *   `note` verb here always answers `gone`, so this is the one check that
 *   exercises the path, and it is the one failure a person cannot undo.
 *
 * The grant is `allowDevice` — the same append the pairing panel makes, which
 * is the only door a scope widens through. There is no route for it and there
 * must never be one, so a harness that wanted one would be asking for the
 * thing this design is built to refuse.
 */
async function asActing(made: Engine, origin: string, tickets: Tickets, home: string) {
  const width = [...WIDTHS].find((one) => one.narrow === true) ?? WIDTHS[0]
  if (width === undefined) return
  granting = [...GRANTS]
  const context = await made.newContext({
    viewport: { width: width.width, height: width.height },
    hasTouch: true,
  })
  const page = await context.newPage()
  const at = `${width.name} acting`
  await pairIn(page, origin, tickets.mint(`${origin}/pair`, Date.now()).value, at)
  // The keypress at the machine, which is what a scope widens through.
  const device = await deviceIn(page)
  if (device === null) {
    found('controls', at, 'unrun', 'the page never said which device this is')
    await context.close()
    granting = []
    return
  }
  await allowDevice(home, device, ['read', 'answer', 'steer'], new Date())
  try {
    await page.goto(`${origin}/t/sentry/away-projection`, { waitUntil: 'networkidle' })
    await page.waitForSelector('main textarea', { timeout: 10_000 })
    const shape = (await page.evaluate(CONTROLS)) as {
      drawn: string[]
      reasons: string[]
      small: string[]
    }
    // Against the fixture's own two lists, so this is the page and the
    // projection held equal rather than the page against a literal.
    const wanted = ['park', 'steer', 'done', 'note', 'context']
    const missing = wanted.filter((verb) => !shape.drawn.includes(verb))
    const extra = shape.drawn.filter((verb) => !wanted.includes(verb))
    if (missing.length > 0 || extra.length > 0) {
      found(
        'controls',
        at,
        'fail',
        `drew ${shape.drawn.join(', ') || 'nothing'}; wanted ${wanted.join(', ')}`,
      )
    } else if (shape.reasons.length < 3) {
      found('controls', at, 'fail', `only ${shape.reasons.length} of 3 reasons are drawn`)
    } else if (shape.small.length > 0) {
      found('controls', at, 'fail', `too small to hit: ${shape.small.slice(0, 3).join('; ')}`)
    } else {
      found(
        'controls',
        at,
        'pass',
        `${shape.drawn.length} drawn, ${shape.reasons.length} explained`,
      )
    }

    // A real tap, on the one control that takes no typing.
    const before = asked.length
    const press = page.locator('button', { hasText: 'Set this aside' }).first()
    await press.tap()
    await until(page, SAID_SOMETHING)
    const tapped = asked.slice(before)
    if (tapped.length === 1 && tapped[0]?.verb === 'park') {
      found('touch', at, 'pass', 'a tap on a 44px target asked for one park')
    } else {
      found('touch', at, 'fail', `a tap asked for ${tapped.map((one) => one.verb).join(', ')}`)
    }

    // The keyboard, on the same control: focused by Tab order and pressed with
    // Enter, which is what a `<button>` owes and a `<div>` with a listener
    // does not.
    const was = asked.length
    await press.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    const keyed = asked.slice(was)
    if (keyed.length === 1 && keyed[0]?.verb === 'park') {
      found('touch', `${at} keyboard`, 'pass', 'Enter on the focused control asked for one park')
    } else {
      found('touch', `${at} keyboard`, 'fail', `Enter asked for ${keyed.length} acts`)
    }

    // What somebody typed, against a refusal.
    const words = 'the fix is in the adapter'
    const box = page.locator('textarea[aria-label="what to write down"]').first()
    await box.fill(words)
    await page.locator('button', { hasText: 'Write it down' }).first().tap()
    await until(page, SAID_MOVED)
    const kept = await box.inputValue()
    if (kept === words) {
      found('typing', at, 'pass', 'a refusal left what was typed where it was')
    } else {
      found('typing', at, 'fail', `the box holds "${kept}" after a refusal`)
    }
  } catch (problem) {
    for (const check of ['controls', 'touch', 'typing']) found(check, at, 'fail', said(problem))
  }
  await context.close()
  granting = []
}

/**
 * Poll until a snippet says yes, because `waitForFunction` cannot run here.
 *
 * The content policy has no `unsafe-eval`, and Playwright's `waitForFunction`
 * polls by compiling a string in the page — which that policy refuses, as it
 * refuses every other `eval` an injected script could try. `evaluate` goes
 * through the debugger protocol instead and needs no `eval` at all, so the
 * waiting happens here. **That the policy refuses it is the point**: a harness
 * that worked around it by loosening the header would be testing a page nobody
 * is served.
 */
async function until(page: Page, body: string, ms = 10_000): Promise<void> {
  const stop = Date.now() + ms
  for (;;) {
    if ((await page.evaluate(body)) === true) return
    if (Date.now() > stop) throw new Error(`nothing answered yes in ${ms}ms`)
    await page.waitForTimeout(100)
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
    await page.goto(`${origin}/pair#t=${ticket}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('#label', { timeout: 10_000 })
    await page.fill('#label', 'the harness')
    await page.click('button.press')
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
  small: string[]
}

async function lookAt(
  page: Page,
  origin: string,
  look: { path: string; name: string },
  width: { name: string; narrow?: true },
  axe: string | null,
  granted = false,
) {
  const where = `${look.name} @ ${width.name}`
  try {
    await page.goto(`${origin}${look.path}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('main', { timeout: 10_000 })
  } catch (problem) {
    found('landmarks', where, 'fail', said(problem))
    return
  }

  const shape = (await page.evaluate(SHAPE)) as Shape
  const missing = ['header', 'nav', 'main'].filter((one) => !shape.landmarks.includes(one))
  if (missing.length > 0 || shape.mains !== 1) {
    found('landmarks', where, 'fail', `missing ${missing.join(', ')}; ${shape.mains} main`)
  } else if (!shape.skip.toLowerCase().includes('skip')) {
    found('landmarks', where, 'fail', `the first focusable thing is "${shape.skip.trim()}"`)
  } else if (shape.live !== 1) {
    // One live region. Announcing more than what crossed into wanting you
    // reads the page aloud every two seconds.
    found('landmarks', where, 'fail', `${shape.live} live regions`)
  } else {
    found('landmarks', where, 'pass', 'header, nav, one main, one live region, skip link first')
  }

  if (width.narrow === true) {
    const over = shape.sideways - shape.room
    if (over > 1) found('sideways', where, 'fail', `the page is ${over}px wider than the screen`)
    else found('sideways', where, 'pass', 'nothing scrolls sideways')
  }

  if (shape.small.length > 0) {
    found('targets', where, 'fail', `too small to hit: ${shape.small.slice(0, 3).join('; ')}`)
  } else {
    found('targets', where, 'pass', 'every control is at least 44px tall')
  }

  const title = await page.title()
  if (title === '' || title === 'Tade') found('titles', where, 'fail', `the title is "${title}"`)
  else found('titles', where, 'pass', title)

  if (granted) {
    // The other way round, and it is the same bug seen from the other side: a
    // device that **was** granted the content must never be told the content
    // was withheld from it.
    const withheld = NOT_FOR_A_GRANTED_DEVICE.filter((one) => shape.words.includes(one))
    if (withheld.length > 0) {
      found('granted', where, 'fail', `says ${withheld.join('; ')} to a device granted everything`)
    } else {
      found('granted', where, 'pass', 'nothing is withheld from a device that was granted it')
    }
  } else {
    // The device this harness pairs was granted nothing, so every withheld
    // field is a null — and a page that drew one as *not recorded* would be
    // telling somebody their work cost nothing when their phone was never
    // allowed to ask.
    const lies = NOT_FOR_A_DEVICE_GRANTED_NOTHING.filter((one) => shape.words.includes(one))
    if (lies.length > 0) {
      found('honesty', where, 'fail', `says ${lies.join('; ')} to a device granted nothing`)
    } else {
      found('honesty', where, 'pass', 'every withheld field says it was withheld')
    }
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
  server: {
    streams: {
      push: (device: string, delta: never, now: number) => void
      listening: () => string[]
    }
  },
  held: Map<string, ReturnType<typeof projector>>,
  at: string,
) {
  const where = `a delta @ ${at}`
  try {
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('main .rows li a', { timeout: 10_000 })
    // Focus the second row and select inside it, which is what a person
    // reading a list on a phone has actually done.
    const before = (await page.evaluate(HOLD)) as { key: string; words: string }
    if (before.key === '') throw new Error('nothing to hold on to on this page')

    const device = server.streams.listening()[0]
    const made = device === undefined ? undefined : held.get(device)
    if (device === undefined || made === undefined) throw new Error('no stream to push into')
    // The projection really moves: a task's reason changes, which is a field
    // on the very row being held.
    const next = input()
    const first = next.tasks[0]
    if (first === undefined) throw new Error('no task to move')
    const delta = made.beat(
      {
        ...next,
        tasks: [
          { ...first, reason: { kind: 'clause', said: 'moved under your hands' } },
          ...next.tasks.slice(1),
        ],
      },
      NOW + 2_000,
    )
    if (delta === null) throw new Error('the projection did not move')
    server.streams.push(device, delta as never, Date.now())
    await page.waitForFunction(RECEIVED, { timeout: 10_000 })

    const after = (await page.evaluate(HOLD_AGAIN)) as {
      key: string
      words: string
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
    found('delta', where, 'pass', `${after.rows} rows redrawn, focus and selection kept`)
  } catch (problem) {
    found('delta', where, 'fail', said(problem))
  }
}

function shotsDir(argv: readonly string[]): string | null {
  const at = argv.indexOf('--shots')
  return at < 0 ? null : (argv[at + 1] ?? join(tmpdir(), 'tade-away-shots'))
}

if (shots !== null) await mkdir(shots, { recursive: true })
await run()
process.stdout.write(`${sayReport(findings)}\n`)
if (shots !== null) process.stdout.write(`\npictures in ${shots}\n`)
process.exitCode = exitFor(worstOf(findings))

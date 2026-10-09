import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Reach } from '../src/reach.ts'
import { projector } from '../src/reading.ts'
import { webServer } from '../src/server.ts'
import { Tickets } from '../src/tickets.ts'
import {
  allUnrun,
  exitFor,
  type Finding,
  LOOKS,
  NOT_FOR_A_DEVICE_GRANTED_NOTHING,
  sayReport,
  WIDTHS,
  worstOf,
} from '../test/browser-plan.ts'
import { input, NOW } from '../test/fixtures.ts'

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
// **The snippets that run in the page are strings**, deliberately. They execute
// in a browser, where `document` exists and this repository's `lib` has no DOM;
// written as closures they would be code `tsc` has to pretend to understand.
// As strings they are what they are — a payload handed to a browser.
//
// What it is pointed at is the projection's own fixtures, so no real work is on
// screen and no picture of it can carry one. It binds loopback on port 0 and
// closes the listener however it ends.

const shots = shotsDir(process.argv)
const findings: Finding[] = []

/** The real listener, the real pairing, and a ticket to walk in with. */
async function serve() {
  const home = await mkdtemp(join(tmpdir(), 'tade-away-browser-'))
  const tickets = new Tickets()
  const held = new Map<string, ReturnType<typeof projector>>()
  const server = webServer({
    home,
    surface: { enabled: true, bind: 'loopback', port: 0, trustedHosts: [] },
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
    confirm: async () => ({ let: true, projects: null, granted: [] }),
  })
  const bound = await server.listen()
  const at = bound.find((one) => one.startsWith('127.0.0.1'))
  if (at === undefined) throw new Error(`nothing bound on loopback: ${bound.join(', ')}`)
  return { server, origin: `http://${at}`, tickets }
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
}

async function run() {
  const { made, why } = await browser()
  if (made === null) {
    findings.push(...allUnrun(why))
    return
  }
  const { server, origin, tickets } = await serve()
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
      await context.close()
    }
  } finally {
    await made.close()
    await server.close()
  }
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

/**
 * Everything about one screen that only a laid-out page can answer.
 *
 * One snippet rather than four, because four would mean four layout passes of
 * the same page and the answers would be about four different moments.
 */
const SHAPE = `(() => {
  const small = []
  for (const one of document.querySelectorAll('a, button')) {
    const box = one.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) continue
    // A link inside somebody's own words is text, not a target.
    if (one.closest('.said') !== null) continue
    if (box.height < 44 || box.width < 24) {
      small.push(one.tagName.toLowerCase() + '.' + one.className + ' ' +
        Math.round(box.width) + '×' + Math.round(box.height))
    }
  }
  const first = document.querySelector('a, button')
  return {
    words: document.body.innerText || '',
    landmarks: [...document.querySelectorAll('header, nav[aria-label], main')]
      .map((one) => one.tagName.toLowerCase()),
    mains: document.querySelectorAll('main').length,
    live: document.querySelectorAll('[aria-live]').length,
    skip: first === null ? '' : (first.textContent || ''),
    sideways: document.scrollingElement ? document.scrollingElement.scrollWidth : 0,
    room: window.innerWidth,
    small,
  }
})()`

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

  // The device this harness pairs was granted nothing, so every withheld field
  // is a null — and a page that drew one as *not recorded* would be telling
  // somebody their work cost nothing when their phone was never allowed to ask.
  const lies = NOT_FOR_A_DEVICE_GRANTED_NOTHING.filter((one) => shape.words.includes(one))
  if (lies.length > 0) {
    found('honesty', where, 'fail', `says ${lies.join('; ')} to a device granted nothing`)
  } else {
    found('honesty', where, 'pass', 'every withheld field says it was withheld')
  }

  if (axe !== null) await axeOn(page, where, axe)
  if (shots !== null) {
    await page.screenshot({ path: join(shots, `${width.name}-${look.name}.png`), fullPage: true })
  }
}

/**
 * axe, on the page as it stands, and **serious or critical only**.
 *
 * A harness that failed on every `moderate` is one somebody turns off. What is
 * asked here is the half that is not a matter of taste.
 */
const AXE = `axe.run({ runOnly: { type: 'tag',
  values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }).then((answer) =>
  answer.violations
    .filter((one) => one.impact === 'serious' || one.impact === 'critical')
    .map((one) => ({ id: one.id, impact: one.impact, nodes: one.nodes.length,
      at: one.nodes.map((node) => node.target.join(' ')).slice(0, 2).join(', ') })))`

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

function shotsDir(argv: readonly string[]): string | null {
  const at = argv.indexOf('--shots')
  return at < 0 ? null : (argv[at + 1] ?? join(tmpdir(), 'tade-away-shots'))
}

if (shots !== null) await mkdir(shots, { recursive: true })
await run()
process.stdout.write(`${sayReport(findings)}\n`)
if (shots !== null) process.stdout.write(`\npictures in ${shots}\n`)
process.exitCode = exitFor(worstOf(findings))

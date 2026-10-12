import { join } from 'node:path'
import { READY, said } from '../test/browser-plan.ts'
import { HELD_KEY, PRIVATE } from '../test/fixtures.ts'
import { AXE } from './browser-snippets.ts'
import { until } from './browser-until.ts'

// The desk, and an agent looked into, in a real browser.
//
// **On the devices `browser.ts` already pairs**, never a new one: the server
// lets one address pair five times in ten minutes and the harness spends all
// five, so a sixth would be the rate limit working and every check here
// `fail`ing for a reason that is not the page's. The three widths' devices are
// granted nothing — which is the half `lanes` has to be honest about — and the
// one granted everything is at the widest width, which is the half that has
// to draw a screen.
//
// What only a browser can answer, and nothing offline can:
//
// - `desk` — that the frame is the window's shape where there is room for it
//   and a phone's where there is not: projects along the top on a tablet and
//   as a tree in the rail from a desk up,
//   the running agents and Tade in a dock beside the work from a desk up, and
//   none of the three on a phone. The stylesheet decides all of it, so only a
//   laid-out page can say it.
// - `lanes` — that a device not granted agents' screens is told so and is sent
//   no row of one; that one granted them is drawn the rows with the machine's
//   paths and keys gone from them; that axe has nothing to say about the pane
//   once it is drawn; and that **leaving the page stops the asking**, which is
//   what stops the reading at the machine. Counted off the browser's own
//   resource timeline, never a sleep that hopes.

type Verdict = 'pass' | 'fail' | 'unrun'
type Found = (check: string, where: string, verdict: Verdict, what: string) => void

/** What of Playwright's page this file uses, and nothing else. */
interface Page {
  goto: (url: string, opts?: object) => Promise<unknown>
  waitForSelector: (selector: string, opts?: object) => Promise<unknown>
  evaluate: (body: string) => Promise<unknown>
  screenshot: (opts: object) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
  keyboard?: { press: (key: string) => Promise<void>; type: (text: string) => Promise<void> }
}

/** The one task in the fixtures with an agent's screen behind it. */
const TASK = '/t/sentry/away-projection'

/** A row of the fixture's screen that survives the scrubbing, so its presence means drawn. */
const ROW = '4 files touched, the tests pass'

/** Which of the desk's parts are drawn, and how many agents are down the side. */
const DESK = `(() => {
  const shown = (selector) => {
    const one = document.querySelector(selector)
    return one !== null && getComputedStyle(one).display !== 'none' && !one.hidden
  }
  return {
    projects: shown('nav.projects'),
    // Laid out, not only displayed: the tree's own display is a list's at
    // every width, and the rail around it is what is off on a phone.
    tree: (document.querySelector('.rail-tree')?.getClientRects().length ?? 0) > 0 &&
      document.querySelectorAll('.rail-tree .tree-project').length > 0,
    side: shown('nav.side'),
    strip: shown('section.strip'),
    tabs: shown('nav.tabs'),
    agents: document.querySelectorAll('nav.side li a').length,
    lit: document.querySelectorAll('nav.side a[aria-current="page"]').length,
  }
})()`

/** How many times this document has asked about an agent. */
const ASKED = `performance.getEntriesByType('resource')
  .filter((one) => one.name.includes('/api/agent/')).length`

/**
 * The desk's parts at one width, for the device granted nothing.
 *
 * What each width is meant to draw is written here once, against the
 * breakpoints in `frame.css`: 768 for the projects, 1280 for the rest.
 */
export async function deskAt(
  page: Page,
  origin: string,
  width: { name: string; width: number },
  found: Found,
): Promise<void> {
  const where = `the desk @ ${width.name}`
  try {
    await page.goto(`${origin}${TASK}`, { waitUntil: READY })
    await page.waitForSelector('main .section', { timeout: 10_000 })
    const shape = (await page.evaluate(DESK)) as Record<string, boolean | number>
    const desk = width.width >= 1280
    // The projects are chips along the top while the rail is icons, and a
    // tree in the rail once it has its words (`rail.css`).
    const wanted = {
      projects: width.width >= 768 && width.width < 1100,
      tree: width.width >= 1100,
      side: desk,
      strip: desk,
      tabs: width.width < 768,
    }
    const wrong = Object.entries(wanted)
      .filter(([part, on]) => shape[part] !== on)
      .map(([part, on]) => `${part} ${on ? 'missing' : 'drawn'}`)
    if (wrong.length > 0) found('desk', where, 'fail', wrong.join('; '))
    else if (desk && shape.agents !== 4) {
      found('desk', where, 'fail', `${String(shape.agents)} agents down the side, wanted 4`)
    } else if (desk && shape.lit !== 1) {
      found('desk', where, 'fail', `${String(shape.lit)} agents marked as the one open`)
    } else
      found(
        'desk',
        where,
        'pass',
        desk
          ? 'the project tree, agents and Tade around the work'
          : 'the shape this width has room for',
      )
  } catch (problem) {
    found('desk', where, 'fail', said(problem))
    return
  }
  // **Not granted is said, and nothing of the screen is sent.** The pane asks
  // once on opening; its answer for this device is the sentence, and the
  // fixture's rows must be nowhere on the page — nor in what came back.
  const at = `lanes not granted @ ${width.name}`
  try {
    // The pane's own sentence: at a desk the strip says the conversation is
    // not granted either, and that is a different fact.
    await until(page, `document.querySelector('main').innerText.includes('Screen not granted')`)
    const words = String(await page.evaluate('document.body.innerText'))
    if (words.includes(ROW)) found('lanes', at, 'fail', 'a row of its screen is on the page')
    else found('lanes', at, 'pass', 'told it is not granted, and shown no row of it')
  } catch (problem) {
    found('lanes', at, 'fail', said(problem))
  }
}

/**
 * An agent looked into, for the device granted everything, at a desk.
 *
 * Drawn, scrubbed, checked by axe once it is there, photographed, and then
 * left — after which the page must stop asking.
 */
export async function lanesSeen(
  page: Page,
  origin: string,
  axe: string | null,
  shots: string | null,
  found: Found,
): Promise<void> {
  const where = 'an agent’s screen @ desk granted'
  try {
    await page.goto(`${origin}${TASK}`, { waitUntil: READY })
    await until(
      page,
      `(document.querySelector('.screen pre')?.textContent ?? '').includes(${JSON.stringify(ROW)})`,
    )
    const words = String(await page.evaluate(`document.querySelector('.screen pre').textContent`))
    const leaked = [
      PRIVATE.root,
      PRIVATE.credential,
      PRIVATE.opaque,
      HELD_KEY,
      'testperson',
    ].filter((one) => words.includes(one))
    if (leaked.length > 0)
      found('lanes', where, 'fail', `the screen still says ${leaked.join(', ')}`)
    else found('lanes', where, 'pass', 'drawn, with the machine’s paths and keys taken out')
  } catch (problem) {
    found('lanes', where, 'fail', said(problem))
    return
  }
  if (axe !== null) {
    try {
      await page.evaluate(axe)
      const bad = (await page.evaluate(AXE)) as { id: string; impact: string }[]
      if (bad.length === 0) found('axe', where, 'pass', 'nothing serious or critical, screen drawn')
      else found('axe', where, 'fail', bad.map((one) => `${one.id} ${one.impact}`).join('; '))
    } catch (problem) {
      found('axe', where, 'unrun', said(problem))
    }
  }
  if (shots !== null) {
    await page.screenshot({ path: join(shots, 'desk-agent-granted.png'), fullPage: false })
  }
  // **Leaving stops the asking.** A client-side navigation, the way a person
  // leaves — a click on the wordmark — and then two of the pane's own beats.
  const left = 'leaving an agent’s page'
  try {
    await until(page, `${ASKED} >= 2`)
    await page.evaluate(`document.querySelector('header .brand').click()`)
    await page.waitForSelector('main .cards', { timeout: 10_000 })
    const then = Number(await page.evaluate(ASKED))
    // Two beats of the pane's own, and one for a request already in flight.
    await page.waitForTimeout(4_500)
    const now = Number(await page.evaluate(ASKED))
    if (now - then > 1) found('lanes', left, 'fail', `${now - then} more asks after leaving`)
    else found('lanes', left, 'pass', 'the page stopped asking, so the machine stops reading')
  } catch (problem) {
    found('lanes', left, 'fail', said(problem))
  }
}

/** What a page with no session draws around the pairing form. */
const OUTSIDE = `(() => {
  const shown = (selector) => {
    const one = document.querySelector(selector)
    return one !== null && getComputedStyle(one).display !== 'none' && !one.hidden
  }
  return {
    drawn: ['nav.rail', 'nav.tabs', 'nav.projects', 'nav.side', 'section.strip']
      .filter(shown),
    words: document.body.innerText,
    path: location.pathname,
  }
})()`

/**
 * A browser with no session, opened at a deep path, before anything is paired.
 *
 * **It is the pairing screen and nothing else.** It used to be the desk with
 * the form in its middle: a rail into screens it cannot read, *reconnecting*
 * over a stream it never opened, *no agent is running* and talking *not turned
 * on* — every one a claim about a machine it never asked, and together a
 * connection that looked broken when the thing to do was scan the code.
 */
export async function unpairedAt(
  page: Page,
  origin: string,
  width: { name: string },
  found: Found,
): Promise<void> {
  const where = `no session @ ${width.name}`
  try {
    await page.goto(`${origin}/agents`, { waitUntil: READY })
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

/** Where the command bar stands: open or not, what has focus, the rows it offers. */
const BAR = `(() => {
  const bar = document.querySelector('.palette')
  const open = bar !== null && !bar.hidden && getComputedStyle(bar).display !== 'none'
  return {
    open,
    focused: document.activeElement?.getAttribute('role') ?? '',
    rows: [...document.querySelectorAll('.pal-list [role="option"]')].map((one) =>
      (one.querySelector('.pal-label')?.textContent || '').trim()),
    path: location.pathname,
  }
})()`

/**
 * The command bar, in a real browser: `⌘K` opens it with the field focused,
 * what is typed filters where to go, Enter goes there and closes it, and
 * Escape closes it without going back a page. For the device granted nothing,
 * which may go anywhere it can read and may say nothing to Tade — so the bar
 * must offer no message row at all.
 */
export async function paletteAt(
  page: Page,
  origin: string,
  width: { name: string; width: number },
  found: Found,
): Promise<void> {
  const where = `the command bar @ ${width.name}`
  const keys = page.keyboard
  if (keys === undefined) {
    found('palette', where, 'unrun', 'this page has no keyboard to press')
    return
  }
  try {
    await page.goto(`${origin}/`, { waitUntil: READY })
    await page.waitForSelector('main .section', { timeout: 10_000 })
    await keys.press('ControlOrMeta+k')
    await until(page, `document.querySelector('.palette')?.hidden === false`)
    const opened = (await page.evaluate(BAR)) as { open: boolean; focused: string }
    if (opened.focused !== 'combobox') throw new Error(`focus is on ${opened.focused || 'nothing'}`)
    await keys.type('queue')
    const typed = (await page.evaluate(BAR)) as { rows: string[] }
    // The first row is a message to Tade where this device may send one, so
    // the place is lit by the arrow keys, as a person would light it.
    const at = typed.rows.indexOf('Queue')
    if (at < 0 || at > 1) throw new Error(`typing queue offered ${typed.rows.join(', ')}`)
    for (let step = 0; step < at; step += 1) await keys.press('ArrowDown')
    await keys.press('Enter')
    await until(page, `location.pathname === '/queue'`)
    const went = (await page.evaluate(BAR)) as { open: boolean }
    if (went.open) throw new Error('it stayed open after going')
    await keys.press('ControlOrMeta+k')
    await until(page, `document.querySelector('.palette')?.hidden === false`)
    await keys.press('Escape')
    await until(page, `document.querySelector('.palette')?.hidden === true`)
    const shut = (await page.evaluate(BAR)) as { path: string }
    if (shut.path !== '/queue') throw new Error(`Escape went back to ${shut.path}`)
    found('palette', where, 'pass', 'opened by the keys, filtered, went, and closed in place')
  } catch (problem) {
    found('palette', where, 'fail', said(problem))
  }
}

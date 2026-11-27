import { READY, said } from '../test/browser-plan.ts'
import { until } from './browser-until.ts'

// `queue`: a piece of queued work down the side, pressed the way a person
// would, on the acting device `browser.ts` paired — at a small
// phone's width and a large one's.
//
// Its ⋯ is a whole target, a tap on it opens the window's own queued-work menu
// read off the machine, holding the row down opens the same menu without
// following the link, and a tap on one of its items asks the window for
// exactly one act, through the same door every control uses.

type Verdict = 'pass' | 'fail' | 'unrun'
type Found = (check: string, where: string, verdict: Verdict, what: string) => void

/** What of Playwright's page this file uses, and nothing else. */
interface Page {
  goto: (url: string, opts?: object) => Promise<unknown>
  evaluate: (body: string) => Promise<unknown>
  url: () => string
  setViewportSize: (size: { width: number; height: number }) => Promise<void>
  waitForTimeout: (ms: number) => Promise<void>
  locator: (selector: string, opts?: object) => { first: () => { tap: () => Promise<void> } }
  context: () => {
    newCDPSession: (page: unknown) => Promise<{
      send: (method: string, params: object) => Promise<unknown>
      detach: () => Promise<void>
    }>
  }
}

/** The two phones the person holds: the narrow screen and the wide one. */
export const PHONES = [
  { name: 'small phone', width: 360, height: 780 },
  { name: 'large phone', width: 430, height: 932 },
] as const

/** The queued piece's ⋯, its row and what the page draws of both. */
const PIECE = `(() => {
  const line = document.querySelector('aside.side .side-queue .side-line')
  if (line === null) return null
  const more = line.querySelector('.side-acts:not([hidden]) button')
  const link = line.querySelector('.side-piece')
  const box = (one) => {
    const at = one.getBoundingClientRect()
    return { x: at.x + at.width / 2, y: at.y + at.height / 2, w: at.width, h: at.height }
  }
  return {
    more: more === null ? null : { ...box(more), label: more.getAttribute('aria-label') || '' },
    link: box(link),
  }
})()`

/** The menu's items as drawn, once it has been answered. */
const MENU = `(() => {
  const sheet = document.querySelector('.amenu')
  if (sheet === null || sheet.hidden) return null
  const items = [...sheet.querySelectorAll('.amenu-item .amenu-label')].map((one) => one.textContent)
  return items.length === 0 ? null : items
})()`

/** Which step a check is on, so a wait that runs out says which. */
let step = ''

/** The side open, as a drawer below a desk. */
async function sideOpen(page: Page): Promise<void> {
  await page.evaluate(
    `getComputedStyle(document.querySelector('aside.side')).display === 'none' &&
      document.querySelector('nav.tabs button[aria-controls="side"]').click()`,
  )
  step = 'the side opened'
  await until(page, `getComputedStyle(document.querySelector('aside.side')).display !== 'none'`)
  await until(
    page,
    `document.querySelector('aside.side .side-queue .side-acts:not([hidden])') !== null`,
  )
}

/**
 * Drive the queued piece at each phone's width. `asked` is what the harness's
 * window was asked, in order, so a press is counted where it lands.
 */
export async function queueAt(
  page: Page,
  origin: string,
  found: Found,
  asked: readonly { verb: string; task: string }[],
  task: string,
): Promise<void> {
  for (const phone of PHONES) {
    const at = `the queue @ ${phone.name}`
    try {
      await page.setViewportSize({ width: phone.width, height: phone.height })
      await page.goto(`${origin}/`, { waitUntil: READY })
      await sideOpen(page)
      const piece = (await page.evaluate(PIECE)) as {
        more: { x: number; y: number; w: number; h: number; label: string } | null
        link: { x: number; y: number }
      } | null
      if (piece === null || piece.more === null) throw new Error('no ⋯ on the queued piece')
      if (piece.more.w < 44 || piece.more.h < 44) {
        throw new Error(`its ⋯ is ${Math.round(piece.more.w)}×${Math.round(piece.more.h)}px`)
      }

      // A tap on the ⋯: the window's own menu, cut to what this device may ask.
      await page.locator(`aside.side button[aria-label="${piece.more.label}"]`).first().tap()
      step = 'the ⋯ opened its menu'
      await until(page, `${MENU} !== null`)
      const items = (await page.evaluate(MENU)) as string[]
      for (const want of ['Start now', 'Do this one first', 'Pause', 'Wait for a retry']) {
        if (!items.includes(want)) throw new Error(`its menu has no ${want}: ${items.join(', ')}`)
      }

      // A tap on Pause asks for exactly one act: the queue's, about this task.
      const before = asked.length
      await page.locator('.amenu .amenu-item', { hasText: 'Pause' }).first().tap()
      // Answered when the sheet is no longer busy and says what came of it, in
      // the machine's words for the verb.
      step = 'Pause was answered'
      await until(
        page,
        `!document.querySelector('.amenu').hasAttribute('aria-busy') &&
          document.querySelector('.amenu-said').textContent !== ''`,
      )
      const sent = asked.slice(before)
      if (sent.length !== 1 || sent[0]?.verb !== 'queue' || sent[0]?.task !== task) {
        throw new Error(
          `Pause asked for ${sent.map((one) => `${one.verb} ${one.task}`).join(', ')}`,
        )
      }
      // Closed as a thumb closes it, with the sheet's own Close.
      step = 'Close shut the menu'
      await page.locator('.amenu button[aria-label="Close"]').first().tap()
      await until(page, `document.querySelector('.amenu').hidden`)

      // Held down, the row opens the same menu and is not followed as a link.
      await sideOpen(page)
      const was = page.url()
      const touch = await page.context().newCDPSession(page)
      // Where the row is now: the tap above may have scrolled the drawer.
      const held = (await page.evaluate(PIECE)) as { link: { x: number; y: number } } | null
      if (held === null) throw new Error('the queued piece went from the side')
      const point = { x: held.link.x, y: held.link.y }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      await page.waitForTimeout(700)
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await touch.detach()
      step = 'a hold opened its menu'
      await until(page, `${MENU} !== null`)
      // And stays open once the finger is up: the click a release makes is not a tap on its scrim.
      step = 'its menu stayed open after the hold'
      await page.waitForTimeout(500)
      if ((await page.evaluate(MENU)) === null) throw new Error('the release shut the menu')
      if (page.url() !== was) throw new Error(`holding the row went to ${page.url()}`)
      step = 'Close shut it again'
      await page.locator('.amenu button[aria-label="Close"]').first().tap()
      await until(page, `document.querySelector('.amenu').hidden`)
      found(
        'queue',
        at,
        'pass',
        `a ${Math.round(piece.more.h)}px ⋯ and a hold open its menu; Pause asked for one queue act`,
      )
    } catch (problem) {
      found('queue', at, 'fail', `${step}: ${said(problem)}`)
    }
  }
}

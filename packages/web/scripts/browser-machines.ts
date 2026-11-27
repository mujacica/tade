import { READY, said } from '../test/browser-plan.ts'
import { PHONES } from './browser-queue.ts'
import { until } from './browser-until.ts'

// `machines`: the Machines page drawn for a paired device, at a small phone's
// width and a large one's.
//
// Asked of the acting device `browser.ts` already paired — a sixth pairing
// would pass the server's five per address — and asks what a browser alone
// can: that the grid the window hands over is drawn,
// a line per machine for every item and nothing refused, and that it fits a
// phone with every control big enough for a thumb.

type Verdict = 'pass' | 'fail' | 'unrun'
type Found = (check: string, where: string, verdict: Verdict, what: string) => void

/** What of Playwright's page this file uses, and nothing else. */
interface Page {
  goto: (url: string, opts?: object) => Promise<unknown>
  evaluate: (body: string) => Promise<unknown>
  setViewportSize: (size: { width: number; height: number }) => Promise<void>
  waitForTimeout: (ms: number) => Promise<void>
}

/** What the harness answered the page, so the drawing is held to it rather than to a literal. */
export interface Grid {
  machines: readonly string[]
  rows: readonly { label: string; cells: number }[]
}

/** Answered, or refused: the grid's body shown, or the state box before it. */
const SETTLED = `(() => {
  const body = document.querySelector('main .mc-body')
  return body !== null && (!body.hidden || (body.previousElementSibling?.textContent ?? '') !== '')
})()`

/** The page as drawn: its machines, each item with its lines, and what does not fit. */
const GRID = `(() => {
  const body = document.querySelector('main .mc-body')
  const main = document.querySelector('main')
  const seen = (one) => one.getClientRects().length > 0
  const wide = innerWidth
  return {
    refused: body.hidden ? (body.previousElementSibling?.textContent ?? '').trim() : null,
    machines: [...body.querySelectorAll('.mc-machines .mc-machine .mc-name')].map((one) => one.textContent),
    rows: [...body.querySelectorAll('.mc-groups .mc-item')].map((one) => ({
      label: one.querySelector('.mc-label')?.textContent ?? '',
      cells: one.querySelectorAll('.mc-cell').length,
    })),
    wider: [...body.querySelectorAll('*')]
      .filter((one) => seen(one) && one.getBoundingClientRect().right > wide + 1)
      .slice(0, 3)
      .map((one) => (one.className || one.tagName) + ' to ' + Math.round(one.getBoundingClientRect().right) + 'px'),
    sideways: main.scrollWidth - main.clientWidth,
    small: [...body.querySelectorAll('button, a[href]')]
      .filter((one) => seen(one) && one.getBoundingClientRect().height < 44)
      .map((one) => (one.textContent || '').trim() + ' ' + Math.round(one.getBoundingClientRect().height) + 'px'),
  }
})()`

interface Drawn {
  refused: string | null
  machines: string[]
  rows: { label: string; cells: number }[]
  wider: string[]
  sideways: number
  small: string[]
}

/** The Machines page at each phone's width, on a device that is the person's own. */
export async function machinesAt(
  page: Page,
  origin: string,
  found: Found,
  grid: Grid,
): Promise<void> {
  for (const phone of PHONES) {
    const at = `machines @ ${phone.name}`
    try {
      await page.setViewportSize({ width: phone.width, height: phone.height })
      await page.goto(`${origin}/machines`, { waitUntil: READY })
      await until(page, SETTLED)
      const drawn = (await page.evaluate(GRID)) as Drawn
      if (drawn.refused !== null)
        throw new Error(`refused the person's own device: ${drawn.refused}`)
      const machines = drawn.machines.join(', ')
      if (machines !== grid.machines.join(', ')) {
        throw new Error(`drew machines ${machines || 'none'}; wanted ${grid.machines.join(', ')}`)
      }
      const rows = drawn.rows.map((one) => `${one.label}×${one.cells}`).join(', ')
      const wanted = grid.rows.map((one) => `${one.label}×${one.cells}`).join(', ')
      if (rows !== wanted) throw new Error(`drew items ${rows || 'none'}; wanted ${wanted}`)
      if (drawn.sideways > 1 || drawn.wider.length > 0) {
        throw new Error(`wider than the screen: ${drawn.wider.join('; ') || `${drawn.sideways}px`}`)
      }
      if (drawn.small.length > 0) {
        throw new Error(`too small to hit: ${drawn.small.slice(0, 3).join('; ')}`)
      }
      found(
        'machines',
        at,
        'pass',
        `${drawn.machines.length} machines and ${drawn.rows.length} items drawn, a line per machine each, and it fits`,
      )
    } catch (problem) {
      found('machines', at, 'fail', said(problem))
    }
  }
}

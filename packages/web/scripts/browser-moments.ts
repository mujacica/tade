import { said } from '../test/browser-plan.ts'
import { until } from './browser-until.ts'

// `moments`: an agent's timeline read on to its first moment in a real
// browser. The answer carries the newest stretch; scrolled with the wheel, as a
// person scrolls, the list reads the moments before out of the machine until it
// reaches the agent's making — every one drawn once, newest first, and nothing
// saying older moments were not sent.

type Verdict = 'pass' | 'fail' | 'unrun'
type Found = (check: string, where: string, verdict: Verdict, what: string) => void

/** What of Playwright's page this file uses, and nothing else. */
interface Page {
  goto: (url: string, opts?: object) => Promise<unknown>
  evaluate: (body: string) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
  mouse: {
    move: (x: number, y: number) => Promise<void>
    wheel: (dx: number, dy: number) => Promise<void>
  }
}

const TASK = '/t/sentry/away-projection'

const DRAWN = `(() => {
  const items = [...document.querySelectorAll('#ag-time .ag-moments > li')]
  return {
    n: items.length,
    last: items.at(-1)?.querySelector('.name')?.textContent ?? '',
    said: document.querySelector('#ag-time')?.textContent ?? '',
  }
})()`

interface Drawn {
  n: number
  last: string
  said: string
}

/** The whole of `moments` at one width: `all` moments, `newest` of them on the answer. */
export async function momentsAt(
  page: Page,
  origin: string,
  at: string,
  found: Found,
  all: number,
  newest: number,
): Promise<void> {
  const where = `an agent’s timeline @ ${at}`
  try {
    await page.goto(`${origin}${TASK}`, { waitUntil: 'load' })
    await until(page, `document.querySelectorAll('#ag-time .ag-moments > li').length >= ${newest}`)
    const opened = (await page.evaluate(DRAWN)) as Drawn
    const box = (await page.evaluate(
      `(() => { const l = document.querySelector('#ag-time .ag-moments'); l.scrollIntoView({ block: 'center' }); const r = l.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 120) } })()`,
    )) as { x: number; y: number }
    await page.mouse.move(box.x, box.y)
    let now = opened
    for (let notch = 0; notch < 120 && now.n < all; notch += 1) {
      await page.mouse.wheel(0, 1_500)
      await page.waitForTimeout(80)
      now = (await page.evaluate(DRAWN)) as Drawn
    }
    if (now.n !== all) {
      throw new Error(`${now.n} of ${all} moments drawn after scrolling to the end of the list`)
    }
    if (now.last !== 'was made') {
      throw new Error(`the last moment drawn says “${now.last}”, not its making`)
    }
    if (/not sent|older moments|elsewhere/.test(now.said)) {
      throw new Error('the timeline says some of its moments are elsewhere')
    }
    found(
      'moments',
      where,
      'pass',
      `all ${all} moments read on from ${opened.n} on the answer, to its making`,
    )
  } catch (problem) {
    found('moments', where, 'fail', said(problem))
  }
}

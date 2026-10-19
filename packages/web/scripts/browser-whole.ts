import { said } from '../test/browser-plan.ts'
import { until } from './browser-until.ts'

// `whole`: a text of over ten thousand characters, drawn whole in a real
// browser. Every text crosses whole (`BUDGET` in `page.ts`); this is the page's
// half — the note opened is every character of it, its box scrolls in place
// rather than pushing the page a screen away, the keyboard can reach the box
// it scrolls in, and nothing says more was written somewhere else.

type Verdict = 'pass' | 'fail' | 'unrun'
type Found = (check: string, where: string, verdict: Verdict, what: string) => void

/** What of Playwright's page this file uses, and nothing else. */
interface Page {
  goto: (url: string, opts?: object) => Promise<unknown>
  evaluate: (body: string) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
}

/** The note: no summary, so its card is its words, folded until a press. */
export const WHOLE_NOTE = `${Array.from({ length: 600 }, (_, n) => `the whole of it, line ${n} — 🔧`).join('\n')}\nand this is where it ends`

const FIND = `[...document.querySelectorAll('.page-notes .nt-card.is-plain .said')].find((one) => one.textContent.startsWith('the whole of it, line 0'))`

interface Drawn {
  whole: boolean
  scrolls: boolean
  reachable: boolean
  said: string
}

export async function wholeAt(page: Page, origin: string, at: string, found: Found): Promise<void> {
  const where = `a long note @ ${at}`
  let step = ''
  try {
    await page.goto(`${origin}/notes`, { waitUntil: 'load' })
    step = 'the note was never drawn'
    await until(page, `Boolean(${FIND})`)
    await page.evaluate(
      `(() => { const box = ${FIND}; box.scrollIntoView({ block: 'center' }); box.parentElement.querySelector('button.more')?.click() })()`,
    )
    step = 'its box never let the keyboard in'
    await until(page, `(${FIND}).getAttribute('tabindex') === '0'`)
    step = ''
    const drawn = (await page.evaluate(`(() => {
      const box = ${FIND}
      return {
        whole: box.textContent === ${JSON.stringify(WHOLE_NOTE)},
        scrolls: box.scrollHeight > box.clientHeight + 1 && box.clientHeight > 0,
        reachable: box.tabIndex === 0,
        said: box.closest('.nt-card').textContent,
      }
    })()`)) as Drawn
    const problems = [
      drawn.whole ? null : 'the note drawn is not every character of it',
      drawn.scrolls ? null : 'its box does not scroll in place',
      drawn.reachable ? null : 'the keyboard cannot reach the box it scrolls in',
      /more than this|written down|not shown|not drawn/.test(drawn.said)
        ? 'something says more was written elsewhere'
        : null,
    ].filter((one) => one !== null)
    found(
      'whole',
      where,
      problems.length === 0 ? 'pass' : 'fail',
      problems.length === 0
        ? `all ${WHOLE_NOTE.length} characters drawn, scrolling in a box the keyboard reaches`
        : problems.join('; '),
    )
  } catch (problem) {
    found('whole', where, 'fail', step === '' ? said(problem) : `${step}: ${said(problem)}`)
  }
}

import { READY, said } from '../test/browser-plan.ts'
import { PHONES } from './browser-queue.ts'
import { until } from './browser-until.ts'

// `accounts`: the Accounts page drawn for the person's own device, at a small
// phone's width and a large one's — Settings › Accounts with a tab per machine.
//
// Asked, like `machines`, of the acting device once `browser.ts` has granted it
// every scope at the machine. What a browser alone can say: that a tab is drawn
// for each machine the window hands over and each tab's accounts under it, that
// pressing another machine's tab draws that machine's, and that both fit a
// phone — nothing wider than the screen, every control big enough for a thumb.

type Verdict = 'pass' | 'fail' | 'unrun'
type Found = (check: string, where: string, verdict: Verdict, what: string) => void

/** What of Playwright's page this file uses, and nothing else. */
interface Page {
  goto: (url: string, opts?: object) => Promise<unknown>
  evaluate: (body: string) => Promise<unknown>
  setViewportSize: (size: { width: number; height: number }) => Promise<void>
  waitForTimeout: (ms: number) => Promise<void>
}

/** What the harness answered the page for each tab, so the drawing is held to it. */
export interface Tabs {
  tabs: readonly string[]
  /** Each tab's account names, in the order the machine said them. */
  accounts: readonly (readonly string[])[]
}

/** Answered, or refused: the body shown with its accounts, or the state box before it. */
const SETTLED = `(() => {
  const body = document.querySelector('main .ac-body')
  if (body === null) return false
  if (body.hidden) return (body.previousElementSibling?.textContent ?? '') !== ''
  return body.querySelectorAll('.ac-name').length > 0
})()`

/** The second tab pressed: another machine's accounts asked for. */
const SECOND = `(() => {
  const tab = document.querySelectorAll('main .ac-tab')[1]
  if (tab === undefined) return false
  tab.click()
  return true
})()`

/** The second tab's accounts drawn. */
const THERE = `(() => document.querySelectorAll('main .ac-tab')[1]?.getAttribute('aria-pressed') === 'true' &&
  document.querySelectorAll('main .ac-name').length > 0)()`

/** The page as drawn: its tabs, its accounts, and what does not fit. */
const DRAWN = `(() => {
  const body = document.querySelector('main .ac-body')
  const main = document.querySelector('main')
  const seen = (one) => one.getClientRects().length > 0
  const wide = innerWidth
  return {
    refused: body.hidden ? (body.previousElementSibling?.textContent ?? '').trim() : null,
    tabs: [...body.querySelectorAll('.ac-tab')].map((one) => one.textContent),
    accounts: [...body.querySelectorAll('.ac-name')].map((one) => one.textContent),
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
  tabs: string[]
  accounts: string[]
  wider: string[]
  sideways: number
  small: string[]
}

/** One tab as drawn, held to what was answered and to the screen. */
function held(drawn: Drawn, wanted: Tabs, at: number): void {
  if (drawn.refused !== null) throw new Error(`refused the person's own device: ${drawn.refused}`)
  const tabs = drawn.tabs.join(', ')
  if (tabs !== wanted.tabs.join(', ')) {
    throw new Error(`drew tabs ${tabs || 'none'}; wanted ${wanted.tabs.join(', ')}`)
  }
  const accounts = drawn.accounts.join(', ')
  const want = (wanted.accounts[at] ?? []).join(', ')
  if (accounts !== want)
    throw new Error(`tab ${at + 1} drew ${accounts || 'nothing'}; wanted ${want}`)
  if (drawn.sideways > 1 || drawn.wider.length > 0) {
    throw new Error(`wider than the screen: ${drawn.wider.join('; ') || `${drawn.sideways}px`}`)
  }
  if (drawn.small.length > 0)
    throw new Error(`too small to hit: ${drawn.small.slice(0, 3).join('; ')}`)
}

/** The Accounts page at each phone's width, on a device that is the person's own. */
export async function accountsAt(page: Page, origin: string, found: Found, wanted: Tabs) {
  for (const phone of PHONES) {
    const at = `accounts @ ${phone.name}`
    try {
      await page.setViewportSize({ width: phone.width, height: phone.height })
      await page.goto(`${origin}/accounts`, { waitUntil: READY })
      await until(page, SETTLED)
      held((await page.evaluate(DRAWN)) as Drawn, wanted, 0)
      if (!(await page.evaluate(SECOND))) throw new Error('drew no second tab to press')
      await until(page, THERE)
      held((await page.evaluate(DRAWN)) as Drawn, wanted, 1)
      found(
        'accounts',
        at,
        'pass',
        `${wanted.tabs.length} machines' tabs drawn, each one's accounts under it, and it fits`,
      )
    } catch (problem) {
      found('accounts', at, 'fail', said(problem))
    }
  }
}

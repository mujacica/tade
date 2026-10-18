import type { ChatIn, TalkIn } from '../src/input.ts'
import { READY, said } from '../test/browser-plan.ts'
import { talk } from '../test/fixtures.ts'
import { until } from './browser-until.ts'

// The conversation with Tade read as a chat, in a real browser.
//
// **On the device `browser.ts` already granted everything**, never a new one:
// the server lets one address pair five times in ten minutes and the harness
// spends all five.
//
// What only a laid-out page can answer — `chat`:
//
// - that the conversation opens at its newest line, and opens there again on
//   a reload;
// - that a line arriving while the reader is at the foot keeps them there;
// - that scrolling up lets go — a line arriving then leaves the view where
//   the reader put it — and draws the press back down;
// - that the press goes back to the newest line, hides, and follows again.

type Verdict = 'pass' | 'fail' | 'unrun'
type Found = (check: string, where: string, verdict: Verdict, what: string) => void

/** What of Playwright's page this file uses, and nothing else. */
interface Page {
  goto: (url: string, opts?: object) => Promise<unknown>
  reload: (opts?: object) => Promise<unknown>
  waitForSelector: (selector: string, opts?: object) => Promise<unknown>
  evaluate: (body: string) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
  mouse: {
    move: (x: number, y: number) => Promise<void>
    wheel: (dx: number, dy: number) => Promise<void>
  }
}

/** How many lines of Tade's own news go before the fixture's, so there is a conversation to scroll. */
const FILLER = 40

/**
 * The conversation the harness serves: forty lines of news and calls, then the
 * fixture's own four — whose paths and keys the other checks look for — and
 * `more` lines after, which is how a check makes one arrive.
 */
export function harnessTalk(more = 0): TalkIn {
  const fixture = talk()
  const at = (n: number) => Date.parse('2026-10-08T13:00:00.000Z') + n * 1000
  const lineAt = (n: number, over: Partial<ChatIn>): ChatIn => ({
    id: `${new Date(at(n)).toISOString()}#0`,
    at: at(n),
    kind: 'tade',
    from: '',
    text: '',
    tool: '',
    outcome: '',
    call: null,
    streaming: false,
    ...over,
  })
  const filler = Array.from({ length: FILLER }, (_, n) =>
    n % 4 === 3
      ? lineAt(n, {
          kind: 'tool',
          tool: 'tade_plan',
          outcome: n % 8 === 7 ? 'failed' : 'ok',
          call: { input: { project: 'sentry', prompt: `step ${n}` }, result: 'planned' },
        })
      : lineAt(n, { kind: 'tade', text: `started sentry/step-${n}: there was room for it` }),
  )
  const after = Array.from({ length: more }, (_, n) =>
    lineAt(10_000 + n, { kind: 'reply', text: `**Arrived** while you were reading, ${n + 1}.` }),
  )
  return { ...fixture, lines: [...filler, ...fixture.lines, ...after] }
}

/** Where `main` is scrolled, and whether the press back down is showing. */
const WHERE = `(() => {
  const main = document.querySelector('main')
  const press = document.querySelector('main .jump-latest')
  return {
    room: main.scrollHeight - main.clientHeight,
    top: main.scrollTop,
    gap: main.scrollHeight - main.scrollTop - main.clientHeight,
    press: press !== null && !press.hidden && getComputedStyle(press).display !== 'none',
    lines: document.querySelectorAll('main ul.chat > li').length,
  }
})()`

interface Where {
  room: number
  top: number
  gap: number
  press: boolean
  lines: number
}

const AT_FOOT = `(() => { const m = document.querySelector('main'); return m.scrollHeight - m.scrollTop - m.clientHeight <= 48 })()`

/**
 * The whole of `chat` at one width. `arrive` makes the machine send one more
 * line to this device, as a delta on its stream.
 */
export async function chatAt(
  page: Page,
  origin: string,
  at: string,
  arrive: () => Promise<void>,
  found: Found,
): Promise<void> {
  const where = `the conversation @ ${at}`
  const read = async () => (await page.evaluate(WHERE)) as Where
  try {
    await page.goto(`${origin}/talk`, { waitUntil: READY })
    await page.waitForSelector('main ul.chat > li', { timeout: 10_000 })
    const first = await read()
    if (first.room <= 0) {
      found('chat', where, 'unrun', `${first.lines} lines fit on the screen: nothing to scroll`)
      return
    }
    await until(page, AT_FOOT, 5_000).catch(() => {
      throw new Error(`opened ${String(first.gap)}px above the newest line`)
    })
    await page.reload({ waitUntil: READY })
    await page.waitForSelector('main ul.chat > li', { timeout: 10_000 })
    await until(page, AT_FOOT, 5_000).catch(() => {
      throw new Error('a reload did not open at the newest line')
    })

    // At the foot, a line arriving keeps the reader there.
    const before = (await read()).lines
    await arrive()
    await until(page, `document.querySelectorAll('main ul.chat > li').length > ${before}`)
    await until(page, AT_FOOT, 5_000).catch(async () => {
      const now = await read()
      throw new Error(
        `a line arrived at the foot and the view stayed ${now.gap}px above it (scrolled ${now.top} of ${now.room}, press ${now.press ? 'showing' : 'hidden'})`,
      )
    })

    // Scrolled up, as a person scrolls — the wheel over the conversation —
    // it lets go: the press shows, and what arrives moves nothing.
    const box = (await page.evaluate(
      `(() => { const r = document.querySelector('main ul.chat').getBoundingClientRect(); return { x: r.left + r.width / 2, y: Math.max(r.top, 0) + 120 } })()`,
    )) as { x: number; y: number }
    await page.mouse.move(box.x, box.y)
    await page.mouse.wheel(0, -100_000)
    await until(page, `(${WHERE}).press`, 5_000).catch(() => {
      throw new Error('scrolled up and no press back to the newest line')
    })
    const up = await read()
    if (up.top > 48) throw new Error(`the wheel left the view ${up.top}px down`)
    await arrive()
    await until(page, `document.querySelectorAll('main ul.chat > li').length > ${up.lines}`)
    await page.waitForTimeout(300)
    const stayed = await read()
    if (stayed.top > 48) {
      throw new Error(`a line arrived while reading and pulled the view down to ${stayed.top}px`)
    }

    // The press goes back down, hides, and follows again.
    await page.evaluate(`document.querySelector('main .jump-latest').click()`)
    await until(page, AT_FOOT, 5_000).catch(() => {
      throw new Error('the press did not go back to the newest line')
    })
    await until(page, `!(${WHERE}).press`, 5_000).catch(() => {
      throw new Error('back at the newest line and the press still showing')
    })
    found(
      'chat',
      where,
      'pass',
      'opens and reloads at the newest line, follows it, lets go when scrolled up, and one press comes back',
    )
  } catch (problem) {
    found('chat', where, 'fail', said(problem))
  }
}

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
//
// And `back`: a conversation longer than one page of the snapshot is read
// back to its first line as the reader scrolls up — each page put above
// without moving the line they were looking at, every line there once and in
// the order it was said, and no line saying the rest is somewhere else.
//
// And `call`: a call with no id to ask its answer by — one you ran yourself,
// whose answer only the window holds — opened with a real tap, shows the whole
// of the long answer it came with, and nothing says the rest is elsewhere.

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
    click: (x: number, y: number) => Promise<void>
    move: (x: number, y: number) => Promise<void>
    wheel: (dx: number, dy: number) => Promise<void>
  }
}

/**
 * How many lines of Tade's own news go before the fixture's: more than one
 * page of the snapshot (`BUDGET.chat`), so the page has to read back through
 * the rest of it.
 */
const FILLER = 300

/** The last of the filler's calls: no id, and an answer two thousand lines long. */
const LONG_AT = FILLER - 1
const LONG_ANSWER = Array.from({ length: 2_000 }, (_, n) => `planned step ${n + 1}`).join('\n')

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
          call: {
            input: { project: 'sentry', prompt: `step ${n}` },
            result: n === LONG_AT ? LONG_ANSWER : 'planned',
          },
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
  /** Every line's id the machine holds of this conversation now, oldest first. */
  held: () => readonly string[],
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

    await backAt(page, where, found, held)

    // Scrolled up, as a person scrolls — the wheel over the conversation —
    // it lets go: the press shows, and what arrives moves nothing.
    const box = (await page.evaluate(
      `(() => { const r = document.querySelector('main ul.chat').getBoundingClientRect(); return { x: r.left + r.width / 2, y: Math.max(r.top, 0) + 120 } })()`,
    )) as { x: number; y: number }
    await page.mouse.move(box.x, box.y)
    // A long conversation is more than one turn of the wheel: as many as it takes.
    for (let notch = 0; notch < 40; notch += 1) {
      await page.mouse.wheel(0, -100_000)
      await page.waitForTimeout(50)
      if ((await read()).top <= 48) break
    }
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
  await callAt(page, where, found)
}

/** The row of the call with no id and a long answer, as the page drew it. */
const LONG_ROW = `[...document.querySelectorAll('main ul.chat > li')].find((li) => li.textContent.includes('"step ${LONG_AT}"'))`

/** Where the long call's press is, brought into view, to be tapped where a thumb would. */
const LONG_PRESS = `(() => {
  const press = ${LONG_ROW}?.querySelector('button.ui-call-press')
  if (!press || press.hidden) return null
  press.scrollIntoView({ block: 'center' })
  const r = press.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`

/** What the opened row shows of what it answered. */
const LONG_OPENED = `(() => {
  const body = ${LONG_ROW}?.querySelector('.ui-call-body')
  if (!body || body.hidden) return null
  const shown = [...body.querySelectorAll('pre')].filter((pre) => !pre.parentElement.hidden)
  return { answer: shown.at(-1)?.textContent ?? '', said: body.textContent }
})()`

/** `call`: the long answer of a call with no id, opened with a tap, whole. */
async function callAt(page: Page, where: string, found: Found): Promise<void> {
  try {
    const press = (await page.evaluate(LONG_PRESS)) as { x: number; y: number } | null
    if (press === null) throw new Error(`no press for the call of step ${LONG_AT}`)
    await page.mouse.click(press.x, press.y)
    await until(page, `${LONG_OPENED} !== null`, 5_000).catch(() => {
      throw new Error('tapped, and the call did not open')
    })
    const opened = (await page.evaluate(LONG_OPENED)) as { answer: string; said: string }
    const lines = opened.answer.split('\n')
    if (opened.answer !== LONG_ANSWER) {
      throw new Error(
        `opened onto ${lines.length} of ${LONG_ANSWER.split('\n').length} lines, the last ${JSON.stringify(lines.at(-1))}`,
      )
    }
    const elsewhere = /not on this page|not written down|Reading what it answered|more than/.exec(
      opened.said,
    )
    if (elsewhere !== null) throw new Error(`the opened call says "${elsewhere[0]}"`)
    found('call', where, 'pass', `a tap opens all ${lines.length} lines of an answer with no id`)
  } catch (problem) {
    found('call', where, 'fail', said(problem))
  }
}

/** The ids of the lines drawn, in the order they are drawn, and whether a page is being read. */
const DRAWN = `(() => ({
  ids: [...document.querySelectorAll('main ul.chat > li')].map((li) => li.getAttribute('data-key')),
  reading: [...document.querySelectorAll('main .chat-reading')].some((one) => !one.hidden),
  said: document.querySelector('main').textContent,
}))()`

/**
 * Scroll up to near the top, as a script and not the wheel, and note the line
 * at the top of the view and where it is — in the same task, so before any
 * answer to the read this scroll asks for can have arrived.
 */
const NEAR_THE_TOP = `(() => {
  const main = document.querySelector('main')
  main.scrollTop = 120
  const top = main.getBoundingClientRect().top
  const rows = [...document.querySelectorAll('main ul.chat > li')]
  const li = rows.find((one) => one.getBoundingClientRect().top >= top)
  window.__anchor = { key: li.getAttribute('data-key'), y: li.getBoundingClientRect().top - top, lines: rows.length }
  return window.__anchor
})()`

/** Where the noted line is now, from the top of the view. */
const ANCHOR_NOW = `(() => {
  const li = document.querySelector('main ul.chat > li[data-key="' + window.__anchor.key + '"]')
  const top = document.querySelector('main').getBoundingClientRect().top
  return li === null ? null : li.getBoundingClientRect().top - top
})()`

/**
 * The screen at rest: built, at its newest line, and done rising in — a row
 * measured while the screen's own entrance still moves it would read as the
 * view having moved.
 */
const AT_REST = `(() => {
  const main = document.querySelector('main')
  const screen = main.querySelector('.enter')
  const moving = screen !== null && screen.getAnimations().some((one) => one.playState === 'running')
  return !moving && main.scrollHeight - main.scrollTop - main.clientHeight <= 48
})()`

interface Drawn {
  ids: string[]
  reading: boolean
  said: string
}

/** The whole of `back` at one width: read back to the first line, the view held still. */
async function backAt(
  page: Page,
  where: string,
  found: Found,
  held: () => readonly string[],
): Promise<void> {
  try {
    const drawn = async () => (await page.evaluate(DRAWN)) as Drawn
    const opened = await drawn()
    const all = held()
    if (opened.ids.length >= all.length) {
      found(
        'back',
        where,
        'unrun',
        `all ${all.length} lines came on the snapshot: nothing to read back`,
      )
      return
    }
    // One page read back, and the line the reader was on did not move.
    await until(page, AT_REST, 5_000)
    await page.waitForTimeout(200)
    const anchor = (await page.evaluate(NEAR_THE_TOP)) as { key: string; y: number; lines: number }
    await until(
      page,
      `document.querySelectorAll('main ul.chat > li').length > ${anchor.lines}`,
      5_000,
    ).catch(() => {
      throw new Error(
        `scrolled near the top of ${anchor.lines} lines and nothing before them was read`,
      )
    })
    await page.waitForTimeout(100)
    const moved = (await page.evaluate(ANCHOR_NOW)) as number | null
    if (moved === null) throw new Error('the line the reader was on is gone after reading back')
    if (Math.abs(moved - anchor.y) > 2) {
      throw new Error(
        `reading back moved the line the reader was on by ${Math.round(moved - anchor.y)}px`,
      )
    }
    // Then the wheel, as a person scrolls, until it reaches the first line said.
    const box = (await page.evaluate(
      `(() => { const r = document.querySelector('main ul.chat').getBoundingClientRect(); return { x: r.left + r.width / 2, y: Math.max(r.top, 0) + 120 } })()`,
    )) as { x: number; y: number }
    await page.mouse.move(box.x, box.y)
    for (let notch = 0; notch < 80; notch += 1) {
      const now = await drawn()
      if (now.ids.length >= all.length && !now.reading) break
      await page.mouse.wheel(0, -2_000)
      await page.waitForTimeout(60)
    }
    const end = await drawn()
    const missing = all.filter((id) => !end.ids.includes(id))
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} of ${all.length} lines never drawn, the first ${missing[0]}`,
      )
    }
    if (end.ids.join('\n') !== all.join('\n')) {
      throw new Error('every line is drawn, but not once each in the order it was said')
    }
    if (/earlier|in the window/.test(end.said)) {
      throw new Error('a line says some of the conversation is elsewhere')
    }
    found(
      'back',
      where,
      'pass',
      `all ${all.length} lines read back from ${opened.ids.length} on the snapshot, the view held still`,
    )
  } catch (problem) {
    found('back', where, 'fail', said(problem))
  }
}

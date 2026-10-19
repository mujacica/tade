import { READY, said } from '../test/browser-plan.ts'
import { until } from './browser-until.ts'

// `doing`: what Tade is doing while it answers, in a real browser, on the
// device `browser.ts` already granted everything.
//
// The status line in the box's place says the call in flight with the whole of
// what it was handed — a brief of two hundred characters is every one of them,
// wrapping onto as many lines as it takes and never cut at the field's edge —
// and a command of many lines is the verb on that line and the command whole
// in a box under the spinner, which scrolls in place, where the keyboard can
// reach it, and never sideways.

type Verdict = 'pass' | 'fail' | 'unrun'
type Found = (check: string, where: string, verdict: Verdict, what: string) => void

/** What of Playwright's page this file uses, and nothing else. */
interface Page {
  goto: (url: string, opts?: object) => Promise<unknown>
  waitForSelector: (selector: string, opts?: object) => Promise<unknown>
  evaluate: (body: string) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
}

/** A call still running, as the window hands it over: a tool and what it was handed. */
export interface Running {
  tool: string
  input: Record<string, string>
}

/** A script of sixty lines, which is the box's to show. */
export const SCRIPT_LINES = Array.from(
  { length: 60 },
  (_, n) => `echo "doing line ${n} of the script"`,
)

/**
 * A command on one line, long enough to wrap at every width and short enough
 * to stay the status line's to show — under the length a call's row folds at
 * (`BRIEF_FOLDS`), past which it is the box's.
 */
export const ONE_LINE = `run ${Array.from({ length: 12 }, (_, n) => `--flag-${n}=value`).join(' ')}`

const DRAWN = `(() => {
  const live = document.querySelector('main .ask-live')
  if (!live || live.hidden) return null
  const doing = live.querySelector('.ask-doing')
  const block = live.querySelector('.ask-block')
  const style = getComputedStyle(doing)
  return {
    doing: doing.textContent,
    doingCut: doing.scrollWidth > doing.clientWidth + 1 || doing.scrollHeight > doing.clientHeight + 1 ||
      style.textOverflow === 'ellipsis' || style.whiteSpace === 'nowrap',
    doingLines: Math.round(doing.getBoundingClientRect().height / parseFloat(style.lineHeight)),
    block: block.hidden ? null : block.textContent,
    scrolls: block.scrollHeight > block.clientHeight + 1 && block.clientHeight > 0,
    reachable: block.tabIndex === 0,
    sideways: block.scrollWidth > block.clientWidth + 1 ||
      document.documentElement.scrollWidth > innerWidth + 1,
    spoken: block.closest('[role="status"]') !== null,
  }
})()`

interface Drawn {
  doing: string
  doingCut: boolean
  doingLines: number
  block: string | null
  scrolls: boolean
  reachable: boolean
  sideways: boolean
  spoken: boolean
}

/**
 * `doing`, on the conversation's own screen: `busy` makes the machine say Tade
 * is answering with this call still running, and `idle` says it stopped.
 */
export async function doingAt(
  page: Page,
  origin: string,
  where: string,
  busy: (call: Running) => Promise<void>,
  idle: () => Promise<void>,
  found: Found,
): Promise<void> {
  let step = ''
  let idled = false
  try {
    await page.goto(`${origin}/talk`, { waitUntil: READY })
    await page.waitForSelector('main .ask-field', { timeout: 10_000 })
    const problems: string[] = []

    step = 'a running command of many lines was never drawn'
    const script = SCRIPT_LINES.join('\n')
    await busy({ tool: 'Bash', input: { command: script, description: 'Run the script' } })
    await until(page, `(${DRAWN})?.block?.includes('doing line 59') === true`)
    const many = (await page.evaluate(DRAWN)) as Drawn
    const whole = `command:\n${script}\ndescription: Run the script`
    if (many.doing !== 'Running…') problems.push(`its status line says "${many.doing}"`)
    if (many.block !== whole) {
      problems.push(`its box holds ${many.block?.length ?? 0} of ${whole.length} characters`)
    }
    if (!many.scrolls) problems.push('its box does not scroll in place')
    if (!many.reachable) problems.push('the keyboard cannot reach its box')
    if (many.sideways) problems.push('its box runs off sideways')
    if (many.spoken) problems.push('its box is inside the status, read aloud whole')

    step = 'a running command on one long line was never drawn'
    await busy({ tool: 'Bash', input: { command: ONE_LINE } })
    await until(page, `(${DRAWN})?.doing?.includes('--flag-11') === true`)
    const one = (await page.evaluate(DRAWN)) as Drawn
    if (one.doing !== `Running ${ONE_LINE}…`) {
      problems.push(`one long line is drawn as "${one.doing.slice(0, 60)}"`)
    }
    if (one.doingCut) problems.push('one long line is cut at the field')
    if (one.doingLines < 2) problems.push('one long line does not wrap')
    if (one.block !== null) problems.push('one line under the box length opened a box')
    if (one.sideways) problems.push('one long line runs off sideways')

    step = 'the turn never ended'
    await idle()
    idled = true
    await until(page, `(${DRAWN}) === null`)
    found(
      'doing',
      where,
      problems.length === 0 ? 'pass' : 'fail',
      problems.length === 0
        ? `a ${SCRIPT_LINES.length}-line command whole in a box that scrolls; ${ONE_LINE.length} characters on ${one.doingLines} lines of the status`
        : problems.join('; '),
    )
  } catch (problem) {
    found('doing', where, 'fail', step === '' ? said(problem) : `${step}: ${said(problem)}`)
  } finally {
    // The turn ends however this went, so the passes after it read the
    // conversation they were promised.
    if (!idled) {
      await idle().catch((problem) => {
        found('doing', where, 'fail', `the turn could not be ended after: ${said(problem)}`)
      })
    }
  }
}

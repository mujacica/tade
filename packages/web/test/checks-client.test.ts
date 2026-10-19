import { describe, expect, it } from 'vitest'
import {
  answerSaid,
  byOf,
  checksOf,
  figuresOf,
  forSaid,
  headsOf,
  headsSaid,
  isQuiet,
  noneSaid,
  projectOf,
  quietSaid,
  redLine,
  sinceLine,
  standingSaid,
  stripSaid,
  typicalMs,
  whenSaid,
} from '../src/assets/pages/checks-shape.js'
import { snapshotOf } from '../src/snapshot.ts'
import { checkRun, checkTree, EVERY, input, NOW, project, reach, task } from './fixtures.ts'

// What the checks page draws, against **real projected rows** rather than
// shapes a test assembled: every answer, order, count and word goes through
// `snapshotOf`, so a field the projection renames is a red test here rather
// than a blank card on a phone. And the page's one rule of honesty, held in
// each of its forms: a check nobody ran, or that only ever skipped, is never
// drawn as passing, and a project nothing read is never drawn as nought.

/** The rows a device granted everything is handed, over the fixtures or what a test says. */
function rows(over: Parameters<typeof input>[0] = {}) {
  const made = snapshotOf(input({ reach: reach(EVERY), ...over }), NOW)
  const tasksOf = (name: string) => made.tasks.filter((one) => one.project === name)
  return { projects: made.projects, tasksOf }
}

/** The page over the fixtures, counted against the fixtures' own moment. */
const page = (over: Parameters<typeof input>[0] = {}) => {
  const { projects, tasksOf } = rows(over)
  return checksOf(projects, tasksOf, NOW)
}

const at = (minute: number) => new Date(Date.parse('2026-10-08T09:00:00.000Z') + minute * 60_000)

describe('a project, as its run records add up', () => {
  const sentry = () => page().projects.find((one) => one.name === 'sentry')

  it('is its checkout and then each worktree, every check in the order it first ran', () => {
    const groups = sentry()?.groups ?? []
    expect(groups.map((one) => [one.task, one.name])).toEqual([
      [null, 'checkout'],
      ['sentry/away-projection', 'away-projection'],
    ])
    expect(groups[0]?.tracks.map((one) => [one.check, one.answer])).toEqual([
      ['format', 'pass'],
      ['tests', 'fail'],
      ['types', 'none'],
    ])
    expect(groups[1]?.href).toBe('/t/sentry/away-projection')
  })

  it('counts its required checks by their last answer, and is failing while one is', () => {
    expect(sentry()?.counts).toEqual({ fail: 1, pass: 2, none: 1 })
    expect(sentry()?.standing).toBe('fail')
    expect(standingSaid(sentry() as never)).toEqual({ word: '1 failing', tone: 't-failed' })
  })

  it('is not read, never nought, when nothing has read its records', () => {
    const tade = page().projects.find((one) => one.name === 'tade')
    expect(tade?.standing).toBe('unread')
    expect(tade?.groups).toEqual([])
    expect(standingSaid(tade as never)).toEqual({ word: 'not read yet', tone: null })
  })

  it('says nothing ran, rather than passing, where its record holds no runs', () => {
    const empty = page({ checks: [checkTree({ runs: [] })] }).projects.find(
      (one) => one.name === 'sentry',
    )
    expect(empty?.standing).toBe('empty')
    expect(standingSaid(empty as never).tone).toBeNull()
  })

  it('is passing only when every required check last passed, and no answer is not a pass', () => {
    const green = page({
      checks: [checkTree({ runs: [checkRun(), checkRun({ check: 'format' })] })],
    }).projects.find((one) => one.name === 'sentry')
    expect(green?.standing).toBe('pass')
    const skipped = page({
      checks: [checkTree({ runs: [checkRun(), checkRun({ check: 'format', state: 'skipped' })] })],
    }).projects.find((one) => one.name === 'sentry')
    expect(skipped?.standing).toBe('none')
    expect(standingSaid(skipped as never).word).toBe('no answer yet')
  })

  it('leads with what is failing, then what has no answer, then what passes, then the unread', () => {
    const order = page({
      projects: [
        project({ name: 'a-green' }),
        project({ name: 'b-red' }),
        project({ name: 'c-unread' }),
        project({ name: 'd-skipped' }),
      ],
      checks: [
        checkTree({ project: 'a-green', runs: [checkRun()] }),
        checkTree({ project: 'b-red', runs: [checkRun({ state: 'failed' })] }),
        checkTree({ project: 'd-skipped', runs: [checkRun({ state: 'skipped' })] }),
      ],
    }).projects.map((one) => one.name)
    expect(order).toEqual(['b-red', 'd-skipped', 'a-green', 'c-unread'])
  })
})

describe('what is failing now', () => {
  it('is every required check whose last answer failed, longest-red first', () => {
    const made = page({
      checks: [
        checkTree(),
        checkTree({
          task: 'sentry/away-projection',
          runs: [checkRun({ minute: 10, state: 'failed', check: 'lint' })],
        }),
      ],
    })
    expect(made.red.map((one) => [one.tree, one.check, one.since])).toEqual([
      ['away-projection', 'lint', at(10).toISOString()],
      ['checkout', 'tests', at(60).toISOString()],
    ])
  })

  it('leaves out a failing optional check, which nobody is held on', () => {
    const made = page({
      checks: [checkTree({ runs: [checkRun({ state: 'failed', required: false })] })],
    })
    expect(made.red).toEqual([])
    expect(made.totals).toEqual({ fail: 0, pass: 0, none: 0 })
  })

  it('says how long, how many in a row, how long one takes and who asked', () => {
    const [tests] = page().red
    expect(tests?.forSaid).toBe('4h 30m')
    expect(tests?.sinceSaid).toBe(whenSaid(at(60).toISOString(), NOW))
    expect(redLine(tests as never)).toBe('3 failing runs in a row · about 1m each')
    expect(tests?.by).toEqual({ name: 'away-projection', href: '/t/sentry/away-projection' })
    expect(tests?.cells.map((one) => one.tone)).toEqual([
      'done',
      'done',
      'failed',
      'quiet',
      'failed',
      'failed',
    ])
  })
})

describe('the lead’s figures', () => {
  it('count the required checks by their last answer, with how long the longest has been red', () => {
    const figures = figuresOf(page())
    expect(figures.map((one) => [one.label, one.value, one.tone])).toEqual([
      ['Failing', '1', 'failed'],
      ['Passing', '2', null],
      ['No answer', '1', null],
    ])
    expect(figures[0]?.under).toBe('longest 4h 30m')
  })

  it('are a dash, never a nought, while nothing has been read', () => {
    const figures = figuresOf(page({ checks: null }))
    expect(figures.map((one) => one.value)).toEqual([null, null, null])
    expect(figures.map((one) => one.under)).toEqual([null, null, null])
  })

  it('say nothing is red once something was read and nothing is', () => {
    const figures = figuresOf(page({ checks: [checkTree({ runs: [checkRun()] })] }))
    expect(figures[0]).toMatchObject({ value: '0', tone: null, under: 'nothing red' })
  })
})

describe('a check with no answer', () => {
  it('says why: no run with a time, or skipped every time — and is never a pass', () => {
    const sentry = page().projects.find((one) => one.name === 'sentry')
    const types = sentry?.groups[0]?.tracks.find((one) => one.check === 'types')
    expect(types?.answer).toBe('none')
    expect(answerSaid(types as never)).toBe('no answer')
    expect(noneSaid(types as never)).toBe('no run with a time')
    expect(sinceLine(types as never)).toBe('no run with a time')
    const skipped = page({
      checks: [
        checkTree({ runs: [checkRun({ state: 'skipped' }), checkRun({ state: 'cancelled' })] }),
      ],
    }).projects.find((one) => one.name === 'sentry')?.groups[0]?.tracks[0]
    expect(sinceLine(skipped as never)).toBe('skipped every time')
    expect(skipped?.cells.map((one) => one.tone)).toEqual(['quiet', 'quiet'])
  })

  it('folds away when it is optional, and stays in sight when it is required', () => {
    const made = page({
      checks: [
        checkTree({
          runs: [
            checkRun({ check: 'deploy', state: 'skipped', required: false }),
            checkRun({ check: 'lint', state: 'failed', required: false }),
            checkRun({ check: 'types', state: 'skipped' }),
          ],
        }),
      ],
    })
    const group = made.projects.find((one) => one.name === 'sentry')?.groups[0]
    expect(group?.tracks.map((one) => [one.check, isQuiet(one)])).toEqual([
      ['deploy', true],
      ['lint', false],
      ['types', false],
    ])
    expect(group?.quiet).toBe(1)
    expect(quietSaid(1, false)).toBe('Show 1 optional check with no answer')
    expect(quietSaid(6, true)).toBe('Hide 6 optional checks with no answer')
  })
})

describe('each agent’s head, as the rollup says it', () => {
  it('names the red ones with what failed and counts the rest, apart from the history', () => {
    const { tasksOf } = rows({
      tasks: [
        task({
          id: 'sentry/a',
          checks: { state: 'fail', failed: ['tests'], missing: [], overridden: true },
        }),
        task({
          id: 'sentry/b',
          checks: { state: 'pass', failed: [], missing: [], overridden: false },
        }),
        task({ id: 'sentry/c' }),
      ],
    })
    const heads = headsOf(tasksOf('sentry'))
    expect(heads.red).toEqual([
      { id: 'sentry/a', name: 'a', href: '/t/sentry/a', failed: ['tests'] },
    ])
    expect(headsSaid(heads)).toBe(
      '1 green at the commit in hand · 1 not checked at their commit · 1 overruled',
    )
  })

  it('is counted from the projected tasks of the project it is under', () => {
    const { projects, tasksOf } = rows()
    const sentry = projectOf(
      projects.find((one) => one.name === 'sentry'),
      tasksOf('sentry'),
      NOW,
    )
    expect(sentry.heads.total).toBe(3)
    expect(sentry.heads.unknown).toBe(3)
  })
})

describe('the words for a moment', () => {
  const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute)

  it('is the time today, the weekday this week, the date before that', () => {
    const now = local(13, 18).getTime()
    expect(whenSaid(local(13, 9, 5).toISOString(), now)).toBe('09:05')
    expect(whenSaid(local(11, 14, 30).toISOString(), now)).toMatch(/^\S+ 14:30$/)
    expect(whenSaid(local(1, 8).toISOString(), now)).not.toContain(':')
    expect(whenSaid('not a moment', now)).toBe('—')
  })

  it('says how long with `≥` where the row reaches the oldest run, and freezes while not live', () => {
    const streak = { state: 'fail', since: new Date(NOW - 90 * 60_000).toISOString(), runs: 2 }
    expect(forSaid({ ...streak, atLeast: false }, NOW)).toBe('1h 30m')
    expect(forSaid({ ...streak, atLeast: true }, NOW)).toBe('≥ 1h 30m')
    expect(forSaid({ ...streak, atLeast: false }, NOW, true)).toMatch(/^1h 30m at \d\d:\d\d$/)
    expect(forSaid(null, NOW)).toBeNull()
  })

  it('takes the middle length of the runs that said one, and says a fast one is under a second', () => {
    expect(typicalMs({ runs: [{ ms: 10 }, { ms: null }, { ms: 30 }, { ms: 20 }] })).toBe(20)
    expect(typicalMs({ runs: [{ ms: 10 }, { ms: 20 }] })).toBe(15)
    expect(typicalMs({ runs: [{ ms: null }] })).toBeNull()
    const fast = page({ checks: [checkTree({ runs: [checkRun({ ms: 400, state: 'failed' })] })] })
      .red[0]
    expect(fast?.typical).toBe('<1s')
    // The record's only run, so the row may have begun before it: `≥`.
    expect(redLine(fast as never)).toBe('≥ 1 failing run in a row · each under a second')
  })

  it('reads a strip aloud as how many passed, failed and said nothing', () => {
    expect(
      stripSaid({
        check: 'tests',
        runs: [{ state: 'pass' }, { state: 'fail' }, { state: 'fail' }, { state: 'other' }],
      }),
    ).toBe('tests, 4 runs: 1 passed, 2 failed, 1 skipped or cancelled')
    expect(stripSaid({ check: 'types', runs: [] })).toBe('types: no run with a time')
  })

  it('names who asked, and links only to a task', () => {
    expect(byOf({ by: 'sentry/fix' })).toEqual({ name: 'fix', href: '/t/sentry/fix' })
    expect(byOf({ by: 'you' })).toEqual({ name: 'you', href: null })
    expect(byOf({ by: null })).toBeNull()
  })
})

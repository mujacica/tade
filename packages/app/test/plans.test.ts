import { BUDGET, type RunIn, type RunStepIn, reachOf, runRow } from '@tade/web'
import { describe, expect, it } from 'vitest'
import * as page from '../../web/src/assets/pages/runs-shape.js'
import { runsIn } from '../src/away-factory.ts'
import {
  GROUPS,
  groupsOf,
  nowOf,
  overallOf,
  PARTS,
  type PlanRow,
  partOf,
  partsOf,
  planSays,
  STANDINGS,
  shortNamesOf,
  stagesOf,
  standingOf,
  stepSays,
  waitsOf,
} from '../src/plans.ts'
import { planEntries } from '../src/search.ts'
import { planRowsOf } from '../src/wire/plans.ts'

// The window's Plans screen and the away view's Plans page are one answer to
// "which plan wants me, and how far along is each": the rules are the page's
// (`runs-shape.js`), copied into `plans.ts` because a browser cannot import a
// `.ts` file. These hold the copy to the page on the same rows, so the two can
// never drift — and the rows to `runRow`'s own rollups.

const step = (over: Partial<RunStepIn> = {}): RunStepIn => ({
  task: 'sentry/ship-a',
  project: 'sentry',
  name: 'ship-a',
  state: 'queued',
  layer: 0,
  waits: [],
  finished: false,
  parked: false,
  runs: 0,
  active: false,
  checks: 'unknown',
  review: null,
  usd: null,
  ...over,
})

const run = (name: string, steps: RunStepIn[], over: Partial<RunIn> = {}): RunIn => ({
  run: name,
  projects: [...new Set(steps.map((one) => one.project))],
  steps,
  from: null,
  stamp: null,
  retries: 0,
  ...over,
})

/** Six steps across three projects, one of each part worth telling apart. */
const CHECKOUT = run(
  'checkout-v2',
  [
    step({
      task: 'api/checkout-v2-schema',
      project: 'api',
      name: 'checkout-v2-schema',
      finished: true,
      checks: 'pass',
      review: 'merged',
      usd: 0.4,
      runs: 2,
    }),
    step({
      task: 'api/checkout-v2-client',
      project: 'api',
      name: 'checkout-v2-client',
      layer: 1,
      state: 'working',
      active: true,
      waits: [{ task: 'api/checkout-v2-schema', why: 'the schema first' }],
      usd: 1.1,
    }),
    step({
      task: 'web/checkout-v2-form',
      project: 'web',
      name: 'checkout-v2-form',
      layer: 1,
      state: 'blocked',
      waits: [{ task: 'api/checkout-v2-schema', why: '' }],
    }),
    step({
      task: 'web/checkout-v2-page',
      project: 'web',
      name: 'checkout-v2-page',
      layer: 2,
      waits: [
        { task: 'web/checkout-v2-form', why: 'the form goes on the page' },
        { task: 'api/checkout-v2-client', why: 'it calls the client' },
      ],
    }),
    step({
      task: 'docs/checkout-v2-notes',
      project: 'docs',
      name: 'checkout-v2-notes',
      layer: 3,
      parked: true,
      state: 'parked',
      waits: [{ task: 'web/checkout-v2-page', why: 'notes last' }],
    }),
    step({
      task: 'docs/checkout-v2-faq',
      project: 'docs',
      name: 'checkout-v2-faq',
      layer: 3,
      state: 'failed',
      waits: [{ task: 'outside/thing', why: 'not in this plan' }],
      checks: 'fail',
    }),
  ],
  { stamp: { name: 'checkout', version: 3 }, retries: 1 },
)
const RELEASE = run('release-notes', [
  step({ task: 'docs/release-a', project: 'docs', name: 'release-a', finished: true }),
  step({ task: 'docs/release-b', project: 'docs', name: 'release-b', finished: true }),
])
const SLOW = run('slow-burn', [
  step({ task: 'app/slow-one', project: 'app', name: 'slow-one' }),
  step({
    task: 'app/slow-two',
    project: 'app',
    name: 'slow-two',
    layer: 1,
    waits: [{ task: 'app/slow-one', why: '' }],
  }),
])
const REVIEWING = run('in-review', [
  step({ task: 'app/rev-a', project: 'app', name: 'rev-a', state: 'review' }),
  step({ task: 'app/rev-b', project: 'app', name: 'rev-b', finished: true }),
])

const ROWS: PlanRow[] = planRowsOf([CHECKOUT, RELEASE, SLOW, REVIEWING])

describe("the window's plans are the away page's", () => {
  it('names the parts, the standings and the groups the same', () => {
    expect(PARTS.map((one) => [one.key, one.label, one.always])).toEqual(
      page.PARTS.map((one) => [one.key, one.label, one.always]),
    )
    // Out of reach is a device's: a window reads every project, and a plan
    // with no steps left is the one way it has none.
    expect(GROUPS.map((one) => one.key)).toEqual(page.GROUPS.map((one) => one.key))
    expect(GROUPS.slice(0, 3)).toEqual(page.GROUPS.slice(0, 3))
    for (const [key, one] of Object.entries(STANDINGS)) {
      expect(one.group).toBe(page.STANDINGS[key]?.group)
      if (key !== 'unseen') expect(one.word).toBe(page.STANDINGS[key]?.word)
    }
  })

  it('puts every step in the part the page does', () => {
    const states = ['queued', 'working', 'blocked', 'failed', 'review', 'merged', 'parked'] as const
    for (const state of states) {
      for (const finished of [false, true]) {
        for (const active of [false, true]) {
          const one = step({ state, finished, active })
          expect([state, finished, active, partOf(one)]).toEqual([
            state,
            finished,
            active,
            page.partOf(one),
          ])
        }
      }
    }
  })

  it('stands, groups, counts and says what is happening as the page does', () => {
    for (const row of ROWS) {
      expect(standingOf(row)).toBe(page.standingOf(row))
      expect(partsOf(row.steps)).toEqual(
        page.partsOf(row.steps).map(({ key, label, n }) => ({ key, label, n })),
      )
      expect(nowOf(row)).toEqual(page.nowOf(row))
      expect(nowOf(row, 1)).toEqual(page.nowOf(row, 1))
      expect([...shortNamesOf(row.steps)]).toEqual([...page.shortNamesOf(row.steps)])
      for (const one of row.steps) {
        expect(waitsOf(one, row)).toEqual(page.waitsOf(one, row))
        expect(stepSays(one)).toBe(page.stepSays(one))
      }
      const stages = stagesOf(row).map((one) => ({
        ...one,
        steps: one.steps.map((s) => s.task).sort(),
      }))
      expect(stages).toEqual(
        page.stagesOf(row).map(({ part: _part, ...one }) => ({
          ...one,
          steps: one.steps.map((s: RunStepIn) => s.task).sort(),
        })),
      )
    }
    const all = overallOf(ROWS)
    const theirs = page.overallOf(ROWS)
    expect({ ...all, plans: undefined }).toEqual({
      ...theirs,
      runs: undefined,
      plans: undefined,
      parts: theirs.parts.map(({ key, label, n }) => ({ key, label, n })),
    })
    expect(all.plans).toBe(theirs.runs)
  })

  it('lists what wants you first, then what is moving, then what is done — in the page’s order', () => {
    const groups = groupsOf(ROWS)
    // The page's store sorts what is not finished first and then by name,
    // and its groups keep that order (`runsOf`).
    const sorted = [...ROWS].sort(
      (a, b) =>
        Number(a.finished === a.total) - Number(b.finished === b.total) ||
        a.run.localeCompare(b.run),
    )
    const theirs = page.groupsOf(sorted)
    expect(groups.map((one) => [one.key, one.plans.map((plan) => plan.run)])).toEqual(
      theirs.map((one) => [one.key, one.runs.map((plan: PlanRow) => plan.run)]),
    )
    expect(groups.map((one) => one.plans.map((plan) => plan.run))).toEqual([
      ['checkout-v2'],
      ['in-review', 'slow-burn'],
      ['release-notes'],
      [],
    ])
  })

  it('rolls a plan up as `runRow` does for a device that reads everything', () => {
    const every = reachOf({ id: 'dev', projects: null, granted: ['spend', 'intent'] })
    for (const [i, one] of [CHECKOUT, RELEASE, SLOW, REVIEWING].entries()) {
      const theirs = runRow(one, every, BUDGET)
      const mine = ROWS[i]
      expect(mine && [mine.finished, mine.total, mine.checks]).toEqual([
        theirs.finished,
        theirs.total,
        theirs.checks,
      ])
    }
  })

  it('keeps no money that was never recorded, and adds what was', () => {
    expect(ROWS[0]?.usd).toBeCloseTo(1.5)
    // Nothing recorded is not nought: the screen draws `—` for it.
    expect(ROWS[1]?.usd).toBeNull()
  })

  it('says a plan in a line, its workflow and its retries with it', () => {
    expect(planSays(ROWS[0] as PlanRow)).toBe(
      'checkout-v2-client working · 1 delivery retry · checkout@3',
    )
    expect(planSays(ROWS[1] as PlanRow)).toBe('every step finished')
    expect(planSays(ROWS[2] as PlanRow)).toBe('2 waiting')
  })
})

describe('plans as search rows', () => {
  it('lists a row per plan, what wants you first, each opening its own page', () => {
    const rows = planEntries(ROWS, 0)
    expect(rows.map((row) => [row.id, row.kind, row.note])).toEqual([
      ['plan:checkout-v2', 'plan', 'wants you'],
      ['plan:in-review', 'plan', '1/2'],
      ['plan:slow-burn', 'plan', '0/2'],
      ['plan:release-notes', 'plan', '2/2'],
    ])
    expect(rows[0]?.detail).toBe('api · web · docs')
    expect(rows[0]?.tone).toBe('waiting')
    // A step's name finds the plan it is in, as a whole run of letters.
    expect(rows[0]?.about).toContain('checkout-v2-faq')
  })

  it('draws a name with escapes in it as text', () => {
    const [row] = planEntries(planRowsOf([run('evil\u001b[2Jplan', [step()])]), 0)
    expect(row?.label).not.toContain('\u001b')
    // The id is the key the screen finds the plan by, and is left as it is.
    expect(row?.id).toBe('plan:evil\u001b[2Jplan')
  })
})

describe('the rows come out of the away view’s own fold', () => {
  it('reads the same runs `runsIn` hands the away view', () => {
    const runs = runsIn(
      [
        {
          id: 'app/a',
          project: 'app',
          effort: 'e',
          state: 'working',
          after: [],
          parked: false,
          finished: false,
          runs: 1,
          active: true,
          checks: 'pass',
          review: null,
          usd: 0.5,
        },
        {
          id: 'web/b',
          project: 'web',
          effort: 'e',
          state: 'queued',
          after: [{ task: 'app/a', why: 'after a' }],
          parked: false,
          finished: false,
          runs: 0,
          active: false,
          checks: 'unknown',
          review: null,
          usd: null,
        },
      ],
      new Map(),
    )
    const [plan] = planRowsOf(runs)
    expect(plan?.steps.map((one) => [one.task, one.layer])).toEqual([
      ['app/a', 0],
      ['web/b', 1],
    ])
    expect(plan?.checks).toBe('unknown')
    expect(plan?.projects).toEqual(['app', 'web'])
  })
})

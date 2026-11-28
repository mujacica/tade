import { BUDGET, type RunIn, type RunStepIn, runRow } from '@tade/web'
import { describe, expect, it } from 'vitest'
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

// The window's Plans screen: "which plan wants me, and how far along is each".
// Its rules were once held equal to the away view's Plans page; that page went
// with §10 T5 of the Duo plan (a phone reads plans in the full view, which is
// this screen), so they are held here to what they say on the same rows — and
// the rows to `runRow`'s own rollups.

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

describe("the window's plans", () => {
  it('names the parts, the standings and the groups', () => {
    expect(PARTS.map((one) => [one.key, one.label, one.always])).toMatchInlineSnapshot(`
      [
        [
          "finished",
          "finished",
          true,
        ],
        [
          "review",
          "in review",
          false,
        ],
        [
          "working",
          "working",
          true,
        ],
        [
          "wants",
          "wants you",
          true,
        ],
        [
          "failed",
          "failed",
          true,
        ],
        [
          "waiting",
          "waiting",
          true,
        ],
        [
          "parked",
          "parked",
          false,
        ],
      ]
    `)
    expect(GROUPS).toMatchInlineSnapshot(`
      [
        {
          "heading": "NEEDS YOU",
          "key": "needs",
        },
        {
          "heading": "UNDER WAY",
          "key": "going",
        },
        {
          "heading": "FINISHED",
          "key": "finished",
        },
        {
          "heading": "NOTHING LEFT",
          "key": "unseen",
        },
      ]
    `)
    expect(
      Object.entries(STANDINGS).map(([key, one]) => [key, one.group, one.word]),
    ).toMatchInlineSnapshot(`
      [
        [
          "wants",
          "needs",
          "wants you",
        ],
        [
          "failed",
          "needs",
          "a step failed",
        ],
        [
          "working",
          "going",
          "working",
        ],
        [
          "review",
          "going",
          "in review",
        ],
        [
          "waiting",
          "going",
          "waiting",
        ],
        [
          "finished",
          "finished",
          "finished",
        ],
        [
          "unseen",
          "unseen",
          "no steps left",
        ],
      ]
    `)
  })

  it('puts every step in its part', () => {
    const states = ['queued', 'working', 'blocked', 'failed', 'review', 'merged', 'parked'] as const
    const table: string[] = []
    for (const state of states) {
      for (const finished of [false, true]) {
        for (const active of [false, true]) {
          table.push(
            `${state} ${finished} ${active} → ${partOf(step({ state, finished, active }))}`,
          )
        }
      }
    }
    expect(table).toMatchInlineSnapshot(`
      [
        "queued false false → waiting",
        "queued false true → working",
        "queued true false → finished",
        "queued true true → finished",
        "working false false → working",
        "working false true → working",
        "working true false → finished",
        "working true true → finished",
        "blocked false false → wants",
        "blocked false true → working",
        "blocked true false → finished",
        "blocked true true → finished",
        "failed false false → failed",
        "failed false true → working",
        "failed true false → finished",
        "failed true true → finished",
        "review false false → review",
        "review false true → working",
        "review true false → finished",
        "review true true → finished",
        "merged false false → review",
        "merged false true → working",
        "merged true false → finished",
        "merged true true → finished",
        "parked false false → parked",
        "parked false true → working",
        "parked true false → finished",
        "parked true true → finished",
      ]
    `)
  })

  it('stands, groups, counts and says what is happening', () => {
    const said = ROWS.map((row) => ({
      run: row.run,
      standing: standingOf(row),
      parts: partsOf(row.steps),
      now: nowOf(row),
      nowOne: nowOf(row, 1),
      short: [...shortNamesOf(row.steps)],
      steps: row.steps.map((one) => [one.task, stepSays(one), waitsOf(one, row)]),
      stages: stagesOf(row).map((one) => ({ ...one, steps: one.steps.map((s) => s.task).sort() })),
    }))
    expect(said).toMatchInlineSnapshot(`
      [
        {
          "now": {
            "lines": [
              {
                "name": "form",
                "part": "wants",
                "project": "web",
                "said": "wants you",
                "task": "web/checkout-v2-form",
              },
              {
                "name": "faq",
                "part": "failed",
                "project": "docs",
                "said": "failed",
                "task": "docs/checkout-v2-faq",
              },
              {
                "name": "client",
                "part": "working",
                "project": "api",
                "said": "working",
                "task": "api/checkout-v2-client",
              },
            ],
            "more": 2,
          },
          "nowOne": {
            "lines": [
              {
                "name": "form",
                "part": "wants",
                "project": "web",
                "said": "wants you",
                "task": "web/checkout-v2-form",
              },
            ],
            "more": 4,
          },
          "parts": [
            {
              "key": "finished",
              "label": "finished",
              "n": 1,
            },
            {
              "key": "working",
              "label": "working",
              "n": 1,
            },
            {
              "key": "wants",
              "label": "wants you",
              "n": 1,
            },
            {
              "key": "failed",
              "label": "failed",
              "n": 1,
            },
            {
              "key": "waiting",
              "label": "waiting",
              "n": 1,
            },
            {
              "key": "parked",
              "label": "parked",
              "n": 1,
            },
          ],
          "run": "checkout-v2",
          "short": [
            [
              "api/checkout-v2-schema",
              "schema",
            ],
            [
              "api/checkout-v2-client",
              "client",
            ],
            [
              "web/checkout-v2-form",
              "form",
            ],
            [
              "web/checkout-v2-page",
              "page",
            ],
            [
              "docs/checkout-v2-notes",
              "notes",
            ],
            [
              "docs/checkout-v2-faq",
              "faq",
            ],
          ],
          "stages": [
            {
              "done": 1,
              "layer": 0,
              "name": "Stage 1",
              "said": "can go first",
              "steps": [
                "api/checkout-v2-schema",
              ],
            },
            {
              "done": 0,
              "layer": 1,
              "name": "Stage 2",
              "said": "after stage 1",
              "steps": [
                "api/checkout-v2-client",
                "web/checkout-v2-form",
              ],
            },
            {
              "done": 0,
              "layer": 2,
              "name": "Stage 3",
              "said": "after stage 2",
              "steps": [
                "web/checkout-v2-page",
              ],
            },
            {
              "done": 0,
              "layer": 3,
              "name": "Stage 4",
              "said": "after stage 3 and outside/thing",
              "steps": [
                "docs/checkout-v2-faq",
                "docs/checkout-v2-notes",
              ],
            },
          ],
          "standing": "wants",
          "steps": [
            [
              "api/checkout-v2-schema",
              "checks green · review merged · 2 agents have been on it",
              [],
            ],
            [
              "api/checkout-v2-client",
              "checks not run here",
              [
                {
                  "finished": true,
                  "name": "schema",
                  "part": "finished",
                  "seen": true,
                  "task": "api/checkout-v2-schema",
                  "why": "the schema first",
                },
              ],
            ],
            [
              "web/checkout-v2-form",
              "checks not run here",
              [
                {
                  "finished": true,
                  "name": "schema",
                  "part": "finished",
                  "seen": true,
                  "task": "api/checkout-v2-schema",
                  "why": "",
                },
              ],
            ],
            [
              "web/checkout-v2-page",
              "checks not run here",
              [
                {
                  "finished": false,
                  "name": "form",
                  "part": "wants",
                  "seen": true,
                  "task": "web/checkout-v2-form",
                  "why": "the form goes on the page",
                },
                {
                  "finished": false,
                  "name": "client",
                  "part": "working",
                  "seen": true,
                  "task": "api/checkout-v2-client",
                  "why": "it calls the client",
                },
              ],
            ],
            [
              "docs/checkout-v2-notes",
              "checks not run here · set aside",
              [
                {
                  "finished": false,
                  "name": "page",
                  "part": "waiting",
                  "seen": true,
                  "task": "web/checkout-v2-page",
                  "why": "notes last",
                },
              ],
            ],
            [
              "docs/checkout-v2-faq",
              "checks red",
              [
                {
                  "finished": false,
                  "name": "outside/thing",
                  "part": "unseen",
                  "seen": false,
                  "task": "outside/thing",
                  "why": "not in this plan",
                },
              ],
            ],
          ],
        },
        {
          "now": {
            "lines": [],
            "more": 0,
          },
          "nowOne": {
            "lines": [],
            "more": 0,
          },
          "parts": [
            {
              "key": "finished",
              "label": "finished",
              "n": 2,
            },
            {
              "key": "working",
              "label": "working",
              "n": 0,
            },
            {
              "key": "wants",
              "label": "wants you",
              "n": 0,
            },
            {
              "key": "failed",
              "label": "failed",
              "n": 0,
            },
            {
              "key": "waiting",
              "label": "waiting",
              "n": 0,
            },
          ],
          "run": "release-notes",
          "short": [
            [
              "docs/release-a",
              "a",
            ],
            [
              "docs/release-b",
              "b",
            ],
          ],
          "stages": [
            {
              "done": 2,
              "layer": 0,
              "name": "Stage 1",
              "said": "can go first",
              "steps": [
                "docs/release-a",
                "docs/release-b",
              ],
            },
          ],
          "standing": "finished",
          "steps": [
            [
              "docs/release-a",
              "checks not run here",
              [],
            ],
            [
              "docs/release-b",
              "checks not run here",
              [],
            ],
          ],
        },
        {
          "now": {
            "lines": [
              {
                "name": "one",
                "part": "waiting",
                "project": "app",
                "said": "queued",
                "task": "app/slow-one",
              },
              {
                "name": "two",
                "part": "waiting",
                "project": "app",
                "said": "waits on 1",
                "task": "app/slow-two",
              },
            ],
            "more": 0,
          },
          "nowOne": {
            "lines": [
              {
                "name": "one",
                "part": "waiting",
                "project": "app",
                "said": "queued",
                "task": "app/slow-one",
              },
            ],
            "more": 1,
          },
          "parts": [
            {
              "key": "finished",
              "label": "finished",
              "n": 0,
            },
            {
              "key": "working",
              "label": "working",
              "n": 0,
            },
            {
              "key": "wants",
              "label": "wants you",
              "n": 0,
            },
            {
              "key": "failed",
              "label": "failed",
              "n": 0,
            },
            {
              "key": "waiting",
              "label": "waiting",
              "n": 2,
            },
          ],
          "run": "slow-burn",
          "short": [
            [
              "app/slow-one",
              "one",
            ],
            [
              "app/slow-two",
              "two",
            ],
          ],
          "stages": [
            {
              "done": 0,
              "layer": 0,
              "name": "Stage 1",
              "said": "can go first",
              "steps": [
                "app/slow-one",
              ],
            },
            {
              "done": 0,
              "layer": 1,
              "name": "Stage 2",
              "said": "after stage 1",
              "steps": [
                "app/slow-two",
              ],
            },
          ],
          "standing": "waiting",
          "steps": [
            [
              "app/slow-one",
              "checks not run here",
              [],
            ],
            [
              "app/slow-two",
              "checks not run here",
              [
                {
                  "finished": false,
                  "name": "one",
                  "part": "waiting",
                  "seen": true,
                  "task": "app/slow-one",
                  "why": "",
                },
              ],
            ],
          ],
        },
        {
          "now": {
            "lines": [],
            "more": 1,
          },
          "nowOne": {
            "lines": [],
            "more": 1,
          },
          "parts": [
            {
              "key": "finished",
              "label": "finished",
              "n": 1,
            },
            {
              "key": "review",
              "label": "in review",
              "n": 1,
            },
            {
              "key": "working",
              "label": "working",
              "n": 0,
            },
            {
              "key": "wants",
              "label": "wants you",
              "n": 0,
            },
            {
              "key": "failed",
              "label": "failed",
              "n": 0,
            },
            {
              "key": "waiting",
              "label": "waiting",
              "n": 0,
            },
          ],
          "run": "in-review",
          "short": [
            [
              "app/rev-a",
              "a",
            ],
            [
              "app/rev-b",
              "b",
            ],
          ],
          "stages": [
            {
              "done": 1,
              "layer": 0,
              "name": "Stage 1",
              "said": "can go first",
              "steps": [
                "app/rev-a",
                "app/rev-b",
              ],
            },
          ],
          "standing": "review",
          "steps": [
            [
              "app/rev-a",
              "checks not run here",
              [],
            ],
            [
              "app/rev-b",
              "checks not run here",
              [],
            ],
          ],
        },
      ]
    `)
    const all = overallOf(ROWS)
    expect(all.unseen).toBe(0)
    expect(all).toMatchInlineSnapshot(`
      {
        "done": 4,
        "finished": 1,
        "going": 2,
        "needs": 1,
        "parts": [
          {
            "key": "finished",
            "label": "finished",
            "n": 4,
          },
          {
            "key": "review",
            "label": "in review",
            "n": 1,
          },
          {
            "key": "working",
            "label": "working",
            "n": 1,
          },
          {
            "key": "wants",
            "label": "wants you",
            "n": 1,
          },
          {
            "key": "failed",
            "label": "failed",
            "n": 1,
          },
          {
            "key": "waiting",
            "label": "waiting",
            "n": 3,
          },
          {
            "key": "parked",
            "label": "parked",
            "n": 1,
          },
        ],
        "plans": 4,
        "steps": 12,
        "unseen": 0,
      }
    `)
  })

  it('lists what wants you first, then what is moving, then what is done', () => {
    const groups = groupsOf(ROWS)
    expect(groups.map((one) => one.plans.map((plan) => plan.run))).toEqual([
      ['checkout-v2'],
      ['in-review', 'slow-burn'],
      ['release-notes'],
      [],
    ])
  })

  it('rolls a plan up as `runRow` does for a device that reads everything', () => {
    for (const [i, one] of [CHECKOUT, RELEASE, SLOW, REVIEWING].entries()) {
      const theirs = runRow(one, BUDGET)
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

import type { RunIn, RunStepIn } from '@tade/web'
import { focusTask, initialState, showPlans, withProjects, withTasks } from '../../../src/model.ts'
import { searchPanel } from '../../../src/panels/search/state.ts'
import type { PlanRow } from '../../../src/plans.ts'
import { planEntries, searchResults } from '../../../src/search.ts'
import { planRowsOf } from '../../../src/wire/plans.ts'
import { base, frame, NOW, type Scenario, tasks, utcClock } from './fixtures.ts'

// The Plans screen: every plan — what wants you first, then what is moving and
// how far along, then what is done — and one plan's own page, opened from it,
// from its heading down the side or from search.

const step = (over: Partial<RunStepIn> & { task: string }): RunStepIn => ({
  project: over.task.split('/')[0] ?? '',
  name: over.task.split('/')[1] ?? over.task,
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

/** Three plans: one that wants you, one under way, one finished. */
export const plans = (): PlanRow[] =>
  planRowsOf([
    run(
      'checkout-v2',
      [
        step({
          task: 'checkout/v2-schema',
          finished: true,
          checks: 'pass',
          review: 'merged',
          usd: 0.42,
        }),
        step({
          task: 'checkout/v2-api',
          layer: 1,
          state: 'working',
          active: true,
          usd: 1.18,
          waits: [{ task: 'checkout/v2-schema', why: 'the API reads the new columns' }],
        }),
        step({
          task: 'web/v2-form',
          layer: 1,
          state: 'blocked',
          runs: 2,
          waits: [{ task: 'checkout/v2-schema', why: 'the form posts the new fields' }],
        }),
        step({
          task: 'web/v2-page',
          layer: 2,
          waits: [
            { task: 'web/v2-form', why: 'the page puts the form in' },
            { task: 'checkout/v2-api', why: 'it calls the new endpoint' },
          ],
        }),
      ],
      { stamp: { name: 'cross-repo', version: 3 } },
    ),
    run('search-relevance', [
      step({ task: 'search/rank-tests', finished: true, checks: 'pass', usd: 0.2 }),
      step({
        task: 'search/rank-boost',
        layer: 1,
        state: 'working',
        active: true,
        waits: [{ task: 'search/rank-tests', why: 'the tests say what better is' }],
      }),
      step({
        task: 'search/rank-docs',
        layer: 2,
        waits: [{ task: 'search/rank-boost', why: '' }],
      }),
    ]),
    run('release-notes', [
      step({ task: 'infra/notes-draft', finished: true, checks: 'pass', usd: 0.31 }),
      step({
        task: 'infra/notes-publish',
        layer: 1,
        finished: true,
        checks: 'pass',
        waits: [{ task: 'infra/notes-draft', why: 'publish what was drafted' }],
      }),
    ]),
  ])

export const PLAN_SCREENS: Scenario[] = [
  {
    name: 'every-plan',
    about:
      'The Plans screen, where an agent’s screen would be: every step of every plan as a row of marks with the parts counted under it, then the plans by where they stand — what wants you first, then what is under way, each with its whole graph, finished and running steps with the waiting ones, and what is happening in it now — and a quiet row per finished one. A plan’s name opens its own page. The same plans, in the same groups, as the away view’s Plans page.',
    state: { ...showPlans(base()), folded: ['changes', 'files', 'notes', 'where'] },
    frame: frame({ screen: '', height: 60, clock: utcClock, plans: plans() }),
  },
  {
    name: 'one-plan-open',
    about:
      'One plan’s own page: how far along it is, its facts — checks, cost, the workflow it was stamped from, the projects it reaches into — what in it wants you, its graph with every wait’s reason under it, and its stages, each step with its checks, its review, how many agents have been on it, and what it waits on and why. Back to every plan is the button beside its name.',
    state: { ...showPlans(base(), 'checkout-v2'), folded: ['changes', 'files', 'notes', 'where'] },
    frame: frame({ screen: '', height: 90, clock: utcClock, plans: plans() }),
  },
  {
    name: 'no-plans-yet',
    about:
      'The Plans screen with no plan anywhere: it says so, and what starts one, rather than drawing an empty page.',
    state: { ...showPlans(base()), folded: ['changes', 'files', 'notes', 'where'] },
    frame: frame({ screen: '', height: 24, clock: utcClock, plans: [] }),
  },
  {
    name: 'plans-down-the-side',
    about:
      'A project with work in two plans: the agents down the side are grouped under each plan’s name, and the name is a press that opens that plan’s own page on the Plans screen — its steps in other projects too.',
    state: {
      ...focusTask(
        withTasks(withProjects(initialState(), ['checkout', 'search', 'infra']), [
          ...tasks.map((one) => ({ ...one, effort: 'checkout-v2' })),
          {
            task: 'checkout/rank-hooks',
            state: 'working' as const,
            lane: 'checkout/rank-hooks/agent',
            effort: 'search-relevance',
          },
        ]),
        'checkout/stripe-v15',
      ),
      folded: ['changes', 'files', 'notes', 'where'],
    },
    frame: frame({ height: 30, clock: utcClock }),
  },
  {
    name: 'searching-plans',
    about:
      'Search finds a plan by its name, or by a step in it: a PLANS group, what wants you first, each saying how far along it is or that it wants you, and opening that plan’s own page.',
    state: { ...base(), panel: searchPanel('v2') },
    frame: frame({
      panel: {
        entries: searchResults('v2', {
          entries: planEntries(plans(), NOW),
          files: [],
          matches: [],
          home: '/Users/me',
        }),
        searching: false,
      },
    }),
  },
]

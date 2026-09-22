import { type PlanSource, planStandings } from '@tade/core'
import { spendPanel } from '../../../src/panels/spend/state.ts'
import { spendView } from '../../../src/spend.ts'
import { base, frame, made, NOW, ran, type Scenario, usage } from './fixtures.ts'

// What the agents cost: by task and by model, priced and estimated kept apart.

/**
 * A morning's spend, the one the design was drawn with — and one model reached
 * three ways, which is what the last three groupings are for.
 *
 * `claude-opus-5` on a Claude Code subscription, `anthropic/claude-opus-5`
 * through an API key and `openrouter/anthropic/claude-opus-5` through a router
 * are the same weights and three different bills. The name is the only thing
 * that tells them apart, which is why the name column may never be cut without
 * saying so.
 */
const spent = [
  usage(null, 'openrouter/anthropic/claude-opus-5', 412_000, 0.58, {
    harness: 'pi',
    provider: 'openrouter',
    priced: 'exact',
  }),
  usage('checkout/stripe-v15', 'claude-opus-5', 880_000, 1.26, {
    harness: 'claude-code',
    priced: 'estimate',
  }),
  usage('checkout/refunds', 'anthropic/claude-opus-5', 460_000, 0.62, {
    harness: 'pi',
    provider: 'anthropic',
    priced: 'exact',
  }),
  usage('search/pagination', 'anthropic/claude-sonnet-5', 148_000, 0.2, {
    harness: 'pi',
    provider: 'anthropic',
    priced: 'exact',
  }),
]

/**
 * What the harnesses last said about their plans: Claude Code on a
 * subscription with most of a five-hour window gone, a second account of it
 * barely touched, and pi, which prices every turn and never hears about a
 * plan at all.
 */
const plans: PlanSource[] = [
  {
    harness: 'claude-code',
    account: null,
    can: 'while-working',
    why: 'reports it as one of its agents replies, so there is nothing to show until one has',
    said: {
      at: NOW - 6 * 60_000,
      windows: [
        { label: '5h', used: 78, resetsAt: NOW + 4_920_000 },
        { label: '7d', used: 31, resetsAt: NOW + 3 * 86_400_000 },
      ],
    },
  },
  {
    harness: 'claude-code',
    account: 'reviews',
    can: 'while-working',
    why: 'reports it as one of its agents replies, so there is nothing to show until one has',
    said: {
      at: NOW - 41 * 60_000,
      windows: [{ label: '5h', used: 12, resetsAt: NOW + 7_200_000 }],
    },
  },
  {
    harness: 'pi',
    account: null,
    can: 'none',
    why: 'is never told what a plan has left; it prices each turn instead',
    said: null,
  },
]

export const SPEND_SCREENS: Scenario[] = [
  {
    name: 'spend',
    about:
      'The Spend panel: the orchestrator and every agent today, each project against its budget, and how much of each subscription is left.',
    state: { ...base(), panel: spendPanel() },
    frame: frame({
      plan: planStandings(plans, NOW),
      spendView: spendView(spent, {
        window: 'today',
        by: 'agent',
        now: NOW,
        openedAt: NOW - 3_600_000,
        projects: ['checkout', 'search', 'infra'],
        budgets: { checkout: { usd_per_day: 5 } },
        runs: ran,
        made,
        plan: plans,
      }),
    }),
  },
  {
    name: 'spend-by-model',
    about:
      'The Spend panel grouped by model, where the same model reached three ways — a Claude Code ' +
      'subscription, an API key and a router — is one row under the model\u2019s own name, and the ' +
      'groupings beside it are what tell the three bills apart.',
    state: { ...base(), panel: { ...spendPanel(), by: 'model' as const } },
    frame: frame({
      plan: planStandings(plans, NOW),
      spendView: spendView(spent, {
        window: 'today',
        by: 'model',
        now: NOW,
        openedAt: NOW - 3_600_000,
        projects: ['checkout', 'search', 'infra'],
        budgets: { checkout: { usd_per_day: 5 } },
        runs: ran,
        made,
        plan: plans,
      }),
    }),
  },
]

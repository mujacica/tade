import { noRuntime, type PlanSource, planStandings } from '@tade/core'
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
 * are the same weights reached three ways. The name is the only thing that
 * tells them apart, which is why the name column may never be cut without
 * saying so.
 *
 * The subscription's line still carries the dollars an older Tade wrote onto
 * it, because a journal is append-only and every journal has them. They are
 * not money and are in no total: what that agent used up is its plan's
 * windows, in the list below.
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
  // Codex counts tokens and prices none of them, and this one is on an API
  // key, so the work was billed per token and nobody who ran it will say what
  // it cost. Tade prices it off the published rate for the model and marks it
  // `≈` — its own claim, never a bill, and never added to one in silence.
  usage('search/reindex', 'gpt-5.3-codex', 620_000, 0, {
    harness: 'codex',
    account: 'work',
    priced: 'none',
    parts: { input: 60_000, output: 20_000, cacheRead: 540_000 },
  }),
]

/**
 * What every sign-in there is says about its plan: the list the strip's toggle
 * moves along, and what somebody is told when one of them is nearly gone.
 *
 * Two harnesses that can say, and one that cannot. Claude Code's own sign-in
 * has most of a five-hour window gone, Codex's own is barely touched — which is
 * what the strip has a name and a toggle for rather than one bar — and pi prices
 * every turn and never hears about a plan at all.
 */
const plans: PlanSource[] = [
  {
    harness: 'claude-code',
    account: null,
    can: 'while-working',
    pays: 'plan',
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
    harness: 'codex',
    account: null,
    can: 'while-working',
    pays: 'plan',
    why: 'says it as each turn ends, so nothing shows until an agent has worked',
    said: {
      at: NOW - 41 * 60_000,
      windows: [{ label: '5h', used: 12, resetsAt: NOW + 7_200_000 }],
    },
  },
  {
    harness: 'pi',
    account: null,
    can: 'none',
    pays: 'per-token',
    why: 'is never told what a plan has left; it prices each turn instead',
    said: null,
  },
]

/**
 * What the strip says this morning cost, for the two screens that also draw
 * the page. The same morning as `spent` and the same total: a strip and a page
 * on one screen saying two different things about one figure is the bug both
 * of them exist to prevent. Only here, because only here is the page open —
 * every other screen keeps the base fixture's simpler morning.
 */
const strip = {
  tokens: 2_520_000,
  usd: 1.88,
  hasCost: true,
  byTask: {
    'checkout/stripe-v15': { tokens: 880_000, usd: 0 },
    'checkout/refunds': { tokens: 460_000, usd: 0.62 },
    'search/pagination': { tokens: 148_000, usd: 0.2 },
    'search/reindex': { tokens: 620_000, usd: 0.48 },
  },
  runtime: { ...noRuntime(), ms: 7_500_000, runs: 3, running: true, workingMs: 3_100_000 },
}

/**
 * The same morning on a subscription: every token counted, every hour counted,
 * and no money anywhere — which is what a harness whose own sign-in is a plan
 * reports, and the day the strip used to draw as `today` with an empty slot in
 * front of it.
 */
const unpriced = {
  tokens: 2_520_000,
  usd: 0,
  hasCost: false,
  byTask: {
    'checkout/stripe-v15': { tokens: 880_000, usd: 0 },
    'checkout/refunds': { tokens: 460_000, usd: 0 },
    'search/pagination': { tokens: 148_000, usd: 0 },
    'search/reindex': { tokens: 620_000, usd: 0 },
  },
  runtime: strip.runtime,
}

export const SPEND_SCREENS: Scenario[] = [
  {
    name: 'spend',
    about:
      'The Spend panel: the orchestrator and every agent today, each project against its budget, and how much of each subscription is left.',
    state: { ...base(), panel: spendPanel() },
    frame: frame({
      spend: strip,
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
      spend: strip,
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
  {
    name: 'a-day-nobody-priced',
    about:
      'A morning on a subscription: the tokens and the hours are there and the money is not, so the ' +
      'strip draws \u2014 where the figure goes \u2014 never $0.00, which reads as free, and never the ' +
      'word beside it on its own, which reads as a figure that failed to load. What is left of the ' +
      'plan is the figure that means anything here.',
    state: base(),
    frame: frame({ spend: unpriced, plan: planStandings(plans, NOW) }),
  },
]

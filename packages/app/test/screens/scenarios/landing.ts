import { type LandingFacts, landingDesk } from '@tade/core'
import type { DeskRow } from '../../../src/frame.ts'
import { landingPanel } from '../../../src/panels/landing/state.ts'
import { base, frame, NOW, type Scenario } from './fixtures.ts'

// The landing desk: every finished piece of work and every open review, in the
// order it is cheapest to trust.

const MINUTE = 60_000
const none = { open: 0, answered: 0, confirmed: 0, dismissed: 0 }

function work(over: Partial<LandingFacts> & { task: string }): LandingFacts {
  return {
    state: 'review',
    finished: true,
    wantsYou: false,
    review: null,
    checks: 'pass',
    failed: [],
    missing: [],
    findings: none,
    conflicts: [],
    size: { commits: 1, added: 10, removed: 2 },
    waitingSince: NOW - 30 * MINUTE,
    ...over,
  }
}

/** An afternoon's finished work across three projects, folded by core's own rule. */
const afternoon: LandingFacts[] = [
  work({
    task: 'search/pagination',
    review: 'open',
    size: { commits: 2, added: 42, removed: 9 },
    findings: { ...none, dismissed: 1 },
    waitingSince: NOW - 130 * MINUTE,
  }),
  work({
    task: 'checkout/refund-emails',
    size: { commits: 3, added: 120, removed: 14 },
    waitingSince: NOW - 40 * MINUTE,
  }),
  work({
    task: 'checkout/webhook-retries',
    findings: { ...none, answered: 2 },
    size: { commits: 4, added: 88, removed: 31 },
    waitingSince: NOW - 95 * MINUTE,
  }),
  work({
    task: 'infra/terraform-bump',
    checks: 'unknown',
    missing: ['plan'],
    size: { commits: 1, added: 3, removed: 3 },
    waitingSince: NOW - 20 * MINUTE,
  }),
  work({
    task: 'checkout/stripe-v15',
    state: 'blocked',
    finished: false,
    review: 'draft',
    checks: 'fail',
    failed: ['types'],
    conflicts: [{ with: 'checkout/refund-emails', files: 1 }],
    size: { commits: 5, added: 212, removed: 64 },
    waitingSince: NOW - 12 * MINUTE,
  }),
  work({
    task: 'search/reindex',
    findings: { ...none, open: 1 },
    conflicts: [{ with: 'search/pagination', files: 2 }],
    size: null,
    waitingSince: NOW - 300 * MINUTE,
  }),
]

const usd: Record<string, number | null> = {
  'search/pagination': 0.84,
  'checkout/refund-emails': 1.92,
  'checkout/webhook-retries': 2.4,
  'infra/terraform-bump': null,
  'checkout/stripe-v15': 3.15,
  'search/reindex': 0.61,
}

export const desk: DeskRow[] = landingDesk(afternoon).map(({ facts, landing }) => ({
  task: facts.task,
  project: facts.task.split('/')[0] ?? '',
  ...landing,
  checks: facts.checks,
  findings: facts.findings,
  conflicts: facts.conflicts?.length ?? null,
  size: facts.size,
  usd: usd[facts.task] ?? null,
  waitingSince: facts.waitingSince,
  review: facts.review === 'open' || facts.review === 'draft' ? facts.review : null,
}))

export const LANDING_SCREENS: Scenario[] = [
  {
    name: 'the-landing-desk',
    about:
      'The landing desk: every finished piece of work and open review in every project, green and ' +
      'small first, then what waits on you and what waits on its agent, each with the one sentence ' +
      'why — and the checks, findings, collisions, size, cost and wait beside it.',
    state: { ...base(), panel: landingPanel() },
    frame: frame({
      landing: desk,
      panel: { kept: { 'checkout/webhook-retries': 2 } },
    }),
  },
  {
    name: 'the-landing-desk-on-the-side',
    about:
      'What waits to land in this project, on the AGENTS heading: a press away from the desk, and ' +
      'not drawn at all while nothing does.',
    state: base(),
    frame: frame({ landing: desk }),
  },
  {
    name: 'an-empty-landing-desk',
    about:
      'Nothing finished and no review open: the desk says so rather than drawing an empty box.',
    state: { ...base(), panel: landingPanel() },
    frame: frame({ landing: [] }),
  },
]

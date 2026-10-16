import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import {
  describeProposals,
  madeByWords,
  type Proposal,
  proposalsIn,
  RELATED_MOST,
  relatedWork,
  standsSays,
  undecidedProposals,
  type WorkNow,
} from '../src/proposals.ts'
import { decidesOf } from '../src/schedule.ts'

// Work a schedule or a watch would have started, put to the orchestrator
// first. The case it was written for is the one in the journal on 2026-10-15:
// review.branch-checks found red CI on main, put an agent on it, and ten
// minutes later found the next red commit on main and put a second one on it
// in the same checkout while the first was still fixing the first.

const NOW = Date.parse('2026-10-16T09:10:00Z')
const MINUTE = 60_000

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  task: 'tade/check-macos-latest-failing-on-main-the',
  schedule: 'review-branch-checks-tade',
  key: 'github.com/mujacica/tade@d3b8efdaef5a',
  title: 'check (macos-latest) failing on main — The kitty-protocol shell test waits',
  links: ['https://github.com/mujacica/tade/actions/runs/2'],
  ...over,
})

const work = (over: Partial<WorkNow> & Pick<WorkNow, 'task'>): WorkNow => ({
  state: 'working',
  title: over.task,
  by: null,
  since: null,
  finished: false,
  links: [],
  proposed: false,
  ...over,
})

let seq = 0
const event = (
  type: TadeEvent['type'],
  task: string | null,
  detail: Record<string, unknown>,
  ts = new Date(NOW - 30 * MINUTE + seq * MINUTE).toISOString(),
): TadeEvent => ({
  seq: seq++,
  ts,
  type,
  urgency: 'notable',
  task,
  lane: null,
  run: null,
  detail,
})

describe('who decides whether a schedule’s work starts', () => {
  it('is the orchestrator unless the schedule says itself, and nobody where nothing starts', () => {
    expect(decidesOf({ kind: 'agent', prompt: 'x' })).toBe('orchestrator')
    expect(decidesOf({ kind: 'agent', prompt: 'x', decides: 'itself' })).toBe('itself')
    const watch = { kind: 'watch' as const, watch: 'review.branch-checks', input: {}, most: 2 }
    expect(decidesOf({ ...watch, found: 'agent' })).toBe('orchestrator')
    expect(decidesOf({ ...watch, found: 'agent', decides: 'itself' })).toBe('itself')
    // A watch that only tells and an ask start nothing, so nobody decides anything.
    expect(decidesOf({ ...watch, found: 'ask', decides: 'itself' })).toBeNull()
    expect(decidesOf({ kind: 'ask', prompt: 'x' })).toBeNull()
  })

  it('names who made a schedule as the orchestrator is told it', () => {
    expect(madeByWords('you')).toBe('the person')
    expect(madeByWords('orchestrator')).toBe('you')
    expect(madeByWords('extension:review')).toBe('review')
  })
})

describe('what may already be on the same thing', () => {
  it('finds the agent the same watch put on red CI ten minutes ago, with how long it has run', () => {
    const related = relatedWork(proposal(), [
      work({
        task: 'tade/check-ubuntu-latest-failing-on-main-a',
        by: 'schedule:review-branch-checks-tade',
        since: NOW - 42 * MINUTE,
        title: 'check (ubuntu-latest) failing on main — A second press on words',
      }),
      // Nothing to do with it: another project, finished, or unrelated.
      work({ task: 'sentry/check-ubuntu-latest', by: 'schedule:review-branch-checks-tade' }),
      work({
        task: 'tade/check-ubuntu-latest-failing-on-main',
        by: 'schedule:review-branch-checks-tade',
        finished: true,
      }),
      work({ task: 'tade/readme-hero', by: 'orchestrator' }),
      // Itself is never its own relation.
      work({ task: proposal().task, state: 'parked', by: 'schedule:review-branch-checks-tade' }),
    ])
    expect(related).toEqual([
      {
        task: 'tade/check-ubuntu-latest-failing-on-main-a',
        state: 'working',
        title: 'check (ubuntu-latest) failing on main — A second press on words',
        since: NOW - 42 * MINUTE,
        proposed: false,
        because: ['found by the same watch'],
      },
    ])
    expect(standsSays(related[0] as (typeof related)[number], NOW)).toBe('working for 42m')
  })

  it('says every reason, most reasons first: a shared link and a name that starts the same way', () => {
    const related = relatedWork(
      proposal({
        task: 'tade/fix-review-412-conflicts',
        schedule: 'review-conflicts-tade',
        key: 'review:412@abc',
        links: ['https://github.com/mujacica/tade/pull/412'],
      }),
      [
        work({
          task: 'tade/fix-what-the-review-of-412-found',
          by: 'schedule:review-fix-tade',
          links: ['https://github.com/mujacica/tade/pull/412'],
          state: 'blocked',
        }),
        work({ task: 'tade/fix-review-412-conflicts-2', state: 'queued', by: 'you' }),
        work({
          task: 'tade/fix-review-412-conflicts-3',
          by: 'schedule:review-conflicts-tade',
          links: ['https://github.com/mujacica/tade/pull/412'],
        }),
      ],
    )
    expect(related.map((one) => [one.task, one.because])).toEqual([
      [
        'tade/fix-review-412-conflicts-3',
        [
          'found by the same watch',
          'shares a link: https://github.com/mujacica/tade/pull/412',
          'a name that starts the same way (fix-review-412-conflicts)',
        ],
      ],
      [
        'tade/fix-review-412-conflicts-2',
        ['a name that starts the same way (fix-review-412-conflicts)'],
      ],
      [
        'tade/fix-what-the-review-of-412-found',
        ['shares a link: https://github.com/mujacica/tade/pull/412'],
      ],
    ])
  })

  it('does not call two names alike for one short word in common', () => {
    expect(
      relatedWork(proposal({ task: 'tade/fix-the-title' }), [
        work({ task: 'tade/fix-the-colours' }),
        work({ task: 'tade/check-ubuntu' }),
      ]),
    ).toEqual([])
  })

  it('calls a run of a schedule made by the same schedule, whatever day it is named for', () => {
    const related = relatedWork(
      proposal({
        task: 'tade/nightly-audit-1016',
        schedule: 'nightly-audit',
        key: null,
        links: [],
      }),
      [
        work({
          task: 'tade/nightly-audit-1015',
          by: 'schedule:nightly-audit',
          since: NOW - 26 * 60 * MINUTE,
        }),
      ],
    )
    expect(related[0]?.because).toEqual([
      'made by the same schedule',
      'a name that starts the same way (nightly-audit)',
    ])
    expect(standsSays(related[0] as (typeof related)[number], NOW)).toBe('working for 1d 2h')
  })

  it('says where each stands in words, and a proposal still waiting as one', () => {
    const at = { since: null, proposed: false }
    expect(standsSays({ ...at, state: 'queued' }, NOW)).toBe('queued, not started')
    expect(standsSays({ ...at, state: 'review' }, NOW)).toBe(
      'stopped without saying it has finished',
    )
    expect(standsSays({ ...at, state: 'parked' }, NOW)).toBe('parked')
    expect(standsSays({ ...at, state: 'parked', proposed: true }, NOW)).toBe(
      'parked, waiting for your decision too',
    )
    expect(standsSays({ state: 'blocked', since: NOW - 5 * MINUTE, proposed: false }, NOW)).toBe(
      'waiting on somebody, its agent started 5m ago',
    )
  })
})

describe('what the orchestrator is told', () => {
  it('says what was found, its key, what is already on it, and the one call that decides it', () => {
    const one = proposal()
    const said = describeProposals({
      from: {
        name: 'Failing CI on the branch you are on',
        project: 'tade',
        who: 'review',
        watch: 'review.branch-checks',
      },
      told: [
        {
          proposal: one,
          related: relatedWork(one, [
            work({
              task: 'tade/check-ubuntu-latest-failing-on-main-a',
              by: 'schedule:review-branch-checks-tade',
              since: NOW - 42 * MINUTE,
              title: 'check (ubuntu-latest) failing on main',
            }),
          ]),
        },
      ],
      left: 1,
      now: NOW,
    })
    expect(said).toContain(
      '"Failing CI on the branch you are on", a watch review turned on in tade (review.branch-checks), found something new to start work on. Tade made it as parked work and started nothing',
    )
    expect(said).toContain(
      `- ${one.task}: ${one.title} (key github.com/mujacica/tade@d3b8efdaef5a; https://github.com/mujacica/tade/actions/runs/2)`,
    )
    expect(said).toContain(
      '  - tade/check-ubuntu-latest-failing-on-main-a, working for 42m: check (ubuntu-latest) failing on main (found by the same watch)',
    )
    expect(said).toContain('1 more waits for its next look.')
    expect(said).toContain('tade_proposal_decide')
    for (const decision of ['start', 'after', 'steer', 'leave'])
      expect(said).toContain(`${decision} (`)
  })

  it('says when nothing is on it, and counts what it does not list', () => {
    const many = Array.from({ length: RELATED_MOST + 2 }, (_, n) =>
      work({ task: `tade/run-${n}`, by: 'schedule:nightly' }),
    )
    const lone = proposal({ task: 'tade/a-new-thing', schedule: 'other' })
    const crowded = proposal({
      task: 'tade/nightly-1016',
      schedule: 'nightly',
      key: null,
      links: [],
    })
    const said = describeProposals({
      from: {
        name: 'Nightly',
        project: 'tade',
        who: 'the person',
        watch: null,
        when: 'every day at 03:00',
      },
      told: [
        { proposal: lone, related: relatedWork(lone, many) },
        { proposal: crowded, related: relatedWork(crowded, many) },
      ],
      left: 0,
      now: NOW,
    })
    expect(said).toContain(
      'It is time for "Nightly", a schedule the person made in tade to run every day at 03:00.',
    )
    expect(said).toContain('Nothing Tade can see is working on anything like it.')
    expect(said).toContain('  - and 2 more; tade_status lists every task')
    expect(said).not.toContain('waits for its next look')
  })
})

describe('what is still waiting for a decision', () => {
  it('folds the journal: made, then decided, picked up, started or removed — or still waiting', () => {
    seq = 0
    const found = (task: string, key: string) =>
      event('watch_found', task, {
        schedule: 'review-branch-checks-tade',
        key,
        title: `red at ${key}`,
        proposed: true,
        links: ['https://ci/1'],
      })
    const journal = [
      found('tade/a', 'k-a'),
      found('tade/b', 'k-b'),
      found('tade/c', 'k-c'),
      found('tade/d', 'k-d'),
      found('tade/e', 'k-e'),
      event('schedule_fired', 'tade/nightly-1016', {
        schedule: 'nightly',
        ran: true,
        proposed: true,
        title: 'Nightly',
      }),
      // A finding started by the watch's own rule is not a proposal.
      event('watch_found', 'tade/f', { schedule: 'deps', key: 'k-f', title: 'bump' }),
      event('proposal_decided', 'tade/a', {
        decision: 'leave',
        because: 'tade/x has it',
        by: 'orchestrator',
      }),
      event('state_change', 'tade/b', { state: 'resumed', by: 'you' }),
      event('run_started', 'tade/c', {}),
      event('task_removed', 'tade/d', {}),
      // A second decision about one already decided changes nothing.
      event('proposal_decided', 'tade/a', {
        decision: 'start',
        because: 'again',
        by: 'orchestrator',
      }),
      // Carrying a decision out lifts the park first; the record is the decision.
      found('tade/g', 'k-g'),
      event('state_change', 'tade/g', { state: 'resumed', by: 'orchestrator' }),
      event('proposal_decided', 'tade/g', {
        decision: 'start',
        because: 'free',
        by: 'orchestrator',
      }),
    ]
    expect(proposalsIn(journal).map((one) => [one.proposal.task, one.settled])).toEqual([
      ['tade/a', 'you decided: leave'],
      ['tade/b', 'the person picked it up'],
      ['tade/c', 'it has started'],
      ['tade/d', 'it was removed'],
      ['tade/e', null],
      ['tade/nightly-1016', null],
      ['tade/g', 'you decided: start'],
    ])
    const waiting = undecidedProposals(journal)
    expect(waiting.map((one) => [one.task, one.key, one.title, one.links])).toEqual([
      ['tade/e', 'k-e', 'red at k-e', ['https://ci/1']],
      ['tade/nightly-1016', null, 'Nightly', []],
    ])
  })
})

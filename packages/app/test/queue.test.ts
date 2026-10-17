import { DOCUMENT_EVENTS, type Queued, type QueueFacts, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { QUEUE_READS } from '../src/histories.ts'
import {
  conflictGoneSays,
  conflictLine,
  conflictSays,
  describeQueue,
  heldMessage,
  planAnswer,
  whyStarting,
} from '../src/queue.ts'

const facts = (events: TadeEvent[] = [], finished: string[] = []): QueueFacts => ({
  tasks: new Map([['shop/fix-charge', { state: 'working', reason: '' }]]),
  finished: new Map(finished.map((task) => [task, { at: '', by: 'agent', summary: '' }])),
  events,
  now: Date.parse('2026-09-15T13:00:00Z'),
})

const refunds: Queued = {
  task: 'shop/add-refunds',
  project: 'shop',
  parked: false,
  start: {
    after: [{ task: 'shop/fix-charge', why: 'both change src/charge.ts' }],
    prompt: 'add partial refunds',
    touches: [],
  },
}

describe('what the queue says', () => {
  it('says why something started', () => {
    expect(whyStarting(refunds, facts())).toBe('shop/fix-charge has finished')
    const anyway = facts([
      {
        seq: 1,
        ts: '',
        type: 'queue_changed',
        urgency: 'notable',
        task: 'shop/add-refunds',
        lane: null,
        run: null,
        detail: { change: 'start', by: 'you' },
      },
    ])
    expect(whyStarting(refunds, anyway)).toBe('it was started anyway')
    const timed: Queued = {
      ...refunds,
      start: { ...refunds.start, after: [], at: '2026-09-15T12:00:00Z' },
    }
    expect(whyStarting(timed, facts())).toBe('its time came')
    const approved: Queued = {
      ...refunds,
      start: { ...refunds.start, after: [{ task: 'shop/plan', why: 'the plan', approved: true }] },
    }
    expect(whyStarting(approved, facts())).toBe(
      'shop/plan has finished and the person approved what shop/plan produced',
    )
  })

  it('reads every line about documents from the whole journal, so an approval is never forgotten', () => {
    // `approvedFrom` is a fold over all of them, not over the triage alone: a
    // busy morning past the 500-line window must not turn an approval back
    // into a wait, or a wait into a start on a document asked about again.
    expect(QUEUE_READS).toEqual(expect.arrayContaining([...DOCUMENT_EVENTS]))
  })

  it('lists queued work with where it stands and why it waits', () => {
    expect(describeQueue([], facts(), () => '')).toBe('Nothing is queued.')
    expect(describeQueue([refunds], facts(), () => '')).toBe(
      '- shop/add-refunds — after shop/fix-charge (shop/fix-charge: both change src/charge.ts)',
    )
  })

  it('leaves the orchestrator to decide, unless the person said to ask them', () => {
    const held = { because: 'shop/fix-charge failed', on: 'shop/fix-charge' }
    const ask = heldMessage('shop/add-refunds', held, { holds: 'ask' })
    expect(ask).toContain('The person decides, as they set it (queue.holds)')
    expect(ask).toContain('and do what they choose')
    // Every choice is a call there is: "change the plan" had no tool behind it.
    expect(ask).toContain(
      'change what it waits on (after, with replace: true to drop shop/fix-charge)',
    )
    expect(ask).toContain('task: shop/add-refunds')
    expect(ask).not.toContain('change the plan')
    const mine = heldMessage('shop/add-refunds', held, { holds: 'orchestrator' })
    expect(mine).toContain('Deciding is yours (queue.holds)')
    expect(mine).toContain('Then tell them what you did and why')
    expect(mine).not.toContain('The person decides')
  })

  it('says a hold the tree caused heals, and how to make it a wait instead', () => {
    // 2026-10-11: told "will not start by itself", the orchestrator decided
    // waiting would not help and removed eleven tasks to plan them again.
    const said = heldMessage(
      'tade/lane-echo',
      {
        because:
          'packages/app/src/app.ts, which this was planned to change, is changed and not committed, while tade/open-paints-first works in the same checkout',
        on: null,
        changed: ['packages/app/src/app.ts'],
        by: [],
      },
      { holds: 'ask', working: ['tade/open-paints-first', 'tade/lane-echo'] },
    )
    expect(said).toContain('It starts by itself once that file is committed')
    expect(said).not.toContain('will not start by itself')
    // The one agent there, by the id the tools take, in the call that waits on it.
    expect(said).toContain('At work in that checkout: tade/open-paints-first.')
    expect(said).toContain(
      'tade_queue_change with change: after, task: tade/lane-echo, after: [{task: tade/open-paints-first, why: <why it has to wait>}]',
    )
    expect(said).toContain('Git cannot say whose an uncommitted change is')
    // Nothing offered that no tool does.
    expect(said).not.toContain('put something else first')
    expect(said).not.toContain('until the other work has landed')
    expect(said).toContain('The person decides')
    expect(
      heldMessage('tade/lane-echo', { because: 'x', changed: ['a.ts'] }, { holds: 'orchestrator' }),
    ).toContain('Deciding is yours')
  })

  it('names every agent in the checkout where git cannot say whose, and only the committer where it can', () => {
    const loose = heldMessage(
      'app/write-up',
      { because: 'README.md is changed and not committed', changed: ['README.md', 'test/a.ts'] },
      { holds: 'ask', working: ['app/a', 'app/b'] },
    )
    expect(loose).toContain('once those files are committed')
    expect(loose).toContain('At work in that checkout: app/a and app/b.')
    expect(loose).toContain('after: [{task: <app/a or app/b>, why:')
    const committed = heldMessage(
      'app/write-up',
      {
        because: 'app/fix-charge, which is working, has already changed charge.ts',
        changed: ['charge.ts'],
        by: ['app/fix-charge'],
      },
      { holds: 'ask', working: ['app/fix-charge', 'app/other'] },
    )
    expect(committed).toContain(
      'It starts by itself once app/fix-charge has finished and nothing it was planned to change is left uncommitted',
    )
    expect(committed).toContain('after: [{task: app/fix-charge, why:')
    expect(committed).not.toContain('Git cannot say')
    // With nobody to name — no look at the tree this time — it still says how.
    const nobody = heldMessage(
      'app/write-up',
      { because: 'x', changed: ['a.ts'] },
      { holds: 'ask' },
    )
    expect(nobody).toContain('naming a task tade_queue or tade_status lists')
  })

  it('answers a plan with what started, what waits, and what to watch', () => {
    expect(
      planAnswer({
        projects: ['shop'],
        made: ['shop/fix-charge', 'shop/add-refunds'],
        started: ['shop/fix-charge'],
        waiting: [{ task: 'shop/add-refunds', state: 'after shop/fix-charge' }],
        warnings: ['a and b both change src/x.ts'],
      }),
    ).toBe(
      [
        'Made 2 tasks in shop.',
        'Started fix-charge.',
        'Queued add-refunds (after shop/fix-charge).',
        'Watch out: a and b both change src/x.ts.',
      ].join('\n'),
    )
  })

  it('keeps every name whole when the change spans repositories, and says what it is called', () => {
    // Two tasks called `oauth-scopes` is the ordinary shape of one change in
    // two repos: stripped of their projects they are one name said twice.
    expect(
      planAnswer({
        projects: ['sentry', 'sentry-cli'],
        effort: 'oauth-scopes',
        made: ['sentry/oauth-scopes', 'sentry-cli/oauth-scopes'],
        started: ['sentry/oauth-scopes'],
        waiting: [{ task: 'sentry-cli/oauth-scopes', state: 'after sentry/oauth-scopes' }],
        warnings: [],
      }),
    ).toBe(
      [
        'Made 2 tasks in sentry and sentry-cli, as oauth-scopes.',
        'Started sentry/oauth-scopes.',
        'Queued sentry-cli/oauth-scopes (after sentry/oauth-scopes).',
      ].join('\n'),
    )
  })
})

describe('what the orchestrator is told about work that would collide', () => {
  const branches = new Map([
    ['shop/refunds', 'tade/refunds'],
    ['shop/search', 'tade/search'],
  ])
  const told = { holds: 'orchestrator' as const, branches, queued: [] }

  it('says what, between whom, over which files, and the one call — the other side by its branch', () => {
    const said = conflictSays(
      { kind: 'branches', tasks: ['shop/refunds', 'shop/search'], files: ['a.ts', 'b.ts'] },
      { ...told, yields: 'shop/search', keeps: 'shop/refunds' },
    )
    expect(said).toContain('shop/refunds and shop/search would conflict in a.ts and b.ts')
    expect(said).toContain(
      'The one call: tade_steer with task: shop/search, message: "shop/refunds (branch tade/refunds) changes a.ts and b.ts too, and merging the two would conflict: merge tade/refunds into your branch now and resolve them',
    )
    expect(said).toContain('Resolving it is yours (queue.holds), without asking them')
    expect(said).toContain('nothing has been held or stopped')
  })

  it('has a branch take in a base that moved, and never by a rebase and a force-push', () => {
    const said = conflictSays(
      { kind: 'base', tasks: ['shop/refunds'], base: 'main', files: ['a.ts'] },
      { ...told, yields: 'shop/refunds', keeps: null },
    )
    expect(said).toContain('shop/refunds would no longer merge into main cleanly')
    expect(said).toContain('tade_steer with task: shop/refunds, message: "main has moved')
    expect(said).toContain('never a rebase and a force-push')
  })

  it('has the one that gives way in a shared checkout go second, and commit its own by path', () => {
    const said = conflictSays(
      { kind: 'hunks', tasks: ['shop/refunds', 'shop/search'], files: ['a.ts'] },
      { ...told, yields: 'shop/search', keeps: 'shop/refunds', queued: ['shop/emails'] },
    )
    expect(said).toContain('both have uncommitted changes in a.ts, in the checkout they share')
    expect(said).toContain(
      'tade_steer with task: shop/search, message: "shop/refunds has uncommitted changes in a.ts too: leave it alone until shop/refunds has committed',
    )
    // Queued work planned over the same files can be made to wait instead.
    expect(said).toContain(
      'tade_queue_change with change: after, task: shop/emails, after: [{task: shop/refunds, why:',
    )
  })

  it('puts it to the person where they set it so', () => {
    const said = conflictSays(
      { kind: 'hunks', tasks: ['shop/refunds', 'shop/search'], files: ['a.ts'] },
      { ...told, holds: 'ask', yields: 'shop/search', keeps: 'shop/refunds' },
    )
    expect(said).toContain('The person decides, as they set it (queue.holds)')
    expect(said).not.toContain('without asking them')
  })

  it('tells this machine’s side of a collision with another machine’s branch, and where to fetch that branch', () => {
    const there = {
      kind: 'elsewhere' as const,
      tasks: ['shop/refunds'],
      elsewhere: { machine: 'vps', task: 'shop/search', branch: 'tade/search' },
      files: ['a.ts'],
    }
    const said = conflictSays(there, {
      ...told,
      yields: 'shop/refunds',
      keeps: null,
      mirror: '/home/me/.tade/projects/shop/mirror.git',
    })
    expect(said).toContain('shop/refunds and shop/search on vps would conflict in a.ts')
    expect(said).toContain("The other side is vps's to steer")
    expect(said).toContain(
      'tade_steer with task: shop/refunds, message: "shop/search on vps (its branch tade/search there) changes a.ts too',
    )
    expect(said).toContain(
      'git fetch /home/me/.tade/projects/shop/mirror.git refs/remotes/vps/tade/search, then git merge FETCH_HEAD',
    )
    expect(said).toContain('nothing has been held or stopped on either machine')
    expect(conflictLine(there)).toBe('⇄ shop/refunds and shop/search on vps would conflict in a.ts')
    expect(conflictGoneSays(there)).toBe(
      'shop/refunds and shop/search on vps no longer collide over a.ts',
    )
  })

  it('says it in a line, and says when it has gone', () => {
    const pair = { kind: 'hunks' as const, tasks: ['shop/a', 'shop/b'], files: ['x.ts'] }
    expect(conflictLine(pair)).toBe('⇄ shop/a and shop/b both have uncommitted changes in x.ts')
    expect(conflictGoneSays(pair)).toBe('shop/a and shop/b no longer collide over x.ts')
    expect(
      conflictGoneSays({ kind: 'base', tasks: ['shop/a'], base: 'main', files: ['x.ts'] }),
    ).toBe('shop/a and main no longer collide over x.ts')
  })
})

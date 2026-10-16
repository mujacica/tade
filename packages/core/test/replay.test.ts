import { describe, expect, it } from 'vitest'
import { outcomesFrom } from '../src/evaluations.ts'
import type { TadeEvent } from '../src/events.ts'
import { judgeReplaySays, judgeReplayScore } from '../src/judge-replay.ts'
import { checkPlan } from '../src/plan.ts'
import {
  agentStopped,
  type CaseStarted,
  candidateProblem,
  caseDetail,
  caseProblem,
  casesFor,
  isTestPath,
  NOTHING_CHANGED,
  outcomeOf,
  overCeiling,
  type ReplayCase,
  type ReplayEntrantFacts,
  replayNamedBy,
  replayPlan,
  replayRecords,
  replaysIn,
  stalledIn,
  stoppedBy,
  ungraded,
} from '../src/replay.ts'
import { replaySays } from '../src/replay-said.ts'

// A replay is landed work asked for again — its own words, at its own base, on
// one candidate — and scored by the instruments the original was read with.
// "Could not replay" is said apart from failing, every time.

const landed = (task: string, over: Partial<ReplayCase> = {}): ReplayCase => ({
  task: `shop/${task}`,
  project: 'shop',
  said: `make the ${task} page load faster`,
  base: 'a'.repeat(40),
  baseThere: true,
  harness: 'claude-code',
  model: 'opus',
  done: Date.parse('2026-10-10T10:00:00Z'),
  context: null,
  usd: 1.2,
  workedMs: 20 * 60_000,
  size: { added: 50, removed: 10 },
  tests: ['test/page.test.ts'],
  head: 'b'.repeat(40),
  ...over,
})

const facts = (task: string, over: Partial<ReplayEntrantFacts> = {}): ReplayEntrantFacts => ({
  task,
  removed: false,
  started: true,
  finished: true,
  state: 'review',
  checks: 'pass',
  failed: [],
  strayed: false,
  size: { commits: 2, added: 40, removed: 3 },
  usd: 0.4,
  workedMs: 12 * 60_000,
  ...over,
})

const event = (type: string, detail: Record<string, unknown>, over: Partial<TadeEvent> = {}) =>
  ({
    seq: 1,
    ts: '2026-10-16T11:00:00.000Z',
    type,
    task: null,
    lane: null,
    urgency: 'notable',
    detail,
    ...over,
  }) as TadeEvent

const started = (cases: CaseStarted[], over: Record<string, unknown> = {}) =>
  event('replay_started', {
    replay: 'sonnet',
    project: 'shop',
    said: 'eval sonnet on my last five',
    by: 'you',
    candidate: { model: 'sonnet' },
    ceiling_usd: 5,
    cases: cases.map(caseDetail),
    ...over,
  })

describe('what a replay takes', () => {
  it('takes the newest landed first, and only the harness held where one is named beside a model', () => {
    const cases = [
      landed('old', { done: 1 }),
      landed('new', { done: 3 }),
      landed('codexed', { done: 2, harness: 'codex' }),
    ]
    expect(casesFor(cases, { model: 'sonnet' }, 2).map((one) => one.task)).toEqual([
      'shop/new',
      'shop/codexed',
    ])
    expect(
      casesFor(cases, { model: 'sonnet', harness: 'claude-code' }, 5).map((one) => one.task),
    ).toEqual(['shop/new', 'shop/old'])
    // Varying the harness alone holds no harness back.
    expect(casesFor(cases, { harness: 'codex' }, 5)).toHaveLength(3)
  })

  it('cannot replay words that were an answer to a conversation, or a base that is gone', () => {
    expect(caseProblem(landed('a'))).toBeNull()
    expect(caseProblem(landed('a', { said: 'yes, do it' }))).toContain(
      'too few to stand on their own',
    )
    expect(caseProblem(landed('a', { said: '  ' }))).toBe('its words were not written down')
    expect(caseProblem(landed('a', { base: null }))).toContain('which commit it began from')
    expect(caseProblem(landed('a', { baseThere: false }))).toContain('not in the repository')
  })

  it('needs something to vary', () => {
    expect(candidateProblem({})).toContain('name what to replay on')
    expect(candidateProblem({ model: 'sonnet' })).toBeNull()
    expect(candidateProblem({ harness: 'codex' })).toBeNull()
  })
})

describe('the plan a replay is', () => {
  const request = (over: Partial<Parameters<typeof replayPlan>[0]> = {}) => ({
    project: 'shop',
    name: 'sonnet',
    said: 'eval sonnet on my last five',
    candidate: { model: 'sonnet' },
    cases: [landed('one'), landed('two', { said: 'ok go' }), landed('three'), landed('four')],
    ceilingUsd: 5,
    ...over,
  })

  it('asks each case its own words at its own base, a few at a time, and sets aside what cannot be asked', () => {
    const made = replayPlan(request())
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect(made.plan.replay).toBe('sonnet')
    const [first, second, third] = made.plan.agents
    expect(made.plan.agents.map((one) => one.name)).toEqual(['sonnet-1', 'sonnet-2', 'sonnet-3'])
    expect(first?.said).toBe('make the one page load faster')
    // Its words and nothing else: nothing is added to them.
    expect(first?.prompt).toBe(first?.said)
    expect(first?.from).toBe('a'.repeat(40))
    expect(first?.done).toBe('committed')
    expect(first?.model).toBe('sonnet')
    // The harness each original ran on, held.
    expect(first?.harness).toBe('claude-code')
    // Two at a time: the third waits on the first.
    expect(first?.after).toEqual([])
    expect(second?.after).toEqual([])
    expect(third?.after.map((one) => one.agent)).toEqual(['sonnet-1'])
    expect(made.cases.map(({ original, ...rest }) => ({ ...rest, said: original?.said }))).toEqual([
      {
        of: 'shop/one',
        task: 'shop/sonnet-1',
        couldNot: null,
        said: 'make the one page load faster',
      },
      { of: 'shop/two', task: null, couldNot: expect.stringContaining('too few'), said: 'ok go' },
      {
        of: 'shop/three',
        task: 'shop/sonnet-2',
        couldNot: null,
        said: 'make the three page load faster',
      },
      {
        of: 'shop/four',
        task: 'shop/sonnet-3',
        couldNot: null,
        said: 'make the four page load faster',
      },
    ])
    const checked = checkPlan(made.plan, { workspace: () => 'checkout', tasks: new Set() })
    // Kept even in a project worked in its checkout: a replay is a worktree each.
    expect(checked.ok).toBe(true)
  })

  it('varies the harness alone on its own route', () => {
    const made = replayPlan(request({ candidate: { harness: 'codex' } }))
    expect(made.ok && made.plan.agents.every((one) => one.harness === 'codex' && !one.model)).toBe(
      true,
    )
  })

  it('is refused whole without a ceiling, with nothing to replay, or with nothing that can be', () => {
    const none = replayPlan(request({ ceilingUsd: 0 }))
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.problems.join(' ')).toContain('needs a ceiling')
    const empty = replayPlan(request({ cases: [] }))
    if (!empty.ok) expect(empty.problems.join(' ')).toContain('nothing has landed in shop')
    const short = replayPlan(request({ cases: [landed('x', { said: 'yes' })] }))
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.problems.join(' ')).toContain('none of the 1 could be replayed')
    const unknown = replayPlan(request({ cases: [landed('x', { harness: '' })] }))
    if (!unknown.ok) expect(unknown.problems.join(' ')).toContain('nothing to hold fixed')
    expect(replayPlan(request({ atOnce: 9 })).ok).toBe(false)
    expect(replayPlan(request({ at: 'tonight' })).ok).toBe(false)
  })

  it('is refused by the plan path when it would begin nowhere, or is a race too', () => {
    const made = replayPlan(request())
    if (!made.ok) throw new Error('made')
    const plan = {
      ...made.plan,
      race: 'x',
      agents: made.plan.agents.map((one) => ({ ...one, from: '' })),
    }
    const checked = checkPlan(plan, { workspace: () => 'worktree', tasks: new Set() })
    expect(checked.ok).toBe(false)
    if (!checked.ok) {
      expect(checked.problems.join(' ')).toContain('a race or a replay, not both')
      expect(checked.problems.join(' ')).toContain('begins where the original did')
    }
  })
})

describe('what came of an entrant', () => {
  it('counts nothing changed as could not replay, never as a fail', () => {
    expect(
      outcomeOf(facts('t', { size: { commits: 0, added: 0, removed: 0 } }), null, false),
    ).toEqual({ outcome: 'could not replay', why: NOTHING_CHANGED })
  })

  it('fails on red checks, on the original’s tests, or on straying — and says each', () => {
    const red = outcomeOf(
      facts('t', { checks: 'fail', failed: ['types'], strayed: true }),
      { task: 't', state: 'failed', failed: ['tests'], laid: ['test/a.test.ts'], why: '' },
      false,
    )
    expect(red.outcome).toBe('failed')
    expect(red.why).toContain('its checks are red (types)')
    expect(red.why).toContain('with the original’s tests laid over it, tests failed')
    expect(red.why).toContain('did something other than what was asked')
  })

  it('passes on green, and is unscored where nothing ran', () => {
    expect(outcomeOf(facts('t'), null, false).outcome).toBe('passed')
    expect(
      outcomeOf(
        facts('t', { checks: 'unknown' }),
        { task: 't', state: 'passed', failed: [], laid: ['test/a.test.ts'], why: '' },
        false,
      ),
    ).toEqual({ outcome: 'passed', why: 'green, the original’s tests included' })
    expect(outcomeOf(facts('t', { checks: null }), null, false).outcome).toBe('unscored')
    expect(outcomeOf(facts('t', { size: null }), null, false).outcome).toBe('unscored')
  })

  it('is running, waiting, stopped or removed before it is anything else', () => {
    expect(outcomeOf(facts('t', { finished: false }), null, false).outcome).toBe('running')
    expect(outcomeOf(facts('t', { finished: false, started: false }), null, false).outcome).toBe(
      'waiting',
    )
    expect(
      outcomeOf(
        facts('t', { finished: true, size: { commits: 0, added: 0, removed: 0 } }),
        null,
        true,
      ).outcome,
    ).toBe('stopped at the ceiling')
    expect(outcomeOf(null, null, false).outcome).toBe('removed')
  })
})

describe('a replay, read', () => {
  const cases: CaseStarted[] = [
    { of: 'shop/one', task: 'shop/sonnet-1', couldNot: null, original: landed('one') },
    {
      of: 'shop/two',
      task: null,
      couldNot: 'its words — “ok go” — are too few',
      original: landed('two', { said: 'ok go' }),
    },
    { of: 'shop/three', task: 'shop/sonnet-2', couldNot: null, original: landed('three') },
    { of: 'shop/four', task: 'shop/sonnet-3', couldNot: null, original: landed('four') },
  ]
  const records = replayRecords([
    started(cases),
    event(
      'replay_graded',
      {
        replay: 'sonnet',
        project: 'shop',
        state: 'failed',
        failed: ['tests'],
        laid: ['t.test.ts'],
      },
      { task: 'shop/sonnet-2' },
    ),
  ])
  const known: Record<string, ReplayEntrantFacts> = {
    'shop/sonnet-1': facts('shop/sonnet-1'),
    'shop/sonnet-2': facts('shop/sonnet-2', { usd: 0.9 }),
    'shop/sonnet-3': facts('shop/sonnet-3', {
      finished: false,
      started: false,
      usd: null,
      size: null,
    }),
  }
  const [replay] = replaysIn(records, (task) => known[task] ?? null)

  it('folds the journal into every case, with the money beside the originals’', () => {
    if (!replay) throw new Error('no replay')
    // The original's figures come back out of the line they were written in.
    expect(replay.entrants[0]?.case).toEqual(landed('one', { context: null }))
    expect(replay.candidate).toEqual({ model: 'sonnet' })
    expect(replay.entrants.map((one) => one.outcome)).toEqual([
      'passed',
      'could not replay',
      'failed',
      'waiting',
    ])
    expect(replay.spent).toEqual({ sum: 1.3, atLeast: true })
    // Only the originals of what ran stand beside it.
    expect(replay.originals.sum).toBeCloseTo(2.4)
    expect(replay.over).toBe(false)
    expect(overCeiling(replay)).toBe(false)
    expect(overCeiling({ ...replay, ceilingUsd: 1 })).toBe(true)
    expect(stoppedBy(replay)).toEqual(['shop/sonnet-3'])
    expect(ungraded(replay).map((one) => one.task)).toEqual(['shop/sonnet-1'])
  })

  it('says could not replay apart from failing, and every figure beside its original', () => {
    if (!replay) throw new Error('no replay')
    const said = replaySays(replay).join('\n')
    expect(said).toContain(
      'on sonnet on each task’s own harness: 1 passed, 1 failed, 1 could not replay, 1 waiting',
    )
    expect(said).toContain(
      '1 of 2 scored replays held up; 1 could not be replayed and are not counted against it',
    )
    expect(said).toContain('≥ $1.30 of its $5.00 ceiling')
    expect(said).toContain(
      'shop/one → shop/sonnet-1: passed (green). $0.40, 12m, +40 −3 (the original +50 −10)',
    )
    expect(said).toContain('the original ran on claude-code · opus, $1.20, 20m')
  })

  it('finishes an entrant whose agent stopped, so the ones behind it start', () => {
    if (!replay) throw new Error('no replay')
    const idle = replaysIn(records, (task) =>
      facts(task, { finished: false, size: { commits: 0, added: 0, removed: 0 } }),
    )[0]
    if (!idle) throw new Error('no replay')
    expect(stalledIn(idle, (task) => task === 'shop/sonnet-1')).toEqual(['shop/sonnet-1'])
    expect(agentStopped('blocked', 'agent idle, waiting for input')).toBe(true)
    expect(agentStopped('blocked', 'wants approval: rm -rf')).toBe(false)
    expect(agentStopped('failed', 'agent exited with code 1')).toBe(true)
    expect(agentStopped('working', 'agent running')).toBe(false)
  })

  it('reads a stop at the ceiling, and says that no money recorded is not a figure', () => {
    const stopped = replaysIn(
      replayRecords([
        started(cases),
        event('replay_stopped', { replay: 'sonnet', project: 'shop', stopped: ['shop/sonnet-3'] }),
      ]),
      (task) =>
        task === 'shop/sonnet-3'
          ? facts(task, { usd: null, size: { commits: 0, added: 0, removed: 0 } })
          : facts(task, { usd: null }),
    )[0]
    if (!stopped) throw new Error('no replay')
    expect(stopped.stopped).toBe(true)
    expect(stopped.entrants[3]?.outcome).toBe('stopped at the ceiling')
    expect(replaySays(stopped).join('\n')).toContain('no money recorded')
    expect(overCeiling(stopped)).toBe(false)
  })
})

describe('the person asking', () => {
  it('is a line of theirs that asks for an eval', () => {
    expect(replayNamedBy(['eval sonnet against my last ten'])).toBe(
      'eval sonnet against my last ten',
    )
    expect(replayNamedBy(['benchmark the new model here'])).not.toBeNull()
    expect(replayNamedBy(['fix the login page'])).toBeNull()
  })
})

describe('a judge asked again', () => {
  it('counts agreement and the verdicts people wrote, and draws no rate under enough', () => {
    const score = judgeReplayScore(
      [
        {
          unit: 'shop/a',
          recorded: { leaks: 0.9, strays: 0.1 },
          replayed: { leaks: 0.7, strays: 0.8 },
          verdicts: { leaks: 'confirmed' },
        },
        {
          unit: 'shop/b',
          recorded: { leaks: 0.8 },
          replayed: { leaks: 0.9 },
          verdicts: { leaks: 'false positive' },
        },
        { unit: 'shop/c', recorded: { leaks: 0.1 }, replayed: null, verdicts: {} },
      ],
      0.6,
    )
    expect(score).toEqual({
      read: 2,
      couldNot: 1,
      agreed: 2,
      asked: 3,
      raised: { recorded: 2, candidate: 3 },
      confirmed: { of: 1, caught: 1 },
      dismissed: { of: 1, raisedAgain: 1 },
    })
    const said = judgeReplaySays(score, 5).join('\n')
    expect(said).toContain('Agreed on 2 of 3 answers;')
    expect(said).not.toContain('%')
    expect(judgeReplaySays(score, 1).join('\n')).toContain('(67%)')
  })
})

describe('what a test is', () => {
  it('reads the common layouts', () => {
    for (const path of [
      'test/a.ts',
      'src/a.test.ts',
      'pkg/__tests__/x.js',
      'a_test.go',
      'test_x.py',
    ])
      expect(isTestPath(path)).toBe(true)
    for (const path of ['src/a.ts', 'testing.md', 'contest/x.ts'])
      expect(isTestPath(path)).toBe(false)
  })
})

describe('the scorecards', () => {
  it('leave a replay’s entrants out: a measurement is not work that was asked for', () => {
    const outcomes = outcomesFrom(
      [
        event('task_created', { workspace: 'worktree' }, { task: 'shop/real' }),
        event(
          'task_created',
          { workspace: 'worktree', replay: 'sonnet' },
          { task: 'shop/sonnet-1' },
        ),
      ],
      { since: 0 },
    )
    expect(outcomes.map((one) => one.task)).toEqual(['shop/real'])
  })
})

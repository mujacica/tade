import type { InboxRow, SourceStanding } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  INTAKE_LOCALLY,
  type IntakeBody,
  intakeIn,
  intakeTitles,
  layersOf,
  type RunTask,
  runsIn,
  sourcesIn,
  WORKFLOW_LOCALLY,
  type WorkflowHeld,
  workflowsIn,
} from '../src/away-factory.ts'

// What the window hands the away view about the factory floor.
//
// Pure, so the questions that matter can be asked exhaustively:
//
// - **Which requests carry their words**, and does every other row say so
//   rather than reading as an empty request?
// - **Is the graph's depth the longest chain**, and does a cycle in a file
//   somebody edited by hand leave the window running?
// - **Is every act that stays at the machine named with its clause**, rather
//   than left as a hole somebody has to guess at?

const row = (over: Partial<InboxRow> = {}): InboxRow => ({
  item: 'github:1402',
  source: 'github',
  externalId: '1402',
  requester: 'octocat',
  project: 'sentry',
  grant: 'surfaces.intake.sources.github',
  template: { name: 'reproduce-and-fix', version: 3 },
  revision: 'r2',
  taken: 'r1',
  hash: 'sha256:abc',
  ref: 'owner/repo#1402',
  url: 'https://github.invalid/owner/repo/issues/1402',
  watch: 'intake.github',
  schedule: 'github-issues',
  mode: 'propose',
  tasks: ['sentry/github-1402'],
  work: [
    {
      task: 'sentry/github-1402',
      parked: true,
      started: false,
      finished: false,
      held: null,
      state: 'parked',
    },
  ],
  state: 'proposed',
  because: 'it is parked, waiting for a person to approve it',
  attempts: 0,
  tries: 3,
  replies: 0,
  said: [],
  unsent: [],
  at: Date.parse('2026-10-09T10:00:00Z'),
  ...over,
})

const facts = (over: Partial<Parameters<typeof intakeIn>[1]> = {}) => ({
  bodies: new Map<string, IntakeBody>(),
  titles: new Map<string, string>(),
  efforts: new Map<string, string>(),
  would: new Map(),
  most: 2,
  ...over,
})

describe('the requests, as the projection takes them', () => {
  it('carries the row’s own state and sentence, field by field', () => {
    const [one] = intakeIn([row()], facts())
    expect(one?.state).toBe('proposed')
    expect(one?.because).toContain('waiting for a person')
    expect(one?.stamp).toEqual({ name: 'reproduce-and-fix', version: 3 })
    expect(one?.locally).toBe(INTAKE_LOCALLY)
  })

  it('names the parked task approving would be about, and nothing else', () => {
    // An existing verb's target: `intake` on that task, which already re-asks
    // the local grant and the source at the moment of the act.
    const [one] = intakeIn([row()], facts())
    expect(one?.approve).toBe('sentry/github-1402')
  })

  it('names none for a request nobody can approve', () => {
    // A refusal is a final answer about this revision, a request nothing has
    // been made for has nothing to approve, and work already picked up is not
    // a proposal. The page says the reason out of `because` rather than
    // drawing a control that can only be refused.
    for (const state of ['refused', 'noticed', 'failure', 'started', 'accepted'] as const) {
      expect(intakeIn([row({ state })], facts())[0]?.approve, state).toBe('')
    }
  })

  it('names none where the work was approved under it, however the state reads', () => {
    const picked = row({
      work: [
        {
          task: 'sentry/github-1402',
          parked: false,
          started: true,
          finished: false,
          held: null,
          state: 'working',
        },
      ],
    })
    expect(intakeIn([picked], facts())[0]?.approve).toBe('')
  })

  it('points at the run its tasks name, where they name one', () => {
    const efforts = new Map([['sentry/github-1402', 'shop-1402']])
    expect(intakeIn([row()], facts({ efforts }))[0]?.run).toBe('shop-1402')
    expect(intakeIn([row()], facts())[0]?.run).toBe('')
  })

  it('carries the title out of what a watch found, by the request itself', () => {
    const titles = new Map([['github:1402', 'Export button 500s']])
    expect(intakeIn([row()], facts({ titles }))[0]?.title).toBe('Export button 500s')
    // And nothing where no watch wrote one down: the id is not a title, and a
    // row saying `1402` twice reads as a title nobody wrote.
    expect(intakeIn([row()], facts())[0]?.title).toBe('')
  })
})

describe('which requests carry their words', () => {
  const many = [
    row({ item: 'github:1', externalId: '1', state: 'started', at: 500 }),
    row({ item: 'github:2', externalId: '2', state: 'proposed', at: 100 }),
    row({ item: 'github:3', externalId: '3', state: 'held', at: 200 }),
    row({ item: 'github:4', externalId: '4', state: 'accepted', at: 400 }),
  ]
  const bodies = new Map(
    many.map((one) => [
      `${one.item}@${one.hash}`,
      { body: `body of ${one.externalId}`, problem: null },
    ]),
  )
  const byItem = new Map(
    many.map((one) => [one.item, { body: `body of ${one.externalId}`, problem: null }]),
  )

  it('carries the ones waiting on somebody first, then the newest', () => {
    // A body is up to `material` long and forty requests would put a third of
    // a megabyte on every frame, for a phone reading one of them. So the ones
    // that cross are the ones somebody is being asked to decide about.
    const out = intakeIn(many, facts({ bodies: byItem, most: 2 }))
    const carried = out.filter((one) => one.material !== '').map((one) => one.item)
    expect(carried.sort()).toEqual(['github:2', 'github:3'])
    expect(bodies.size).toBe(4)
  })

  it('says of every other row that its words are not on this page', () => {
    const out = intakeIn(many, facts({ bodies: byItem, most: 2 }))
    const left = out.filter((one) => one.material === '')
    expect(left).toHaveLength(2)
    for (const one of left) {
      expect(one.materialProblem).toContain('not on this page')
      expect(one.materialProblem).toContain('2 requests carry theirs')
    }
  })

  it('says a body nothing has read yet apart from one that is not carried', () => {
    // Three nothings and the page says which: not granted (the projection's),
    // not on this frame (above), and nothing here has read it.
    const out = intakeIn([row()], facts({ most: 1 }))
    expect(out[0]?.material).toBe('')
    expect(out[0]?.materialProblem).toBe('nothing here has read it yet')
  })

  it('carries the reason a read failed, where one did', () => {
    const bodies = new Map([['github:1402', { body: null, problem: 'the context file is gone' }]])
    const out = intakeIn([row()], facts({ bodies, most: 1 }))
    expect(out[0]?.materialProblem).toBe('the context file is gone')
  })

  it('carries none at all where the budget is nought', () => {
    const out = intakeIn(many, facts({ bodies: byItem, most: 0 }))
    expect(out.every((one) => one.material === '')).toBe(true)
  })
})

describe('the titles a watch found', () => {
  it('loses the revision, so a renamed ticket shows the name it has now', () => {
    const titles = intakeTitles([
      { key: 'github:1402:r1', title: 'Export button breaks' },
      { key: 'github:1402:r2', title: 'Export button 500s for Zt9' },
    ])
    expect(titles.get('github:1402')).toBe('Export button 500s for Zt9')
  })

  it('leaves a key that is not a finding’s alone', () => {
    expect(intakeTitles([{ key: 'nonsense', title: 'x' }]).size).toBe(0)
    expect(intakeTitles([{ key: 'a:b', title: 'x' }]).size).toBe(0)
  })
})

describe('the doors', () => {
  it('carries every field of the standing, field by field', () => {
    const standing: SourceStanding = {
      source: 'github',
      grant: 'surfaces.intake.sources.github',
      state: 'rate-limited',
      because: 'a budget is spent',
      accept: true,
      reply: false,
      names: false,
      mode: 'propose',
      template: '',
      projects: ['sentry'],
      allowed: 1,
      watch: 'intake.github',
      schedule: 'github-issues',
      every: '10m',
      lookedAt: 100,
      workedAt: 50,
      found: 2,
      fresh: 1,
      left: 0,
      trouble: 'rate-limited',
      until: 200,
      handed: 3,
    }
    expect(sourcesIn([standing])[0]).toEqual({ ...standing })
  })
})

describe('the runs, folded out of the task files', () => {
  const task = (over: Partial<RunTask>): RunTask => ({
    id: 'sentry/one',
    project: 'sentry',
    effort: 'shop',
    state: 'queued',
    after: [],
    parked: false,
    finished: false,
    runs: 0,
    active: false,
    checks: 'unknown',
    review: null,
    usd: null,
    ...over,
  })

  it('groups by the effort the task files name, and leaves tasks naming none out', () => {
    const runs = runsIn(
      [
        task({ id: 'sentry/a' }),
        task({ id: 'sentry/b' }),
        task({ id: 'sentry/c', effort: '' }),
        task({ id: 'tade/d', project: 'tade', effort: 'other' }),
      ],
      new Map(),
    )
    expect(runs.map((one) => one.run).sort()).toEqual(['other', 'shop'])
    expect(runs.find((one) => one.run === 'shop')?.steps).toHaveLength(2)
  })

  it('puts a step one past the deepest thing it waits on, inside the run', () => {
    const runs = runsIn(
      [
        task({ id: 'sentry/a' }),
        task({ id: 'sentry/b', after: [{ task: 'sentry/a', why: 'first' }] }),
        task({
          id: 'sentry/c',
          after: [
            { task: 'sentry/a', why: 'first' },
            { task: 'sentry/b', why: 'second' },
          ],
        }),
      ],
      new Map(),
    )
    const steps = runs[0]?.steps ?? []
    expect(steps.map((one) => [one.name, one.layer])).toEqual([
      ['a', 0],
      ['b', 1],
      // **The longest chain and not the shortest**, which is the whole of what
      // the columns say: work that can run side by side lines up.
      ['c', 2],
    ])
  })

  it('keeps a wait on work outside the run as an edge without deepening anything', () => {
    // A dependency on work that is not part of this run: counting it would
    // push a whole run down a column for a reason nothing on the screen
    // explains.
    const runs = runsIn(
      [task({ id: 'sentry/a', after: [{ task: 'sentry/elsewhere', why: 'needs it' }] })],
      new Map(),
    )
    expect(runs[0]?.steps[0]?.layer).toBe(0)
    expect(runs[0]?.steps[0]?.waits).toHaveLength(1)
  })

  it('carries the provenance handed in, and none where a run is the owner’s own', () => {
    const from = new Map([
      [
        'shop',
        {
          item: 'github:1402',
          source: 'github',
          stamp: { name: 'reproduce-and-fix', version: 3 },
          retries: 2,
        },
      ],
    ])
    const [one] = runsIn([task({})], from)
    expect(one?.from).toEqual({ item: 'github:1402', source: 'github' })
    expect(one?.stamp).toEqual({ name: 'reproduce-and-fix', version: 3 })
    expect(one?.retries).toBe(2)
    const [bare] = runsIn([task({})], new Map())
    expect(bare?.from).toBeNull()
    expect(bare?.retries).toBe(0)
  })

  it('lists the repositories a run reaches, in the order its steps were found', () => {
    const runs = runsIn(
      [task({ id: 'sentry/a' }), task({ id: 'tade/b', project: 'tade' })],
      new Map(),
    )
    expect(runs[0]?.projects).toEqual(['sentry', 'tade'])
  })
})

describe('a cycle in a task file somebody edited by hand', () => {
  it('leaves the window running rather than walking for ever', () => {
    // `checkPlan` refuses a plan with one, but these are files anybody can
    // edit and a projection may not assume otherwise. The drawing is odd,
    // which is the right failure.
    const cycle: RunTask[] = [
      {
        id: 'sentry/a',
        project: 'sentry',
        effort: 'shop',
        state: 'queued',
        after: [{ task: 'sentry/b', why: 'b first' }],
        parked: false,
        finished: false,
        runs: 0,
        active: false,
        checks: 'unknown',
        review: null,
        usd: null,
      },
      {
        id: 'sentry/b',
        project: 'sentry',
        effort: 'shop',
        state: 'queued',
        after: [{ task: 'sentry/a', why: 'a first' }],
        parked: false,
        finished: false,
        runs: 0,
        active: false,
        checks: 'unknown',
        review: null,
        usd: null,
      },
    ]
    const depth = layersOf(cycle)
    expect([...depth.values()].every((one) => Number.isFinite(one))).toBe(true)
    expect(runsIn(cycle, new Map())[0]?.steps).toHaveLength(2)
  })
})

describe('the workflows', () => {
  const held = (over: Partial<WorkflowHeld> = {}): WorkflowHeld => ({
    name: 'reproduce-and-fix',
    builtIn: false,
    versions: [3, 2, 1],
    draft: {
      template: 'reproduce-and-fix',
      version: 4,
      title: 'Reproduce, then fix',
      about: 'two steps',
      project_input: 'repo',
      said_input: 'about',
      inputs: {
        repo: { kind: 'project', required: true, about: 'which repository' },
        about: { kind: 'text', required: true, about: 'what this run is' },
      },
      agents: [
        {
          name: 'reproduce',
          prompt: 'Write a failing test.',
          touches: [],
          after: [],
          reads: [],
          leaves_checks: 'red',
        },
        {
          name: 'fix',
          prompt: 'Make it pass.',
          touches: [],
          after: [{ agent: 'reproduce', why: 'the fix needs the failing test' }],
          reads: [],
          leaves_checks: 'green',
        },
      ],
    },
    shows: 'draft',
    rev: 'sha256:aaaa',
    problems: [],
    warnings: [],
    runs: 1,
    editable: true,
    ...over,
  })

  it('carries the steps, the inputs and the shape, with the form for each', () => {
    const [one] = workflowsIn([held()])
    expect(one?.steps.map((step) => step.name)).toEqual(['reproduce', 'fix'])
    expect(one?.inputs.map((input) => input.name)).toEqual(['repo', 'about'])
    // The shape: the columns `workflowPlaces` works out, with the parent by
    // **name** rather than by position.
    expect(one?.places.map((place) => [place.name, place.depth, place.parent])).toEqual([
      ['reproduce', 0, ''],
      ['fix', 1, 'reproduce'],
    ])
    // And the form, which is the window's own `workflowFields` — so neither
    // surface can offer a field the validator would refuse.
    expect(one?.fields.some((field) => field.id === 'title')).toBe(true)
    expect(one?.steps[0]?.fields.some((field) => field.id === 'prompt')).toBe(true)
  })

  it('says which template the steps are of, rather than leaving it to be guessed', () => {
    expect(workflowsIn([held()])[0]?.shows).toBe('draft')
    expect(workflowsIn([held({ shows: 'published' })])[0]?.shows).toBe('published')
    // A draft version only where the steps are a draft's: `v3` meaning two
    // things on one screen is the ambiguity this field exists to remove.
    expect(workflowsIn([held({ shows: 'published' })])[0]?.draft).toBeNull()
  })

  it('carries nothing of a workflow nothing could read, and says so', () => {
    const [one] = workflowsIn([held({ draft: null, shows: 'nothing', rev: '', editable: false })])
    expect(one?.steps).toEqual([])
    expect(one?.fields).toEqual([])
    expect(one?.places).toEqual([])
    expect(one?.rev).toBe('')
    expect(one?.editable).toBe(false)
    // And the versions and the counts still answer *is this published*.
    expect(one?.versions).toEqual([3, 2, 1])
    expect(one?.runs).toBe(1)
  })

  it('names the acts that stay at the machine, each with its clause', () => {
    const [one] = workflowsIn([held()])
    expect(one?.locally).toBe(WORKFLOW_LOCALLY)
    expect(one?.locally.map((act) => act.act)).toEqual(['publish', 'new', 'persona'])
    for (const act of one?.locally ?? []) expect(act.why.length).toBeGreaterThan(20)
  })
})

import { describe, expect, it } from 'vitest'
import {
  costSaid,
  directionFor,
  dotPath,
  GROUPS,
  graphOf,
  groupsOf,
  inOrder,
  MAP,
  mapOf,
  mapSaid,
  nowOf,
  orderOf,
  overallOf,
  PARTS,
  partOf,
  partsOf,
  runMark,
  shortNamesOf,
  stagesOf,
  standingOf,
  stepSays,
  toneOfPart,
  waitsOf,
  whySaid,
} from '../src/assets/pages/runs-shape.js'
import type { RunIn, RunStepIn } from '../src/factory.ts'
import { runRow } from '../src/factory.ts'
import { BUDGET } from '../src/page.ts'
import { EVERY, reach, run } from './fixtures.ts'

// What the runs page draws, against **real projected rows** rather than shapes
// a test assembled: every count, order, word and coordinate the two screens
// put on a page goes through `runRow`, so a field the projection renames or
// withholds is a red test here rather than a blank card on a phone.

const NOW = Date.parse('2026-10-09T14:30:00.000Z')

/** The view a screen is handed, with the grants a person gave this device. */
const view = (granted: readonly string[] = EVERY) => ({
  store: {
    you: { device: 'dev_7f3a9c21', reads: [...granted], talk: null },
    rows: {},
    pages: {},
    fresh: null,
    rev: 0,
    had: true,
  },
  asOf: NOW,
  frozen: false,
  now: NOW,
  may: {},
})

/** One step, queued and waiting on nothing, with what a test says over it. */
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
  usd: 0,
  ...over,
})

/** A run as the page is handed it: projected for a device granted everything. */
const row = (over: Partial<RunIn> = {}, granted: readonly string[] = EVERY) =>
  runRow(run(over), reach(granted as never), BUDGET)

/**
 * The run the redesign was drawn against: six steps across three projects,
 * two finished, one at work, one waiting on somebody, two not started.
 */
const SHIP = (): RunIn =>
  run({
    run: 'ship',
    projects: ['sentry', 'web', 'tade'],
    steps: [
      step({ task: 'sentry/ship-schema', name: 'ship-schema', state: 'merged', finished: true }),
      step({
        task: 'web/ship-tokens',
        project: 'web',
        name: 'ship-tokens',
        state: 'review',
        finished: true,
      }),
      step({
        task: 'sentry/ship-api',
        name: 'ship-api',
        state: 'working',
        layer: 1,
        active: true,
        waits: [{ task: 'sentry/ship-schema', why: 'reads the new tables' }],
      }),
      step({
        task: 'web/ship-client',
        project: 'web',
        name: 'ship-client',
        state: 'blocked',
        layer: 1,
        waits: [
          { task: 'web/ship-tokens', why: '' },
          { task: 'sentry/ship-schema', why: 'types come from it' },
        ],
      }),
      step({
        task: 'tade/ship-e2e',
        project: 'tade',
        name: 'ship-e2e',
        layer: 2,
        waits: [
          { task: 'sentry/ship-api', why: 'needs the endpoint' },
          { task: 'web/ship-client', why: 'needs the page' },
        ],
      }),
      step({
        task: 'tade/ship-notes',
        project: 'tade',
        name: 'ship-notes',
        layer: 3,
        waits: [{ task: 'tade/ship-e2e', why: 'says what shipped' }],
      }),
    ],
  })

describe('which part of a run a step is in', () => {
  it('follows the mark the step wears, and never a rule of its own', () => {
    expect(partOf(step({ finished: true, state: 'blocked' }))).toBe('finished')
    expect(partOf(step({ active: true }))).toBe('working')
    expect(partOf(step({ state: 'blocked' }))).toBe('wants')
    expect(partOf(step({ state: 'failed' }))).toBe('failed')
    expect(partOf(step({ state: 'review' }))).toBe('review')
    expect(partOf(step({ state: 'merged' }))).toBe('review')
    expect(partOf(step({ state: 'parked' }))).toBe('parked')
    expect(partOf(step())).toBe('waiting')
  })

  it('counts every step once, and keeps the parts a person looks for at nought', () => {
    const parts = partsOf(row(SHIP()).steps)
    expect(parts.reduce((total, one) => total + one.n, 0)).toBe(6)
    expect(Object.fromEntries(parts.map((one) => [one.key, one.n]))).toEqual({
      finished: 2,
      working: 1,
      wants: 1,
      failed: 0,
      waiting: 2,
    })
  })

  it('names in review and parked only where a step is in them', () => {
    const parts = partsOf([step({ state: 'review' }), step({ state: 'parked' })])
    expect(parts.map((one) => one.key)).toContain('review')
    expect(parts.map((one) => one.key)).toContain('parked')
  })

  it('tones each part as a chart tone, and a step out of sight as unknown', () => {
    for (const one of PARTS) expect(toneOfPart(one.key)).toBe(one.tone)
    expect(toneOfPart('unseen')).toBe('unknown')
  })
})

describe('which way a run stands', () => {
  it('wears its loudest step: wanting somebody, then failed, then at work', () => {
    expect(standingOf(row(SHIP()))).toBe('wants')
    const failed = SHIP().steps.map((one) =>
      one.state === 'blocked' ? { ...one, state: 'failed' as const } : one,
    )
    expect(standingOf(row({ steps: failed }))).toBe('failed')
    const going = SHIP().steps.filter((one) => one.state !== 'blocked')
    expect(standingOf(row({ steps: going }))).toBe('working')
    expect(runMark(row(SHIP())).tone).toBe('t-wants')
  })

  it('is finished only when every step is', () => {
    const all = SHIP().steps.map((one) => ({ ...one, finished: true, active: false }))
    expect(standingOf(row({ steps: all }))).toBe('finished')
  })

  it('says a run with no step this device may read is out of reach, never finished', () => {
    // Nought of nought is not done, and the one sentence a run nobody here
    // can see into must not say is *every step finished*.
    const narrow = row(SHIP(), EVERY)
    const none = runRow(SHIP(), reach(EVERY, ['elsewhere']), BUDGET)
    expect(none.total).toBe(0)
    expect(standingOf(none)).toBe('unseen')
    expect(standingOf(narrow)).not.toBe('unseen')
  })

  it('is in review where review is all that is left', () => {
    const steps = [
      step({ task: 'sentry/a', finished: true }),
      step({ task: 'sentry/b', state: 'review' }),
    ]
    expect(standingOf(row({ steps }))).toBe('review')
  })

  it('groups the runs in the order a person wants them, keeping their order inside', () => {
    const done = row({
      run: 'done',
      steps: SHIP().steps.map((one) => ({ ...one, finished: true, active: false })),
    })
    const quiet = row({ run: 'quiet', steps: [step()] })
    const groups = groupsOf([done, quiet, row(SHIP())])
    expect(groups.map((one) => one.key)).toEqual(GROUPS.map((one) => one.key))
    expect(groups.map((one) => one.runs.map((each) => each.run))).toEqual([
      ['ship'],
      ['quiet'],
      ['done'],
      [],
    ])
  })

  it('counts the runs and every step for the lead', () => {
    const all = overallOf([row(SHIP()), row({ run: 'quiet', steps: [step()] })])
    expect(all).toMatchObject({ runs: 2, needs: 1, going: 1, finished: 0, steps: 7, done: 2 })
  })
})

describe('what is happening in a run, now', () => {
  it('names what wants somebody first, then what is at work, by their short names', () => {
    const now = nowOf(row(SHIP()))
    expect(now.lines.map((one) => [one.name, one.said])).toEqual([
      ['client', 'wants you'],
      ['api', 'working'],
    ])
    expect(now.more).toBe(2)
  })

  it('names the next step waiting, and only what it waits on that has not finished', () => {
    const quiet = SHIP().steps.map((one) => ({
      ...one,
      active: false,
      state: one.finished ? one.state : ('queued' as const),
    }))
    const now = nowOf(row({ steps: quiet }))
    // `api` waits on `schema` alone, which has finished: so it is *queued*,
    // the queue's own word — never *ready*, which is the queue's rule to say.
    expect(now.lines[0]).toMatchObject({ name: 'api', said: 'queued' })
    expect(now.lines.find((one) => one.name === 'e2e')?.said).toBe('after api and client')
  })

  it('keeps to the room it is given, and says how many more', () => {
    const many = Array.from({ length: 6 }, (_, at) =>
      step({ task: `sentry/s${at}`, name: `s${at}`, state: 'blocked' }),
    )
    const now = nowOf(row({ steps: many }), 3)
    expect(now.lines).toHaveLength(3)
    expect(now.more).toBe(3)
  })
})

describe('what a step waits on', () => {
  it('says each wait, whether it finished, and the reason given', () => {
    const shipped = row(SHIP())
    const client = shipped.steps.find((one) => one.name === 'ship-client')
    const waits = waitsOf(client, shipped)
    expect(waits.map((one) => [one.name, one.finished])).toEqual([
      ['tokens', true],
      ['schema', true],
    ])
    expect(whySaid(waits[1] as never, view())).toBe('types come from it')
  })

  it('tells a reason nobody gave from one this device was not granted', () => {
    const shipped = row(SHIP())
    const client = shipped.steps.find((one) => one.name === 'ship-client')
    expect(whySaid(waitsOf(client, shipped)[0] as never, view())).toBe('no reason given')
    const bare = row(SHIP(), [])
    const withheld = bare.steps.find((one) => one.name === 'ship-client')
    expect(whySaid(waitsOf(withheld, bare)[1] as never, view([]))).toBe('reason not granted')
  })

  it('marks a reason cut short as cut', () => {
    expect(whySaid({ why: { words: 'the first part', more: true } }, view())).toBe(
      'the first part…',
    )
  })

  it('still names a wait on a step this device cannot see, and never as finished', () => {
    // Leaving it out would draw the step as free to go when it is not.
    const narrow = runRow(SHIP(), reach(EVERY, ['tade']), BUDGET)
    const e2e = narrow.steps.find((one) => one.name === 'ship-e2e')
    const waits = waitsOf(e2e, narrow)
    expect(waits.map((one) => [one.name, one.seen, one.finished, one.part])).toEqual([
      ['sentry/ship-api', false, false, 'unseen'],
      ['web/ship-client', false, false, 'unseen'],
    ])
  })
})

describe('a step’s name, without what every step of its run shares', () => {
  it('cuts the shared front at the end of a word', () => {
    const names = shortNamesOf(row(SHIP()).steps)
    expect([...names.values()]).toEqual(['schema', 'tokens', 'api', 'client', 'e2e', 'notes'])
  })

  it('cuts nothing inside a word, for one step, or where a step would lose its name', () => {
    const word = [step({ task: 'a/checkout', name: 'checkout' }), step({ name: 'checkpoint' })]
    expect([...shortNamesOf(word).values()]).toEqual(['checkout', 'checkpoint'])
    expect([...shortNamesOf([step({ name: 'ship-a' })]).values()]).toEqual(['ship-a'])
    const whole = [step({ task: 'a/ship-', name: 'ship-' }), step({ name: 'ship-a' })]
    expect([...shortNamesOf(whole).values()]).toEqual(['ship-', 'ship-a'])
  })
})

describe('the stages', () => {
  it('are the wire’s own layers, each with what it waits on and how far along', () => {
    const stages = stagesOf(row(SHIP()))
    expect(stages.map((one) => [one.name, one.said, one.done, one.steps.length])).toEqual([
      ['Stage 1', 'can go first', 2, 2],
      ['Stage 2', 'after stage 1', 0, 2],
      ['Stage 3', 'after stage 2', 0, 1],
      ['Stage 4', 'after stage 3', 0, 1],
    ])
    expect(stages.map((one) => one.part)).toEqual(['finished', 'wants', 'waiting', 'waiting'])
  })

  it('leaves a gap in the numbers where a stage is out of sight', () => {
    // Two stages quietly becoming one would tell somebody nothing stood
    // between them.
    const narrow = runRow(SHIP(), reach(EVERY, ['sentry', 'tade']), BUDGET)
    expect(stagesOf(narrow).map((one) => one.name)).toEqual([
      'Stage 1',
      'Stage 2',
      'Stage 3',
      'Stage 4',
    ])
    const gappy = runRow(SHIP(), reach(EVERY, ['tade']), BUDGET)
    expect(stagesOf(gappy).map((one) => [one.name, one.said])).toEqual([
      ['Stage 3', 'after steps not on this page'],
      ['Stage 4', 'after stage 3'],
    ])
  })
})

describe('the map', () => {
  it('puts a dot per step in its stage’s column, packed where a stage is out of sight', () => {
    const drawn = mapOf(row(SHIP()))
    const at = new Map(drawn.dots.map((one) => [one.task, one]))
    const x = (layer: number) => MAP.pad + MAP.r + layer * MAP.dx
    expect(at.get('sentry/ship-schema')?.x).toBe(x(0))
    expect(at.get('tade/ship-notes')?.x).toBe(x(3))
    expect(drawn.width).toBe(2 * (MAP.pad + MAP.r) + 3 * MAP.dx)
    expect(drawn.height).toBe(2 * (MAP.pad + MAP.r) + MAP.dy)
    const gappy = mapOf(runRow(SHIP(), reach(EVERY, ['tade']), BUDGET))
    expect(gappy.dots.map((one) => one.x)).toEqual([x(0), x(1)])
  })

  it('draws a line from a finished step solid and from an unfinished one as ahead', () => {
    const lines = mapOf(row(SHIP())).lines
    expect(lines).toHaveLength(6)
    const from = (task: string) => lines.filter((one) => one.from === task)
    expect(from('sentry/ship-schema').every((one) => one.done)).toBe(true)
    expect(from('sentry/ship-api').every((one) => !one.done)).toBe(true)
  })

  it('orders a stage by what it waits on, so lines cross as little as they can', () => {
    const steps = [
      step({ task: 'x/a', name: 'a' }),
      step({ task: 'x/b', name: 'b' }),
      step({ task: 'x/on-b', layer: 1, waits: [{ task: 'x/b', why: '' }] }),
      step({ task: 'x/on-a', layer: 1, waits: [{ task: 'x/a', why: '' }] }),
    ]
    const order = orderOf(row({ steps }).steps)
    expect(order.get('x/on-a')).toBe(0)
    expect(order.get('x/on-b')).toBe(1)
  })

  it('reads the steps stage by stage, in the order the map places them', () => {
    // The track's segments go in this order, so the third segment is the
    // third dot — whatever order the task files happened to be read in.
    const steps = [
      step({ task: 'x/late', layer: 1, waits: [{ task: 'x/b', why: '' }] }),
      step({ task: 'x/a', name: 'a' }),
      step({ task: 'x/b', name: 'b' }),
      step({ task: 'x/early', layer: 1, waits: [{ task: 'x/a', why: '' }] }),
    ]
    expect(inOrder(row({ steps }).steps).map((one) => one.task)).toEqual([
      'x/a',
      'x/b',
      'x/early',
      'x/late',
    ])
  })

  it('survives two steps waiting on each other, which a file anybody can edit may say', () => {
    const steps = [
      step({ task: 'x/a', waits: [{ task: 'x/b', why: '' }] }),
      step({ task: 'x/b', waits: [{ task: 'x/a', why: '' }] }),
    ]
    expect(mapOf(row({ steps })).dots).toHaveLength(2)
    expect(stagesOf(row({ steps }))).toHaveLength(1)
  })

  it('draws a dot in its glyph’s shape, so the map says which without its colour', () => {
    const at = { x: 20, y: 20 }
    const shapes = ['finished', 'wants', 'failed', 'parked'].map((part) => dotPath({ ...at, part }))
    expect(new Set(shapes).size).toBe(4)
    expect(dotPath({ ...at, part: 'waiting' })).toBe(dotPath({ ...at, part: 'working' }))
  })

  it('is said in a sentence, since its dots are a picture', () => {
    expect(mapSaid(row(SHIP()))).toBe(
      '6 steps in 4 stages: 2 finished, 1 working, 1 wants you, 2 waiting',
    )
  })

  it('is nothing for a run with no step to draw', () => {
    expect(mapOf(runRow(SHIP(), reach(EVERY, ['elsewhere']), BUDGET))).toMatchObject({
      dots: [],
      width: 0,
      height: 0,
    })
  })
})

describe('the graph, as boxes and curves', () => {
  it('is a box per step under its short name, and an edge per wait it can see', () => {
    const graph = graphOf(row(SHIP()))
    expect(graph.nodes.map((one) => one.label)).toEqual([
      'schema',
      'tokens',
      'api',
      'client',
      'e2e',
      'notes',
    ])
    expect(graph.nodes.find((one) => one.label === 'client')).toMatchObject({
      under: 'web · wants you',
      tone: 'wants',
      href: '/t/web/ship-client',
    })
    expect(graph.edges).toHaveLength(6)
    expect(graph.edges.filter((one) => one.tone === 'done')).toHaveLength(3)
    const narrow = graphOf(runRow(SHIP(), reach(EVERY, ['tade']), BUDGET))
    expect(narrow.edges).toEqual([{ from: 'tade/ship-e2e', to: 'tade/ship-notes', tone: 'queued' }])
  })

  it('goes across where it fits, down where only that fits, and across when it cannot tell', () => {
    const graph = graphOf(row(SHIP()))
    // Four layers of 184 with 48 between is 880 across; two of 184 with 12
    // between is 380 down.
    expect(directionFor(graph, 900)).toBe('right')
    expect(directionFor(graph, 832)).toBe('down')
    expect(directionFor(graph, 300)).toBe('down')
    expect(directionFor(graph, 0)).toBe('right')
  })
})

describe('money, said once and never as nought', () => {
  it('says the run’s figure, which nothing, or the figure', () => {
    expect(costSaid(null, view([]))).toBe('— not granted')
    expect(costSaid(null, view())).toBe('— not recorded')
    expect(costSaid(4.9, view())).toBe('$4.90')
  })

  it('leaves money out of a step’s line altogether', () => {
    const said = stepSays(row(SHIP()).steps[0])
    expect(said).toBe('checks not run here')
    expect(
      stepSays(row({ steps: [step({ checks: 'fail', review: 'open', runs: 3 })] }).steps[0]),
    ).toBe('checks red · review open · 3 agents have been on it')
  })
})

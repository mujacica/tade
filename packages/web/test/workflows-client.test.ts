import { describe, expect, it } from 'vitest'
import {
  boxAfter,
  boxDirty,
  choicesOf,
  cutOf,
  editorOf,
  fieldLabel,
  fieldSaid,
  fitsAcross,
  GROUPS,
  graphOf,
  groupsOf,
  MOST_VERSIONS,
  overallOf,
  partsOf,
  prefillOf,
  readinessOf,
  runStandingOf,
  runsFrom,
  runsLineOf,
  runsSaid,
  shapeOf,
  shapeSaid,
  stagesOf,
  standingOf,
  stepFactsOf,
  toggledValue,
  toggleSaid,
  versionsOf,
  versionsSaid,
} from '../src/assets/pages/workflows-shape.js'
import type { RunIn, WorkflowIn } from '../src/factory.ts'
import { runRow, workflowRow } from '../src/factory.ts'
import { BUDGET } from '../src/page.ts'
import { EVERY, reach, run, workflow } from './fixtures.ts'

// What the workflows page draws, against **real projected rows** rather than
// shapes a test assembled: every count, order, word and coordinate the two
// screens put on a page goes through `workflowRow` and `runRow`, so a field
// the projection renames or withholds is a red test here rather than a blank
// card on a phone.

/** A workflow as the page is handed it: projected for a device granted everything. */
const row = (over: Partial<WorkflowIn> = {}) => workflowRow(workflow(over), reach(EVERY), BUDGET)

/** A run as the page is handed it. */
const ran = (over: Partial<RunIn> = {}) => runRow(run(over), reach(EVERY), BUDGET)

/** A run stamped from `name@version`, every step finished or not. */
const stamped = (name: string, version: number, finished: boolean, id = `${name}-${version}`) => {
  const base = run()
  return ran({
    run: id,
    stamp: { name, version },
    steps: base.steps.map((step) => ({
      ...step,
      finished,
      state: finished ? 'merged' : step.state,
    })),
  })
}

/** The places of a plan → api and web side by side → ship. */
const DIAMOND = [
  { at: 0, name: 'plan', depth: 0, parent: '', why: [], circular: false },
  {
    at: 1,
    name: 'api',
    depth: 1,
    parent: 'plan',
    why: [{ on: 'plan', why: 'needs the plan' }],
    circular: false,
  },
  {
    at: 2,
    name: 'web',
    depth: 1,
    parent: 'plan',
    why: [{ on: 'plan', why: '' }],
    circular: false,
  },
  {
    at: 3,
    name: 'ship',
    depth: 2,
    parent: 'api',
    why: [
      { on: 'api', why: 'ships what the api made' },
      { on: 'web', why: 'and the client' },
    ],
    circular: false,
  },
]

describe('where a workflow stands', () => {
  it('reads each standing off the row’s own answers, loudest first', () => {
    expect(standingOf(row({ builtIn: true, problems: ['no title'] }))).toBe('shipped')
    expect(standingOf(row({ problems: ['no title'] }))).toBe('broken')
    expect(standingOf(row())).toBe('draft')
    expect(standingOf(row({ draft: null, shows: 'published' }))).toBe('published')
    expect(standingOf(row({ draft: null, versions: [], shows: 'nothing' }))).toBe('empty')
  })

  it('keeps the standings that are facts at nought, and leaves the rest out', () => {
    const parts = partsOf([row()])
    expect(parts.map((one) => one.key)).toEqual(['broken', 'draft', 'published'])
    expect(parts.find((one) => one.key === 'broken')?.n).toBe(0)
    expect(parts.find((one) => one.key === 'draft')?.n).toBe(1)
    // One Tade ships appears only where there is one: a legend saying *ships
    // with Tade 0* about every hand-written catalogue is noise.
    expect(partsOf([row({ builtIn: true })]).map((one) => one.key)).toContain('shipped')
  })

  it('groups the drafts first, the one that would not publish leading them', () => {
    const groups = groupsOf([
      row({ name: 'b-open' }),
      row({ name: 'z-broken', problems: ['no steps'] }),
      row({ name: 'a-done', draft: null, shows: 'published' }),
      row({ name: 'tade-own', builtIn: true }),
    ])
    expect(groups.map((one) => one.key)).toEqual(GROUPS.map((one) => one.key))
    expect(groups[0]?.rows.map((one) => one.name)).toEqual(['z-broken', 'b-open'])
    expect(groups[1]?.rows.map((one) => one.name)).toEqual(['a-done'])
    expect(groups[2]?.rows.map((one) => one.name)).toEqual(['tade-own'])
  })
})

describe('the runs stamped from one', () => {
  it('finds a workflow’s own runs and none of another’s', () => {
    const runs = [ran(), stamped('other', 1, false)]
    expect(runsFrom(row(), runs).map((one) => one.run)).toEqual(['shop-1402'])
  })

  it('reads a run’s standing off its steps’ marks', () => {
    // The fixture's run: its first step finished, its second queued behind it.
    expect(runStandingOf(ran())).toBe('waiting')
    expect(runStandingOf(stamped('reproduce-and-fix', 3, true))).toBe('finished')
    const blocked = run()
    const wants = ran({
      steps: blocked.steps.map((step, at) => (at === 1 ? { ...step, state: 'blocked' } : step)),
    })
    expect(runStandingOf(wants)).toBe('wants')
  })

  it('says a run this device cannot read is a run, not one fewer', () => {
    // The machine says two runs point at it; this device can see one.
    const line = runsLineOf(row(), [ran()])
    expect(line.total).toBe(2)
    expect(line.parts.map((one) => [one.key, one.n])).toEqual([
      ['waiting', 1],
      ['unseen', 1],
    ])
    expect(runsSaid(line)).toBe('2 runs: 1 waiting and 1 not readable here')
  })

  it('says never run rather than drawing nought of nothing', () => {
    const line = runsLineOf(row({ runs: 0 }), [])
    expect(line.total).toBe(0)
    expect(runsSaid(line)).toBe('never run')
  })

  it('counts the runs under way for the lead, and every run the machine counted', () => {
    const all = overallOf([row(), row({ name: 'quiet', runs: 0 })], [ran()])
    expect(all.workflows).toBe(2)
    expect(all.runs).toBe(2)
    expect(all.going).toBe(1)
  })
})

describe('the line of its versions', () => {
  it('draws the published oldest first, the newest as its own kind, then the draft', () => {
    const line = versionsOf(row(), [ran()])
    expect(line.marks.map((one) => [one.label, one.kind])).toEqual([
      ['v1', 'published'],
      ['v2', 'published'],
      ['v3', 'newest'],
      ['v4', 'draft'],
    ])
    // The fixture's run is stamped from v3, and it says so under v3.
    expect(line.marks.find((one) => one.label === 'v3')?.runs).toBe(1)
    expect(line.earlier).toBe(0)
  })

  it('counts the oldest past its room rather than drawing them all', () => {
    const many = Array.from({ length: 10 }, (_, at) => 10 - at)
    const line = versionsOf(row({ versions: many, draft: null, shows: 'published' }))
    expect(line.marks).toHaveLength(MOST_VERSIONS)
    expect(line.marks.at(-1)).toMatchObject({ label: 'v10', kind: 'newest' })
    expect(line.earlier).toBe(10 - MOST_VERSIONS)
  })

  it('says a published version and the draft apart in its sentence', () => {
    expect(versionsSaid(row(), [ran()])).toBe('published v1, v2 and v3; draft v4 open; 1 run on v3')
    expect(versionsSaid(row({ versions: [], draft: 1 }))).toBe('never published; draft v1 open')
  })
})

describe('the shape its steps make', () => {
  it('puts each stage in a column and a curve on each wait', () => {
    const shape = shapeOf(row().places)
    expect(shape.stages).toBe(2)
    expect(shape.dots.map((one) => one.name)).toEqual(['reproduce', 'fix'])
    const [first, second] = shape.dots
    expect(second?.x).toBeGreaterThan(first?.x ?? 0)
    expect(second?.y).toBe(first?.y)
    expect(shape.lines.map((one) => [one.from, one.to])).toEqual([['reproduce', 'fix']])
  })

  it('centres a short stage against a tall one', () => {
    const shape = shapeOf(DIAMOND)
    const at = new Map(shape.dots.map((one) => [one.name, one]))
    expect(at.get('plan')?.y).toBe(((at.get('api')?.y ?? 0) + (at.get('web')?.y ?? 0)) / 2)
    expect(at.get('ship')?.y).toBe(at.get('plan')?.y)
    expect(shape.lines).toHaveLength(4)
  })

  it('names a step in a cycle and never draws it at some column', () => {
    const places = [
      ...row().places,
      { at: 2, name: 'loop', depth: 0, parent: null, why: [], circular: true },
    ]
    const shape = shapeOf(places)
    expect(shape.dots.map((one) => one.name)).not.toContain('loop')
    expect(shape.circular).toEqual(['loop'])
    expect(shapeSaid(places)).toBe('2 steps in 2 stages · 1 in a cycle')
  })

  it('says the shape in words', () => {
    expect(shapeSaid(row().places)).toBe('2 steps in 2 stages')
    expect(shapeSaid([])).toBe('no steps yet')
    expect(shapeSaid(DIAMOND)).toBe('4 steps in 3 stages')
  })

  it('names each stage by what it waits on', () => {
    const stages = stagesOf({ ...row(), places: DIAMOND })
    expect(stages.map((one) => [one.n, one.label])).toEqual([
      [1, 'goes first'],
      [2, 'after plan'],
      [3, 'after api and web'],
    ])
    // A step the device was sent is carried with its stage; one it was not is
    // still named, because the places ride without the grant.
    const own = stagesOf(row())
    expect(own[0]?.steps[0]?.step?.persona).toBe('tester')
    expect(stagesOf({ ...row(), places: DIAMOND })[0]?.steps[0]?.step).toBeNull()
  })

  it('draws boxes across only where they fit, and numbers each by its stage', () => {
    const graph = graphOf({ ...row(), places: DIAMOND })
    expect(graph.nodes.map((one) => [one.id, one.glyph])).toEqual([
      ['plan', '1'],
      ['api', '2'],
      ['web', '2'],
      ['ship', '3'],
    ])
    expect(graph.edges).toHaveLength(4)
    // Three stages of 184px boxes and 48px gaps is 648px across.
    expect(fitsAcross(graph, 360)).toBe(false)
    expect(fitsAcross(graph, 700)).toBe(true)
    // One box is not a graph, and a room nobody measured is not a room.
    expect(fitsAcross(graphOf({ ...row(), places: DIAMOND.slice(0, 1) }), 900)).toBe(false)
    expect(fitsAcross(graph, 0)).toBe(false)
  })
})

describe('how it would publish', () => {
  it('says each answer in its own words', () => {
    expect(readinessOf(row()).said).toBe('Draft v4 would publish, with 1 warning')
    expect(readinessOf(row({ warnings: [] })).said).toBe('Draft v4 would publish as it stands')
    expect(readinessOf(row({ problems: ['a', 'b'] }))).toMatchObject({
      glyph: '▲',
      tone: 't-failed',
      said: '2 things would stop this draft publishing',
    })
    expect(readinessOf(row({ draft: null, shows: 'published' })).said).toBe(
      'No draft open: v3 is what a run is stamped from',
    )
    expect(readinessOf(row({ builtIn: true })).tone).toBe('t-quiet')
  })
})

describe('a step and its fields', () => {
  it('lists only the facts a step has, saying what red means', () => {
    const [reproduce, fix] = row().steps
    expect(stepFactsOf(reproduce).map((one) => [one.label, one.value])).toEqual([
      ['finished when', 'said'],
      ['leaves the checks', 'red, on purpose'],
      ['touches', 'test/'],
    ])
    expect(stepFactsOf(fix).map((one) => one.label)).not.toContain('touches')
  })

  it('names a field as a person reads it, and its value in words', () => {
    const why = { id: 'why:reproduce', label: '  why it waits', value: null, kind: 'text' }
    expect(fieldLabel(why)).toBe('Why it waits on reproduce')
    expect(fieldSaid(why)).toBe('—')
    const tick = {
      id: 'after:reproduce',
      label: 'After reproduce',
      value: { words: 'true', more: false },
      kind: 'check',
      options: [],
    }
    expect(fieldSaid(tick)).toBe('yes')
    expect(editorOf(tick)).toBe('toggle')
    expect(toggleSaid(tick)).toBe('Stop waiting on reproduce')
    expect(toggleSaid({ ...tick, value: { words: 'false', more: false } })).toBe(
      'Wait on reproduce',
    )
  })

  it('offers a choice with what it holds always among its options', () => {
    const field = {
      id: 'name_suffix',
      label: 'Name suffix',
      value: { words: '', more: false },
      kind: 'choice',
      options: ['slug'],
    }
    expect(choicesOf(field)).toEqual([
      { value: '', said: 'none' },
      { value: 'slug', said: 'slug' },
    ])
    expect(editorOf(field)).toBe('choice')
  })

  it('never starts a box with only the start of what is stored', () => {
    // A box holding a cut value is a save that throws the rest away.
    const prompt = row().steps[0]?.fields.find((one) => one.id === 'prompt')
    expect(editorOf(prompt)).toBe('long')
    expect(prefillOf(prompt)).toBe('Write a failing test.')
    expect(cutOf(prompt)).toBe('')
    const cut = { ...prompt, value: { words: 'Write a fail', more: true } }
    expect(prefillOf(cut)).toBe('')
    expect(cutOf(cut)).toContain('replaces all of it')
  })
})

describe('a box somebody is typing in', () => {
  /** A box as a fill finds it. */
  const box = (over = {}) => ({
    value: 'Write a failing test.',
    was: 'Write a failing test.',
    saved: null,
    focused: false,
    ...over,
  })

  it('follows the draft while nobody has typed in it', () => {
    const next = boxAfter(box(), 'Write two failing tests.', 'sha256:2')
    expect(next.value).toBe('Write two failing tests.')
    expect(next.was).toBe('Write two failing tests.')
    expect(boxDirty(next)).toBe(false)
    // The first fill of a box that was never filled is a box nobody typed in.
    expect(boxAfter(box({ value: '', was: null }), 'held', 'sha256:1').value).toBe('held')
  })

  it('keeps what somebody typed, whatever the draft says next', () => {
    const typed = box({ value: 'my own words' })
    const next = boxAfter(typed, 'Write two failing tests.', 'sha256:2')
    expect(next.value).toBe('my own words')
    expect(boxDirty(next)).toBe(true)
  })

  it('never rewrites a box the keyboard is in, and then says it differs', () => {
    const next = boxAfter(box({ focused: true }), 'somebody else’s words', 'sha256:2')
    expect(next.value).toBe('Write a failing test.')
    expect(boxDirty(next)).toBe(true)
  })

  it('keeps a saved value until the draft it was saved against has moved', () => {
    // Saved at sha256:1: a beat still at sha256:1 carries the old value, and
    // putting it back would look like the save undoing itself.
    const saved = box({ value: 'new words', was: 'new words', saved: 'sha256:1' })
    const early = boxAfter(saved, 'Write a failing test.', 'sha256:1')
    expect(early.value).toBe('new words')
    expect(boxDirty(early)).toBe(false)
    // The machine has read the draft again: the box follows it from here.
    const read = boxAfter(saved, 'new words', 'sha256:2')
    expect(read).toEqual({ value: 'new words', was: 'new words', saved: null, focused: false })
  })

  it('sends a tick the other answer, which is what saving one does', () => {
    const tick = { id: 'after:plan', value: { words: 'true', more: false }, kind: 'check' }
    expect(toggledValue(tick)).toBe('false')
    expect(toggledValue({ ...tick, value: { words: 'false', more: false } })).toBe('true')
  })
})

import { nothingHandedSays } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { workflowSays } from '../src/assets/designer.js'
import { emptySays, factsOf } from '../src/assets/factory.js'
import { runSays, stepSays } from '../src/assets/runs.js'
import { intakeRow, runRow, sourceRow, workflowRow } from '../src/factory.ts'
import { BUDGET } from '../src/page.ts'
import { projector } from '../src/reading.ts'
import { EVERY, input, intake, reach, run, source, workflow } from './fixtures.ts'

// What the factory screens say, against **real projected rows** rather than
// shapes a test assembled.
//
// The reason this file exists at all is a bug it would have caught on the day
// it was written: `money` answers with `{ said, mark, why }` — because *not
// granted*, *not recorded* and *nought* are three different mornings — and a
// caller that treated it as a string put `[object Object]` in a column. There
// is no DOM in this repository's lockfile, so a rule inside a listener could
// only be checked in a real browser; what can be checked here is every pure
// sentence these screens build, and every one of them goes through a row the
// projection actually produced.

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

const rowFor = (granted: readonly string[] = EVERY) =>
  runRow(run(), reach(granted as never), BUDGET)

describe('one run, in a line', () => {
  it('says what is happening, what it was stamped from and what it cost', () => {
    const said = runSays(rowFor(), view())
    expect(said).toContain('1 waiting')
    expect(said).toContain('reproduce-and-fix@3')
    expect(said).toContain('1 delivery retry')
    // **A figure and never `[object Object]`.** `money` answers with a shape
    // and this is the caller that has to read it.
    expect(said).toContain('$1.25')
    expect(said).not.toContain('object')
  })

  it('says nothing about money where the figure is not this device’s to see', () => {
    // Not a dash in a list of clauses: a run's quiet line is the wrong place
    // to say *which* nothing, and its own screen has the room.
    const said = runSays(rowFor([]), view([]))
    expect(said).not.toContain('—')
    expect(said).not.toContain('$')
    expect(said).toContain('1 waiting')
  })

  it('says every step finished rather than nothing at all', () => {
    const whole = run({
      steps: run().steps.map((step) => ({ ...step, finished: true, active: false })),
    })
    expect(runSays(runRow(whole, reach(EVERY), BUDGET), view())).toContain('every step finished')
  })

  it('names what is working, where something is', () => {
    const going = run({
      steps: run().steps.map((step, at) => ({ ...step, active: at === 0, finished: false })),
    })
    expect(runSays(runRow(going, reach(EVERY), BUDGET), view())).toContain(
      'github-1402-reproduce working',
    )
  })
})

describe('one step of a run, in a line', () => {
  it('says its checks, its review and how many agents have been on it', () => {
    const step = rowFor().steps[0]
    const said = stepSays(step, view())
    expect(said).toContain('red')
    expect(said).toContain('review open')
    // **Two is a retry**, and that is the whole of the history: there is no
    // counter, only how many starts the journal still holds.
    expect(said).toContain('2 agents have been on it')
  })

  it('says one agent as nothing, because one is not worth saying', () => {
    const once = { ...rowFor().steps[0], runs: 1 }
    expect(stepSays(once, view())).not.toContain('agents have been on it')
  })

  it('says the cost is not granted rather than drawing nought', () => {
    const said = stepSays(rowFor([]).steps[0], view([]))
    expect(said).toContain('cost not granted')
  })
})

describe('what an empty inbox says', () => {
  it('says the trouble first, because that is the one somebody can act on', () => {
    const rows = [
      sourceRow(source({ source: 'cli', state: 'quiet' }), reach()),
      sourceRow(source({ state: 'unreachable' }), reach()),
    ]
    expect(emptySays(rows)).toBe(rows[1]?.because)
  })

  it('agrees with the domain’s own answer, which is where the sentences are', () => {
    // The page picks which sentence to draw and writes none of its own, so the
    // two readings of *which nothing* cannot drift. `nothingHandedSays` is the
    // domain's, over the same standings.
    const doors = [
      source({ source: 'cli', state: 'off' }),
      source({ state: 'off', source: 'github' }),
    ]
    const rows = doors.map((one) => sourceRow(one, reach()))
    expect(emptySays(rows)).toBe(nothingHandedSays(doors))
  })

  it('says how many doors are being looked with where they disagree', () => {
    const rows = [
      sourceRow(source({ source: 'cli', state: 'quiet' }), reach()),
      sourceRow(source({ state: 'found' }), reach()),
    ]
    expect(emptySays(rows)).toContain('2 sources are being looked with')
  })

  it('says so where no source is implemented here', () => {
    expect(emptySays([])).toBe('no source is implemented here')
  })
})

describe('where one request came from', () => {
  const facts = (granted: readonly string[] = EVERY) =>
    new Map(
      factsOf(intakeRow(intake(), reach(granted as never), BUDGET), view(granted)).map(
        (one) => [one[0], one[1]] as const,
      ),
    )

  it('names the source, the key that allowed it, and what it was stamped from', () => {
    const found = facts()
    expect(found.get('source')).toBe('github')
    expect(found.get('allowed by')).toBe('surfaces.intake.sources.github')
    expect(found.get('workflow')).toBe('reproduce-and-fix@3')
    expect(found.get('tried')).toBe('0 of 3')
  })

  it('says both revisions where the request has moved since the work was made', () => {
    expect(facts().get('revision')).toContain('work made for')
  })

  it('says the one revision where it has not', () => {
    const still = intakeRow(intake({ taken: intake().revision }), reach(EVERY), BUDGET)
    expect(new Map(factsOf(still, view()).map((one) => [one[0], one[1]])).get('revision')).toBe(
      intake().revision,
    )
  })

  it('tells a handle nobody said from one this device may not read', () => {
    // Two dashes, two answers. `—` is *nobody said who*, and the other is this
    // device not having been granted the words.
    expect(facts().get('asked by')).toBe('@octocat-Vb2')
    expect(facts([]).get('asked by')).toBe('not granted')
    const nameless = intakeRow(intake({ who: '' }), reach(EVERY), BUDGET)
    expect(new Map(factsOf(nameless, view()).map((one) => [one[0], one[1]])).get('asked by')).toBe(
      '—',
    )
  })

  it('draws a dash where nobody said, never a blank', () => {
    const bare = intakeRow(intake({ grant: '', mode: null, ref: '' }), reach(EVERY), BUDGET)
    const found = new Map(factsOf(bare, view()).map((one) => [one[0], one[1]]))
    expect(found.get('allowed by')).toBe('—')
    expect(found.get('mode')).toBe('—')
    expect(found.get('raw material')).toBe('—')
  })

  it('says a request no workflow stamped as one task', () => {
    const plain = intakeRow(intake({ stamp: null }), reach(EVERY), BUDGET)
    expect(new Map(factsOf(plain, view()).map((one) => [one[0], one[1]])).get('workflow')).toBe(
      'none: one task',
    )
  })
})

describe('one workflow, in a line', () => {
  it('says a published version and a draft apart, always', () => {
    const said = workflowSays(workflowRow(workflow(), reach(EVERY), BUDGET))
    expect(said).toContain('draft v4')
    expect(said).toContain('2 steps')
    expect(said).toContain('2 runs')
  })

  it('says what would stop it publishing, as a count', () => {
    const broken = workflowRow(
      workflow({ problems: ['no title', 'no steps'] }),
      reach(EVERY),
      BUDGET,
    )
    expect(workflowSays(broken)).toContain('2 would stop it publishing')
  })

  it('says one Tade ships, because its bytes are not anybody’s to edit', () => {
    const shipped = workflowRow(workflow({ builtIn: true }), reach(EVERY), BUDGET)
    expect(workflowSays(shipped)).toContain('one Tade ships')
  })

  it('says nothing of the content for a device that was not granted it', () => {
    const bare = workflowRow(workflow(), reach([]), BUDGET)
    const said = workflowSays(bare)
    expect(said).not.toContain('steps')
    expect(said).toContain('draft v4')
  })
})

describe('a run with no step this device may read', () => {
  it('says so rather than drawing a heading with nothing under it', () => {
    // An empty paragraph under a heading reads as something that failed to
    // load. The narrowing is honest — every step is in a project this phone
    // was not granted — so the sentence is the one that says which.
    const narrow = runRow(run(), reach(EVERY, ['tade']), BUDGET)
    expect(narrow.steps).toEqual([])
    expect(narrow.layers).toBe(0)
    expect(narrow.projects).toEqual([])
  })
})

describe('the whole projection, as the page would be handed it', () => {
  it('carries every one of the four collections with its own count', () => {
    const made = projector(input({ reach: reach(EVERY) }), NOW).snapshot()
    expect(made.pages.intake.total).toBe(1)
    expect(made.pages.sources.total).toBe(2)
    expect(made.pages.runs.total).toBe(1)
    expect(made.pages.workflows.total).toBe(1)
  })

  it('withholds the workflows as a count rather than as an empty list', () => {
    // *There is one workflow and you may not read it from here* is the honest
    // shape of a read scope; a nought reads as *you have none*.
    const made = projector(input({ reach: reach([]) }), NOW).snapshot()
    expect(made.pages.workflows.total).toBe(1)
    expect(made.pages.workflows.omitted).toBe(1)
    expect(made.workflows).toEqual([])
  })
})

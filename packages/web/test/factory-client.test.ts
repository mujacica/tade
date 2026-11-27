import { nothingHandedSays } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { emptySays, factsOf } from '../src/assets/pages/inbox.js'
import { runSays, stepSays } from '../src/assets/pages/runs.js'
import { workflowSays } from '../src/assets/pages/workflows.js'
import { intakeRow, runRow, sourceRow, workflowRow } from '../src/factory.ts'
import { BUDGET } from '../src/page.ts'
import { projector } from '../src/reading.ts'
import { input, intake, reach, run, source, workflow } from './fixtures.ts'

// What the factory screens say, against **real projected rows** rather than
// shapes a test assembled.
//
// The reason this file exists at all is a bug it would have caught on the day
// it was written: `money` answers with `{ said, mark, why }` — because *not
// recorded* and *nought* are different mornings — and a
// caller that treated it as a string put `[object Object]` in a column. There
// is no DOM in this repository's lockfile, so a rule inside a listener could
// only be checked in a real browser; what can be checked here is every pure
// sentence these screens build, and every one of them goes through a row the
// projection actually produced.

const NOW = Date.parse('2026-10-09T14:30:00.000Z')

/** The view a screen is handed. */
const view = () => ({
  store: {
    you: { device: 'dev_7f3a9c21', talk: null },
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

const rowFor = () => runRow(run(), reach(), BUDGET)

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

  it('says every step finished rather than nothing at all', () => {
    const whole = run({
      steps: run().steps.map((step) => ({ ...step, finished: true, active: false })),
    })
    expect(runSays(runRow(whole, reach(), BUDGET), view())).toContain('every step finished')
  })

  it('names what is working, where something is', () => {
    const going = run({
      steps: run().steps.map((step, at) => ({ ...step, active: at === 0, finished: false })),
    })
    expect(runSays(runRow(going, reach(), BUDGET), view())).toContain(
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
})

describe('what an empty inbox says', () => {
  it('says the trouble first, because that is the one somebody can act on', () => {
    const rows = [
      sourceRow(source({ source: 'cli', state: 'quiet' })),
      sourceRow(source({ state: 'unreachable' })),
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
    const rows = doors.map((one) => sourceRow(one))
    expect(emptySays(rows)).toBe(nothingHandedSays(doors))
  })

  it('says how many doors are being looked with where they disagree', () => {
    const rows = [
      sourceRow(source({ source: 'cli', state: 'quiet' })),
      sourceRow(source({ state: 'found' })),
    ]
    expect(emptySays(rows)).toContain('2 sources are being looked with')
  })

  it('says so where no source is implemented here', () => {
    expect(emptySays([])).toBe('no source is implemented here')
  })
})

describe('where one request came from', () => {
  const facts = () =>
    new Map(factsOf(intakeRow(intake(), BUDGET)).map((one) => [one[0], one[1]] as const))

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
    const still = intakeRow(intake({ taken: intake().revision }), BUDGET)
    expect(new Map(factsOf(still).map((one) => [one[0], one[1]])).get('revision')).toBe(
      intake().revision,
    )
  })

  it('says the handle, and a dash where nobody said who', () => {
    expect(facts().get('asked by')).toBe('@octocat-Vb2')
    const nameless = intakeRow(intake({ who: '' }), BUDGET)
    expect(new Map(factsOf(nameless).map((one) => [one[0], one[1]])).get('asked by')).toBe('—')
  })

  it('draws a dash where nobody said, never a blank', () => {
    const bare = intakeRow(intake({ grant: '', mode: null, ref: '' }), BUDGET)
    const found = new Map(factsOf(bare).map((one) => [one[0], one[1]]))
    expect(found.get('allowed by')).toBe('—')
    expect(found.get('mode')).toBe('—')
    expect(found.get('raw material')).toBe('—')
  })

  it('says a request no workflow stamped as one task', () => {
    const plain = intakeRow(intake({ stamp: null }), BUDGET)
    expect(new Map(factsOf(plain).map((one) => [one[0], one[1]])).get('workflow')).toBe(
      'none: one task',
    )
  })
})

describe('one workflow, in a line', () => {
  it('says a published version and a draft apart, always', () => {
    const said = workflowSays(workflowRow(workflow(), BUDGET))
    expect(said).toContain('draft v4')
    expect(said).toContain('2 steps')
    expect(said).toContain('2 plans')
  })

  it('says what would stop it publishing, as a count', () => {
    const broken = workflowRow(workflow({ problems: ['no title', 'no steps'] }), BUDGET)
    expect(workflowSays(broken)).toContain('2 would stop it publishing')
  })

  it('says one Tade ships, because its bytes are not anybody’s to edit', () => {
    const shipped = workflowRow(workflow({ builtIn: true }), BUDGET)
    expect(workflowSays(shipped)).toContain('one Tade ships')
  })
})

describe('the whole projection, as the page would be handed it', () => {
  it('carries every one of the four collections with its own count', () => {
    const made = projector(input({ reach: reach() }), NOW).snapshot()
    expect(made.pages.intake.total).toBe(1)
    expect(made.pages.sources.total).toBe(2)
    expect(made.pages.runs.total).toBe(1)
    expect(made.pages.workflows.total).toBe(1)
  })
})

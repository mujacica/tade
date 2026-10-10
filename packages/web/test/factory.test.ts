import { MATERIAL_LABEL } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { intakeRow, rollup, runRow, sourceRow, workflowRow } from '../src/factory.ts'
import { OUTSIDE, outside } from '../src/fields.ts'
import { BUDGET } from '../src/page.ts'
import {
  IntakeRowSchema,
  RunRowSchema,
  SourceRowSchema,
  WorkflowRowSchema,
} from '../src/protocol-factory.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { EVERY, input, intake, reach, run, OUTSIDE as SAID, source, workflow } from './fixtures.ts'

// The factory floor, narrowed to what one device may read.
//
// Three questions, asked of every collection:
//
// 1. **With no grant, is a stranger's word absent rather than shortened?** The
//    whole point of `requests` and `material` being two grants of their own is
//    that a phone can be told *four requests are waiting, two of them for you*
//    without one word anybody outside this machine wrote.
// 2. **With a grant, is it carried as it was written?** A request that was
//    quietly reworded is as wrong as one that leaked: what an agent was handed
//    and what a person reads have to be the same text.
// 3. **Is *which nothing* said?** Not granted, nothing written down, and not
//    on this frame are three different facts about one empty region.

const NOW = Date.parse('2026-10-09T14:30:00.000Z')

describe('one request, as a device with no grant reads it', () => {
  const row = intakeRow(intake(), reach(), BUDGET)

  it('parses against the schema, which is the third leg of the guarantee', () => {
    expect(IntakeRowSchema.parse(row)).toEqual(row)
  })

  it('carries the state, the sentence and the counts', () => {
    // Everything a badge and a row need, with nothing of the request in it.
    expect(row.state).toBe('proposed')
    expect(row.because).toContain('waiting for a person to approve')
    expect(row.tries).toBe(3)
    expect(row.work).toHaveLength(1)
  })

  it('carries not one word a stranger wrote, and says which nothing each is', () => {
    expect(row.title).toBeNull()
    expect(row.who).toBeNull()
    expect(row.url).toBeNull()
    expect(row.material).toBeNull()
    expect(row.materialLabel).toBeNull()
    // The one that matters: *not granted* and *nothing written down* are
    // different facts, and this is the first.
    expect(row.materialSays).toContain('was not granted the words of a request')
  })

  it('has no string anywhere holding what the request said', () => {
    // Asked of the whole row flattened, rather than of the fields somebody
    // remembered: a field added next month that carried the title would fail
    // here.
    expect(JSON.stringify(row)).not.toContain(SAID.title)
    expect(JSON.stringify(row)).not.toContain(SAID.who)
    expect(JSON.stringify(row)).not.toContain('export-Qp3vNn1bXg7')
  })
})

describe('one request, as a device that was granted it reads it', () => {
  const row = intakeRow(intake(), reach(EVERY), BUDGET)

  it('carries the title and the handle as they were written', () => {
    expect(row.title?.words).toBe(SAID.title)
    expect(row.who?.words).toBe(SAID.who)
  })

  it('carries the body verbatim, path and all, under the heading that came with it', () => {
    // **Not scrubbed**, and the path in it is deliberate: a stranger may type
    // whatever they like, and the rule for a request is the rule for a note —
    // never reworded — because what an agent was handed and what a person
    // reads have to be the same text.
    expect(row.material?.words).toBe(SAID.said)
    expect(row.material?.words).toContain('/srv/logs/zt9/export-Qp3vNn1bXg7.log')
    // The heading is the domain's one wording and not the page's to choose.
    expect(row.materialLabel).toBe(MATERIAL_LABEL)
    expect(row.materialSays).toBeNull()
  })

  it('cuts a long body to the longer budget and says there is more', () => {
    const long = 'x'.repeat(BUDGET.material + 10)
    const row = intakeRow(intake({ material: long }), reach(EVERY), BUDGET)
    expect(row.material?.words).toHaveLength(BUDGET.material)
    // `more` and never an ellipsis written into somebody's words.
    expect(row.material?.more).toBe(true)
  })

  it('says a body Tade never wrote down, rather than drawing an empty request', () => {
    const row = intakeRow(
      intake({ material: '', materialProblem: 'nothing was made for it' }),
      reach(EVERY),
      BUDGET,
    )
    expect(row.material).toBeNull()
    expect(row.materialSays).toBe('nothing was made for it')
    expect(row.materialLabel).toBeNull()
  })

  it('refuses a url that is not https, parsed rather than pattern-matched', () => {
    for (const url of ['javascript:alert(1)', 'http://x.invalid/1', 'not a url', '']) {
      expect(intakeRow(intake({ url }), reach(EVERY), BUDGET).url, url).toBeNull()
    }
    expect(intakeRow(intake({ url: 'https://x.invalid/1' }), reach(EVERY), BUDGET).url).toBe(
      'https://x.invalid/1',
    )
  })

  it('elides a machine path out of a reply that could not go', () => {
    // The one string on this row this package did not write: a connector's own
    // sentence about somebody else's service. The claim *the away view adds no
    // path of its own* is kept at the boundary that makes it.
    const row = intakeRow(intake(), reach(EVERY), BUDGET)
    expect(row.unsent[0]?.problem).not.toContain('/Users/testperson')
    expect(row.unsent[0]?.problem).toContain('…')
  })
})

describe('a request that has moved since the work was made', () => {
  it('says so as a flag, not only as two opaque ids', () => {
    // The one thing on this row a person acts on immediately, and comparing
    // two hashes is not something to ask of a reader on a phone.
    expect(intakeRow(intake(), reach(), BUDGET).moved).toBe(true)
  })

  it('is not moved where the two revisions are the same, or where none was taken', () => {
    const same = intake({ taken: '2026-10-08T11:00:00.000Z' })
    expect(intakeRow(same, reach(), BUDGET).moved).toBe(false)
    expect(intakeRow(intake({ taken: '' }), reach(), BUDGET).moved).toBe(false)
  })
})

describe('what approving one request would start', () => {
  it('carries the rows and the grant, and holds the money behind the money grant', () => {
    const granted = intakeRow(intake(), reach(EVERY), BUDGET)
    expect(granted.would?.starts[0]?.task).toBe('sentry/github-1402')
    expect(granted.would?.grant[0]).toContain('still allows it')
    expect(granted.would?.limits[0]).toContain('$1.25')
    // Without `spend`, the figures are not drawn as nought — they are not
    // there, and the page says the limits are not this device's to see.
    const bare = intakeRow(intake(), reach(['requests']), BUDGET)
    expect(bare.would?.grant).toHaveLength(1)
    expect(bare.would?.limits).toEqual([])
  })

  it('holds the reason beside a wait behind the grant that reason rides on', () => {
    // Somebody's own words about why one step waits for another. The same
    // grant the queue's `waitsOn` reason rides on, so there is one answer to
    // one question rather than two rules for one sentence.
    const granted = intakeRow(intake(), reach(EVERY), BUDGET)
    expect(granted.would?.starts[0]?.after[0]?.why?.words).toContain('failing test')
  })

  it('is null where nothing worked one out, which is not *nothing would happen*', () => {
    expect(intakeRow(intake({ would: null }), reach(EVERY), BUDGET).would).toBeNull()
  })
})

describe('one door', () => {
  it('parses, and carries the state, the kind of trouble and when it is over', () => {
    const row = sourceRow(source(), reach())
    expect(SourceRowSchema.parse(row)).toEqual(row)
    expect(row.state).toBe('rate-limited')
    expect(row.trouble).toBe('rate-limited')
    expect(row.until).toBe('2026-10-08T15:00:00.000Z')
  })

  it('narrows its project list to the ones this device may read, and counts the rest', () => {
    // A grant lists project names, and a device granted one project of two
    // must not learn the other's name from a door's row.
    const row = sourceRow(source(), reach([], ['sentry']))
    expect(row.projects).toEqual(['sentry'])
    expect(row.projectsElsewhere).toBe(1)
    expect(JSON.stringify(row)).not.toContain('tade')
  })

  it('says a watch with no schedule as two facts rather than one', () => {
    const row = sourceRow(source({ watch: 'intake.cli', schedule: '', every: '5m' }), reach())
    expect(row.watch).toBe('intake.cli')
    expect(row.schedule).toBeNull()
  })

  it('carries a count of the handles and never the handles', () => {
    expect(sourceRow(source(), reach()).allowed).toBe(2)
  })
})

describe('one run', () => {
  it('parses, and carries the layers, the waits and the retries', () => {
    const row = runRow(run(), reach(EVERY), BUDGET)
    expect(RunRowSchema.parse(row)).toEqual(row)
    expect(row.layers).toBe(2)
    expect(row.steps[1]?.waits[0]?.task).toBe('sentry/github-1402-reproduce')
    // Two agents on one step is the retry history, and there is no counter
    // behind it: it is how many starts the journal still holds.
    expect(row.steps[0]?.runs).toBe(2)
    expect(row.retries).toBe(1)
  })

  it('says partial completion as a fraction of the steps this device can see', () => {
    expect(row(EVERY).finished).toBe(1)
    expect(row(EVERY).total).toBe(2)
  })

  it('holds the reason beside a wait behind the grant it rides on', () => {
    // Somebody's own words about why one step waits for another: the same
    // grant the queue's own `waitsOn` reason rides on, so there is one answer
    // to one question rather than two rules for one sentence.
    expect(row(EVERY).steps[1]?.waits[0]?.why?.words).toContain('failing test first')
    expect(row([]).steps[1]?.waits[0]?.why).toBeNull()
  })

  it('holds money behind the money grant, and nought is not null', () => {
    expect(row(EVERY).usd).toBeCloseTo(1.25)
    expect(row(EVERY).steps[1]?.usd).toBe(0)
    expect(row([]).usd).toBeNull()
    expect(row([]).steps[0]?.usd).toBeNull()
  })

  it('leaves out a step in a project this device may not read', () => {
    const narrow = runRow(run(), reach(EVERY, ['tade']), BUDGET)
    expect(narrow.steps).toEqual([])
    expect(narrow.total).toBe(0)
    expect(narrow.projects).toEqual([])
  })

  const row = (granted: readonly string[]) => runRow(run(), reach(granted as never), BUDGET)
})

describe('a run’s checks, as one answer', () => {
  it('is red where any step failed', () => {
    expect(rollup([{ checks: 'pass' }, { checks: 'fail' }, { checks: 'unknown' }])).toBe('fail')
  })

  it('is unknown where nothing has looked at one of them, and never a pass', () => {
    // The mistake this rollup exists to prevent: three of four green and
    // nothing having looked at the fourth, drawn green.
    expect(rollup([{ checks: 'pass' }, { checks: 'unknown' }])).toBe('unknown')
  })

  it('is green only where every one of them passed', () => {
    expect(rollup([{ checks: 'pass' }, { checks: 'pass' }])).toBe('pass')
  })

  it('is unknown for a run with no steps, because nothing said anything', () => {
    expect(rollup([])).toBe('unknown')
  })
})

describe('one workflow', () => {
  it('parses, and carries the versions, the draft and the shape', () => {
    const row = workflowRow(workflow(), reach(EVERY), BUDGET)
    expect(WorkflowRowSchema.parse(row)).toEqual(row)
    expect(row.versions).toEqual([3, 2, 1])
    expect(row.published).toBe(3)
    expect(row.draft).toBe(4)
    expect(row.shows).toBe('draft')
    expect(row.places[1]?.parent).toBe('reproduce')
  })

  it('carries the steps, the prompts and the form only where granted', () => {
    const bare = workflowRow(workflow(), reach(), BUDGET)
    // Names, versions and counts, which still answer *is this published, and
    // what is running on it*.
    expect(bare.name).toBe('reproduce-and-fix')
    expect(bare.versions).toEqual([3, 2, 1])
    expect(bare.runs).toBe(2)
    // And nothing the owner wrote: a list of step names with the prompts
    // withheld is a designer nobody can design with, so the whole of the
    // content is behind one grant.
    expect(bare.steps).toEqual([])
    expect(bare.fields).toEqual([])
    expect(bare.inputs).toEqual([])
    expect(bare.title).toBeNull()
    expect(JSON.stringify(bare)).not.toContain('failing test')
  })

  it('carries what publishing would refuse whether or not the content is granted', () => {
    // Metadata: *this draft will not publish* is a name-and-count fact about a
    // workflow, and it is the one a person acts on.
    const bare = workflowRow(workflow({ problems: ['no title'] }), reach(), BUDGET)
    expect(bare.problems).toEqual(['no title'])
    expect(bare.warnings).toHaveLength(1)
  })

  it('holds a step’s prompt to the longer budget, like a request’s body', () => {
    const long = 'y'.repeat(BUDGET.material + 10)
    const one = workflow()
    const row = workflowRow(
      workflow({ steps: [{ ...one.steps[0]!, prompt: long }] }),
      reach(EVERY),
      BUDGET,
    )
    expect(row.steps[0]?.prompt?.words).toHaveLength(BUDGET.material)
    expect(row.steps[0]?.prompt?.more).toBe(true)
  })
})

describe('what the whole projection says about outside text', () => {
  it('produces every path the outside list names, and no others', () => {
    // Both directions, like `AUTHORED`: a path here the projection never
    // produces is a line that outlived its field, and one it produces that is
    // not here is a stranger's words with no grant behind them.
    const whole = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    const found = new Set(pathsIn(whole))
    for (const at of OUTSIDE) expect([...found], at).toContain(at)
    expect([...found].filter((at) => outside(at)).sort()).toEqual([...OUTSIDE].sort())
  })

  it('has none of them at all with neither grant, rather than empty ones', () => {
    const whole = snapshotOf(input({ reach: reach(['titles', 'intent', 'spend']) }), NOW)
    for (const at of pathsIn(whole)) expect(outside(at), at).toBe(false)
  })
})

/** Every string's path in a value, with indices flattened. `fields.ts`' rule. */
function pathsIn(value: unknown, at = ''): string[] {
  if (typeof value === 'string') return [at]
  if (Array.isArray(value)) return value.flatMap((one) => pathsIn(one, `${at}[]`))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, one]) =>
    pathsIn(one, at === '' ? key : `${at}.${key}`),
  )
}

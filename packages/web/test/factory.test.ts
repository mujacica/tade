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
import { input, intake, reach, run, OUTSIDE as SAID, source, workflow } from './fixtures.ts'

// The factory floor, as a paired device reads it.
//
// Two questions, asked of every collection:
//
// 1. **Is it carried as it was written?** A request that was quietly reworded
//    is as wrong as one that leaked: what an agent was handed and what a
//    person reads have to be the same text.
// 2. **Is *which nothing* said?** Nothing written down and not on this frame
//    are different facts about one empty region.

const NOW = Date.parse('2026-10-09T14:30:00.000Z')

describe('one request, as a device reads it', () => {
  const row = intakeRow(intake(), BUDGET)

  it('parses against the schema, which is the third leg of the guarantee', () => {
    expect(IntakeRowSchema.parse(row)).toEqual(row)
  })

  it('carries the state, the sentence and the counts', () => {
    expect(row.state).toBe('proposed')
    expect(row.because).toContain('waiting for a person to approve')
    expect(row.tries).toBe(3)
    expect(row.work).toHaveLength(1)
  })

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

  it('sends a long body whole, framed as material', () => {
    const long = `${'x'.repeat(12_000)}\nthe last line`
    const row = intakeRow(intake({ material: long }), BUDGET)
    expect(row.material).toEqual({ words: long, more: false })
    expect(row.materialLabel).toBe(MATERIAL_LABEL)
  })

  it('says a body Tade never wrote down, rather than drawing an empty request', () => {
    const row = intakeRow(
      intake({ material: '', materialProblem: 'nothing was made for it' }),
      BUDGET,
    )
    expect(row.material).toBeNull()
    expect(row.materialSays).toBe('nothing was made for it')
    expect(row.materialLabel).toBeNull()
  })

  it('says a long reason there is no body whole, with its paths taken out', () => {
    // An error the window caught reading a context file: the whole sentence
    // goes out, and the path in it is this machine's, not the request's.
    const tail = ' and the rest of what went wrong, word for word'.repeat(20)
    const problem = `the request could not be read: Error: EACCES: permission denied, open '/Users/testperson/.tade/projects/sentry/tasks/one/context.md'${tail}`
    const row = intakeRow(intake({ material: '', materialProblem: problem }), BUDGET)
    expect(row.materialSays).not.toContain('/Users/testperson')
    expect(row.materialSays).toContain("open '…'")
    expect(row.materialSays?.endsWith(tail)).toBe(true)
  })

  it('refuses a url that is not https, parsed rather than pattern-matched', () => {
    for (const url of ['javascript:alert(1)', 'http://x.invalid/1', 'not a url', '']) {
      expect(intakeRow(intake({ url }), BUDGET).url, url).toBeNull()
    }
    expect(intakeRow(intake({ url: 'https://x.invalid/1' }), BUDGET).url).toBe(
      'https://x.invalid/1',
    )
  })

  it('elides a machine path out of a reply that could not go', () => {
    // The one string on this row this package did not write: a connector's own
    // sentence about somebody else's service. The claim *the away view adds no
    // path of its own* is kept at the boundary that makes it.
    const row = intakeRow(intake(), BUDGET)
    expect(row.unsent[0]?.problem).not.toContain('/Users/testperson')
    expect(row.unsent[0]?.problem).toContain('…')
  })
})

describe('a request that has moved since the work was made', () => {
  it('says so as a flag, not only as two opaque ids', () => {
    // The one thing on this row a person acts on immediately, and comparing
    // two hashes is not something to ask of a reader on a phone.
    expect(intakeRow(intake(), BUDGET).moved).toBe(true)
  })

  it('is not moved where the two revisions are the same, or where none was taken', () => {
    const same = intake({ taken: '2026-10-08T11:00:00.000Z' })
    expect(intakeRow(same, BUDGET).moved).toBe(false)
    expect(intakeRow(intake({ taken: '' }), BUDGET).moved).toBe(false)
  })
})

describe('what approving one request would start', () => {
  it('carries the rows, the grant that allows it and the money', () => {
    const would = intakeRow(intake(), BUDGET).would
    expect(would?.starts[0]?.task).toBe('sentry/github-1402')
    expect(would?.grant[0]).toContain('still allows it')
    expect(would?.limits[0]).toContain('$1.25')
  })

  it('carries the reason beside a wait as it was written', () => {
    const would = intakeRow(intake(), BUDGET).would
    expect(would?.starts[0]?.after[0]?.why?.words).toContain('failing test')
  })

  it('says why it could not be worked out whole, with its paths taken out', () => {
    const tail = ' then everything after it, every word'.repeat(20)
    const problem = `what approving it would start could not be worked out: Error: ENOENT: no such file or directory, open '/Users/testperson/.tade/projects/sentry/tasks/one/task.yaml'${tail}`
    const base = intake()
    const would = { ...(base.would as NonNullable<typeof base.would>), problems: [problem] }
    const row = intakeRow(intake({ would }), BUDGET)
    expect(row.would?.problems[0]).not.toContain('/Users/testperson')
    expect(row.would?.problems[0]?.endsWith(tail)).toBe(true)
  })

  it('is null where nothing worked one out, which is not *nothing would happen*', () => {
    expect(intakeRow(intake({ would: null }), BUDGET).would).toBeNull()
  })
})

describe('one door', () => {
  it('parses, and carries the state, the kind of trouble and when it is over', () => {
    const row = sourceRow(source())
    expect(SourceRowSchema.parse(row)).toEqual(row)
    expect(row.state).toBe('rate-limited')
    expect(row.trouble).toBe('rate-limited')
    expect(row.until).toBe('2026-10-08T15:00:00.000Z')
  })

  it('carries every project it works for', () => {
    const row = sourceRow(source())
    expect(row.projects).toEqual(['sentry', 'tade'])
    expect(row.projectsElsewhere).toBe(0)
  })

  it('says a watch with no schedule as two facts rather than one', () => {
    const row = sourceRow(source({ watch: 'intake.cli', schedule: '', every: '5m' }))
    expect(row.watch).toBe('intake.cli')
    expect(row.schedule).toBeNull()
  })

  it('carries a count of the handles and never the handles', () => {
    expect(sourceRow(source()).allowed).toBe(2)
  })
})

describe('one run', () => {
  it('parses, and carries the layers, the waits and the retries', () => {
    const row = runRow(run(), BUDGET)
    expect(RunRowSchema.parse(row)).toEqual(row)
    expect(row.layers).toBe(2)
    expect(row.steps[1]?.waits[0]?.task).toBe('sentry/github-1402-reproduce')
    // Two agents on one step is the retry history, and there is no counter
    // behind it: it is how many starts the journal still holds.
    expect(row.steps[0]?.runs).toBe(2)
    expect(row.retries).toBe(1)
  })

  it('says partial completion as a fraction of its steps', () => {
    expect(row().finished).toBe(1)
    expect(row().total).toBe(2)
  })

  it('carries the reason beside a wait as it was written', () => {
    expect(row().steps[1]?.waits[0]?.why?.words).toContain('failing test first')
  })

  it('carries the money, and a step that reported none is nought', () => {
    expect(row().usd).toBeCloseTo(1.25)
    expect(row().steps[1]?.usd).toBe(0)
  })

  const row = () => runRow(run(), BUDGET)
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
    const row = workflowRow(workflow(), BUDGET)
    expect(WorkflowRowSchema.parse(row)).toEqual(row)
    expect(row.versions).toEqual([3, 2, 1])
    expect(row.published).toBe(3)
    expect(row.draft).toBe(4)
    expect(row.shows).toBe('draft')
    expect(row.places[1]?.parent).toBe('reproduce')
  })

  it('carries the steps, the prompts and the form', () => {
    const row = workflowRow(workflow(), BUDGET)
    expect(row.name).toBe('reproduce-and-fix')
    expect(row.runs).toBe(2)
    expect(row.steps.length).toBeGreaterThan(0)
    expect(row.title).not.toBeNull()
    expect(JSON.stringify(row)).toContain('failing test')
  })

  it('carries what publishing would refuse', () => {
    const bare = workflowRow(workflow({ problems: ['no title'] }), BUDGET)
    expect(bare.problems).toEqual(['no title'])
    expect(bare.warnings).toHaveLength(1)
  })

  it('sends a step’s prompt whole, like a request’s body', () => {
    const long = `${'y'.repeat(12_000)}\nthe last line`
    const one = workflow()
    const row = workflowRow(workflow({ steps: [{ ...one.steps[0]!, prompt: long }] }), BUDGET)
    expect(row.steps[0]?.prompt).toEqual({ words: long, more: false })
  })
})

describe('what the whole projection says about outside text', () => {
  it('produces every path the outside list names, and no others', () => {
    // Both directions, like `AUTHORED`: a path here the projection never
    // produces is a line that outlived its field, and one it produces that is
    // not here is a stranger's words nobody listed.
    const whole = snapshotOf(input({ reach: reach() }), NOW)
    const found = new Set(pathsIn(whole))
    for (const at of OUTSIDE) expect([...found], at).toContain(at)
    expect([...found].filter((at) => outside(at)).sort()).toEqual([...OUTSIDE].sort())
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

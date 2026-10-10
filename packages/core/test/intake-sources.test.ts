import { describe, expect, it } from 'vitest'
import type { IntakeGrantRead } from '../src/intake.ts'
import {
  nothingHandedSays,
  SOURCE_NEEDS_YOU,
  SOURCE_STATES,
  type SourceStanding,
  type SourceWatch,
  sourceStandingOf,
  sourcesStanding,
} from '../src/intake-sources.ts'
import type { LookTrouble, WatchLook } from '../src/watch-looks.ts'

// The nine states, and the four an empty inbox would otherwise be silent about.
//
// The question this file is really asking is one question asked nine ways:
// **when there is nothing in the inbox, does the answer say why?** Four of the
// nine are somebody at the machine's to fix and one of those clears on its own
// at a moment the source itself named, so a surface with one word for them
// says *nothing yet* while a connector has been answering `429` since Tuesday.

const grant = (over: Partial<IntakeGrantRead> = {}): IntakeGrantRead => ({
  path: 'surfaces.intake.sources.github',
  on: true,
  accept: true,
  reply: false,
  names: false,
  projects: ['sentry'],
  from: ['octocat'],
  mode: 'propose',
  template: '',
  document: '',
  ...over,
})

const look = (over: Partial<WatchLook> = {}): WatchLook => ({
  at: Date.parse('2026-10-09T10:00:00Z'),
  found: 0,
  fresh: 0,
  left: 0,
  problem: null,
  trouble: null,
  until: null,
  said: null,
  ...over,
})

const watch = (looks: WatchLook[] = [], over: Partial<SourceWatch> = {}): SourceWatch => ({
  id: 'intake.github',
  schedule: 'github-issues',
  every: '10m',
  paused: false,
  watched: { since: null, seen: new Set(['github:1:a']), looks, findings: [] },
  ...over,
})

const standing = (over: {
  grant?: Partial<IntakeGrantRead>
  watch?: SourceWatch | null
}): SourceStanding =>
  sourceStandingOf({
    source: 'github',
    grant: grant(over.grant),
    watch: over.watch === undefined ? watch() : over.watch,
  })

describe('where one door stands', () => {
  it('is off before it is anything else, and says what that means', () => {
    // The surface's own switch is read first: a source whose grant accepts and
    // whose watch is looking says nothing at all while intake is off, so
    // reading the grant first would draw a door that is shut as *found
    // nothing*.
    const row = standing({ grant: { on: false } })
    expect(row.state).toBe('off')
    expect(row.because).toContain('work from outside this machine is off')
  })

  it('is ungranted where the surface is on and the source is not', () => {
    const row = standing({ grant: { accept: false } })
    expect(row.state).toBe('ungranted')
    // The key to go and change, so the sentence is actionable rather than a
    // statement about a boolean.
    expect(row.because).toContain('surfaces.intake.sources.github.accept is off')
  })

  it('is ungranted where it accepts and there is nowhere for the work to go', () => {
    // An allowlist of no projects is the default, and it reads as *on* to
    // anybody looking at `accept` alone. It is the commonest half-finished
    // grant there is.
    const row = standing({ grant: { projects: [] } })
    expect(row.state).toBe('ungranted')
    expect(row.because).toContain('lists no project')
  })

  it('is unwatched where it is granted and nothing looks with it', () => {
    const row = standing({ watch: null })
    expect(row.state).toBe('unwatched')
    expect(row.because).toContain('nothing looks with it')
    expect(row.watch).toBe('')
    expect(row.every).toBe('')
  })

  it('is unwatched where a watch exists and no schedule runs it', () => {
    // The watch is offered by an extension and nobody turned it on: `every` is
    // the watch's own default, and there is still nothing looking.
    const row = standing({ watch: watch([], { schedule: '', watched: null }) })
    expect(row.state).toBe('unwatched')
    // The watch is named and the schedule is not, which is the honest pair:
    // something *could* look with it, and nothing does.
    expect(row.watch).toBe('intake.github')
    expect(row.schedule).toBe('')
    expect(row.every).toBe('10m')
  })

  it('is paused where somebody paused the schedule that looks', () => {
    const row = standing({ watch: watch([], { paused: true }) })
    expect(row.state).toBe('paused')
    expect(row.because).toContain('is paused')
  })

  it('is unlooked before the first look, and says when the next one is', () => {
    // The day somebody turns a connector on. Drawn as trouble it would send
    // them looking for a bug that is five minutes of waiting.
    const row = standing({ watch: watch([]) })
    expect(row.state).toBe('unlooked')
    expect(row.because).toContain('at most 10m')
    expect(row.lookedAt).toBeNull()
  })

  it('tells a look that found nothing from a look that could not happen', () => {
    const quiet = standing({ watch: watch([look({ said: 'no issue carries the label' })]) })
    expect(quiet.state).toBe('quiet')
    expect(quiet.because).toContain('no issue carries the label')
    const bare = standing({ watch: watch([look()]) })
    expect(bare.state).toBe('quiet')
    expect(bare.because).toContain('nothing addressed to Tade')
  })

  it('says what a working look found, and how much waits for the next one', () => {
    const row = standing({ watch: watch([look({ found: 3, fresh: 2, left: 1 })]) })
    expect(row.state).toBe('found')
    expect(row.because).toContain('found 3, 2 new, 1 waiting')
    expect(row.found).toBe(3)
    expect(row.left).toBe(1)
  })

  it('says nothing new as words rather than as a nought', () => {
    const row = standing({ watch: watch([look({ found: 3, fresh: 0 })]) })
    expect(row.because).toContain('nothing new')
  })
})

describe('the four an empty inbox would otherwise be silent about', () => {
  const troubled = (trouble: LookTrouble | null, over: Partial<WatchLook> = {}) =>
    standing({
      watch: watch([look({ problem: 'github said no', trouble, ...over })]),
    })

  it('tells unreachable, rate limited and refused apart, by the recorded kind', () => {
    expect(troubled('unreachable').state).toBe('unreachable')
    expect(troubled('rate-limited').state).toBe('rate-limited')
    expect(troubled('refused').state).toBe('trouble')
    expect(troubled('other').state).toBe('trouble')
  })

  it('carries the sentence the source gave, beside the kind', () => {
    const row = troubled('unreachable')
    expect(row.because).toContain('nothing came back from it at all')
    expect(row.because).toContain('github said no')
  })

  it('says when a spent budget is over, where the source said', () => {
    const at = Date.parse('2026-10-09T11:00:00Z')
    const row = troubled('rate-limited', { until: at })
    expect(row.until).toBe(at)
    expect(row.because).toContain('it said when that is over')
  })

  it('says nothing about when where the source did not say', () => {
    const row = troubled('rate-limited')
    expect(row.until).toBeNull()
    expect(row.because).not.toContain('when that is over')
  })

  it('reads a look written down before the kind existed as unknown, not as other', () => {
    // `trouble: null` beside a problem is an older journal line. It is still
    // trouble — the state says so — and the *kind* is the thing nobody
    // recorded, so the sentence does not invent one.
    const row = troubled(null)
    expect(row.state).toBe('trouble')
    expect(row.trouble).toBeNull()
    expect(row.because).toContain('it could not be looked at')
  })

  it('keeps what the last look that **worked** found, beside the trouble', () => {
    // The two are different facts and a surface needs both: *three were found
    // an hour ago and nothing has worked since* is the shape of a connector
    // that has just broken, and one field could only say one of them.
    const row = standing({
      watch: watch([
        look({ at: 20, problem: 'github said no', trouble: 'refused' }),
        look({ at: 10, found: 3, fresh: 3 }),
      ]),
    })
    expect(row.state).toBe('trouble')
    expect(row.lookedAt).toBe(20)
    expect(row.workedAt).toBe(10)
    expect(row.found).toBe(3)
  })

  it('names the two somebody has to fix rather than wait out', () => {
    // A rate limit clears on its own and a pause is a decision; an outage and
    // a refusal are the two that stay until a person does something.
    expect([...SOURCE_NEEDS_YOU]).toEqual(['trouble', 'unreachable'])
    for (const state of SOURCE_NEEDS_YOU) expect(SOURCE_STATES).toContain(state)
  })
})

describe('what one door carries beside its state', () => {
  it('carries the grant as a path, the mode, the template and the counts', () => {
    const row = standing({
      grant: { reply: true, names: true, template: 'reproduce-and-fix', from: ['a', 'b'] },
      watch: watch([look({ found: 1, fresh: 1 })]),
    })
    expect(row.grant).toBe('surfaces.intake.sources.github')
    expect(row.reply).toBe(true)
    expect(row.names).toBe(true)
    expect(row.mode).toBe('propose')
    expect(row.template).toBe('reproduce-and-fix')
    // A **count** of handles and never the handles: who asked is one request's
    // own record, and a door's row is about the door.
    expect(row.allowed).toBe(2)
    expect(row.handed).toBe(1)
  })

  it('carries no word anybody outside this machine wrote', () => {
    // The whole row, flattened: every string is the config's, the watch's id,
    // or a sentence Tade composed. A ticket's title is the inbox's.
    const row = standing({ watch: watch([look({ said: 'no issue carries the label' })]) })
    const strings = Object.values(row).filter((one): one is string => typeof one === 'string')
    for (const said of strings) expect(said).not.toContain('Export button')
  })
})

describe('every door there is, and what an empty inbox means', () => {
  it('answers about every source in the order they are declared', () => {
    // Declared order and not sorted by state: a list that reorders itself when
    // a connector has a bad minute is a list somebody re-reads every time.
    const rows = sourcesStanding(['cli', 'github', 'slack'], (source) => ({
      grant: grant({ path: `surfaces.intake.sources.${source}` }),
      watch: source === 'github' ? watch([look({ found: 2, fresh: 1 })]) : null,
    }))
    expect(rows.map((one) => one.source)).toEqual(['cli', 'github', 'slack'])
    expect(rows.map((one) => one.state)).toEqual(['unwatched', 'found', 'unwatched'])
  })

  it('says the trouble first, because that is the one somebody can act on', () => {
    const rows = sourcesStanding(['cli', 'github'], (source) => ({
      grant: grant({ path: `surfaces.intake.sources.${source}` }),
      watch:
        source === 'github'
          ? watch([look({ problem: 'github said no', trouble: 'unreachable' })])
          : watch([look()]),
    }))
    expect(nothingHandedSays(rows)).toContain('nothing came back from it at all')
  })

  it('says how many doors are working where they disagree about why', () => {
    // Where every door says the same thing, that sentence is the answer and is
    // sharper than a count. Where they do not, the count is what is true of
    // all of them: *they are being looked with and nothing has arrived*.
    const rows = sourcesStanding(['cli', 'github'], (source) => ({
      grant: grant({ path: `surfaces.intake.sources.${source}` }),
      watch: source === 'cli' ? watch([look()]) : watch([look({ found: 2, fresh: 1 })]),
    }))
    expect(nothingHandedSays(rows)).toContain('2 sources are being looked with')
  })

  it('says the one sentence they share where every door is quiet', () => {
    const rows = sourcesStanding(['cli', 'github'], (source) => ({
      grant: grant({ path: `surfaces.intake.sources.${source}` }),
      watch: watch([look()]),
    }))
    expect(nothingHandedSays(rows)).toContain('nothing addressed to Tade')
  })

  it('says the one sentence where every door agrees about why', () => {
    const rows = sourcesStanding(['cli', 'github'], (source) => ({
      grant: grant({ path: `surfaces.intake.sources.${source}`, on: false }),
      watch: null,
    }))
    expect(nothingHandedSays(rows)).toContain('work from outside this machine is off')
  })

  it('says the first door that is not off where the rest are', () => {
    const rows = sourcesStanding(['cli', 'github'], (source) => ({
      grant: grant({ path: `surfaces.intake.sources.${source}`, on: source === 'github' }),
      watch: null,
    }))
    expect(nothingHandedSays(rows)).toContain('nothing looks with it')
  })

  it('says so where no source is implemented at all', () => {
    expect(nothingHandedSays([])).toBe('no source is implemented here')
  })
})

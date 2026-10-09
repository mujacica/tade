import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import type { IntakeGrantRead } from '../src/intake.ts'
import type { InboxRow, InboxWork } from '../src/intake-inbox.ts'
import { inboxRowOf } from '../src/intake-inbox.ts'
import { type IntakeItem, intakeFrom } from '../src/intake-journal.ts'
import {
  INTAKE_REPLY_ATTEMPTS,
  INTAKE_REPLY_CAP,
  INTAKE_REPLY_RETRY_MS,
  INTAKE_SAYINGS,
  type IntakeSaying,
  intakeMark,
  intakeSays,
  outboxFor,
  outboxOf,
  sayingFor,
} from '../src/intake-outbox.ts'

// What may be said back, and which one status is due now.
//
// The whole of it is arithmetic over the journal, so every test here is facts
// in and a decision out: no clock, no files, nothing posted. What a transport
// does with a decision is `extensions/intake`'s and `app`'s to test.

const AT = Date.parse('2026-10-09T00:00:00.000Z')

const event = (
  type: TadeEvent['type'],
  detail: Record<string, unknown>,
  over: Partial<TadeEvent> = {},
): TadeEvent => ({
  seq: 1,
  ts: new Date(AT).toISOString(),
  type,
  urgency: 'notable',
  task: null,
  lane: null,
  run: null,
  detail,
  ...over,
})

const where = { item: 'cli:req-1', source: 'cli', external_id: 'req-1' }

/** The journal of one request that was accepted and made one task. */
const accepted = (lines: readonly TadeEvent[] = []): Map<string, IntakeItem> =>
  intakeFrom([
    event('intake_received', { ...where, revision: '1', project: 'app', requester: 'kim' }),
    event(
      'intake_accepted',
      { ...where, revision: '1', mode: 'queue', grant: 'surfaces.intake.sources.cli' },
      { task: 'app/cli-req-1' },
    ),
    ...lines,
  ])

/** One status, as the journal records one that went or one that did not. */
const said = (
  saying: IntakeSaying,
  over: { state?: 'said' | 'unsent'; problem?: string; at?: number } = {},
): TadeEvent =>
  event(
    'intake_replied',
    {
      ...where,
      saying,
      state: over.state ?? 'said',
      ...(over.problem ? { problem: over.problem } : {}),
    },
    { ts: new Date(over.at ?? AT).toISOString() },
  )

const work = (over: Partial<InboxWork> = {}): InboxWork => ({
  task: 'app/cli-req-1',
  parked: false,
  started: false,
  finished: false,
  held: null,
  state: null,
  ...over,
})

const grant = (over: Partial<IntakeGrantRead> = {}): IntakeGrantRead => ({
  path: 'surfaces.intake.sources.cli',
  on: true,
  accept: true,
  reply: true,
  names: false,
  projects: ['app'],
  from: ['kim'],
  mode: 'queue',
  template: '',
  document: '',
  ...over,
})

const row = (items: Map<string, IntakeItem>, tasks: readonly InboxWork[] = [work()]): InboxRow =>
  inboxRowOf(items.get('cli:req-1') as IntakeItem, tasks)

const due = (
  one: {
    items?: Map<string, IntakeItem>
    work?: readonly InboxWork[]
    grant?: Partial<IntakeGrantRead>
    now?: number
  } = {},
) => {
  const items = one.items ?? accepted()
  return outboxFor({
    row: row(items, one.work),
    item: items.get('cli:req-1'),
    grant: grant(one.grant),
    now: one.now ?? AT,
    machine: 'studio',
  })
}

describe('what a reply may ever say', () => {
  it('names nothing at all unless the owner granted naming', () => {
    // Enforcement by absence: with `names: false` neither the task nor the
    // machine is in the argument, so no sentence can carry one.
    for (const saying of INTAKE_SAYINGS) {
      const plain = intakeSays(saying, { names: false })
      expect(plain).not.toContain('app/')
      expect(plain).not.toContain('studio')
      // No link, no path, no file name, no newline: a status is one sentence.
      expect(plain).not.toMatch(/http|\/|\\|\n|`/)
      expect(plain.trim()).toBe(plain)
    }
  })

  it('keeps acknowledged, queued and running three different sentences', () => {
    // The one thing no copy may blur. Asserted of every pair rather than of
    // the three that were wrong once: a seventh saying added next year is
    // held to the same rule by the same test.
    const plain = INTAKE_SAYINGS.map((saying) => intakeSays(saying, { names: false }))
    expect(new Set(plain).size).toBe(INTAKE_SAYINGS.length)
    const named = INTAKE_SAYINGS.map((saying) =>
      intakeSays(saying, { names: true, task: 'app/cli-req-1', machine: 'studio' }),
    )
    expect(new Set(named).size).toBe(INTAKE_SAYINGS.length)
    expect(plain[2]).toBe('Queued.')
    expect(plain[3]).toBe('Being worked on.')
  })

  it('says the work and the machine where that is granted, and nothing else', () => {
    const named = intakeSays('accepted', { names: true, task: 'app/cli-req-1', machine: 'studio' })
    expect(named).toBe('Queued as app/cli-req-1 on studio.')
    // A machine that cannot say what it is called says the rest rather than
    // "on ": unknown is not drawn as an empty word.
    expect(intakeSays('accepted', { names: true, task: 'app/a', machine: '' })).toBe(
      'Queued as app/a.',
    )
    expect(intakeSays('accepted', { names: true, task: null, machine: '' })).toBe(
      'Queued as a task.',
    )
  })

  it('marks one status about one request, the same way every time', () => {
    // Derived, so a restart hands the transport the same marker: that is the
    // whole of reconciling a crash after a post.
    expect(intakeMark('cli:req-1', 'accepted')).toBe('tade:cli:req-1:accepted')
    expect(intakeMark('cli:req-1', 'accepted')).toBe(intakeMark('cli:req-1', 'accepted'))
    expect(intakeMark('cli:req-1', 'started')).not.toBe(intakeMark('cli:req-1', 'accepted'))
  })
})

describe('which status one request calls for', () => {
  it('reads it off where the work stands, and never off a refusal', () => {
    expect(sayingFor({ state: 'noticed', work: [] })).toEqual({ saying: 'noticed' })
    expect(sayingFor({ state: 'proposed', work: [work({ parked: true })] })).toEqual({
      saying: 'proposed',
    })
    expect(sayingFor({ state: 'accepted', work: [work()] })).toEqual({ saying: 'accepted' })
    expect(sayingFor({ state: 'started', work: [work({ started: true })] })).toEqual({
      saying: 'started',
    })
    expect(
      sayingFor({ state: 'started', work: [work({ started: true, state: 'review' })] }),
    ).toEqual({ saying: 'review' })
    expect(
      sayingFor({ state: 'started', work: [work({ started: true, finished: true })] }),
    ).toEqual({ saying: 'finished' })
    // Held and a giving-up are the same word: both are this machine owing
    // somebody an answer, and the requester did nothing wrong either way.
    expect(sayingFor({ state: 'held', work: [] })).toEqual({ saying: 'held' })
    expect(sayingFor({ state: 'failure', work: [] })).toEqual({ saying: 'held' })
  })

  it('says nothing back about a refusal, and says why not', () => {
    const answer = sayingFor({ state: 'refused', work: [] })
    expect(answer).toMatchObject({ nothing: expect.stringContaining('never replied to') })
  })

  it('does not call a request in review that nobody could ask the state of', () => {
    // `deriveState` needs probes, so outside a window the state is null — and
    // unknown is not "not in review", it is a status not said.
    expect(sayingFor({ state: 'started', work: [work({ started: true, state: null })] })).toEqual({
      saying: 'started',
    })
  })
})

describe('whether a status goes out now', () => {
  it('says nothing anywhere while the grant is off, naming the key', () => {
    expect(due({ grant: { reply: false } })).toEqual({
      outbox: 'nothing',
      because: 'surfaces.intake.sources.cli.reply is off: nothing is posted anywhere',
    })
    expect(due({ grant: { on: false } })).toMatchObject({
      because: expect.stringContaining('surfaces.intake.enabled is off'),
    })
  })

  it('offers the status the work calls for, with the sentence and the marker on it', () => {
    expect(due()).toEqual({
      outbox: 'due',
      entry: {
        item: 'cli:req-1',
        source: 'cli',
        externalId: 'req-1',
        saying: 'accepted',
        mark: 'tade:cli:req-1:accepted',
        say: 'Queued.',
        attempt: 1,
      },
    })
  })

  it('offers each status once, which is the whole of dedupe across restarts', () => {
    // Nothing is remembered between asks: the journal's own record is what
    // says it has gone, so a window reopened says nothing twice.
    const items = accepted([said('accepted')])
    expect(due({ items })).toMatchObject({
      outbox: 'nothing',
      because: 'accepted has already gone back about req-1',
    })
  })

  it('never says a status late, so a window that was shut does not catch up out loud', () => {
    // Finished has gone; the work is somehow read as started again. Saying
    // `started` now would be a machine talking about its own history.
    const items = accepted([said('finished')])
    expect(due({ items, work: [work({ started: true })] })).toMatchObject({
      outbox: 'nothing',
      because: expect.stringContaining('a status is never said late'),
    })
  })

  it('waits a minute after a failure, then tries again', () => {
    const items = accepted([said('accepted', { state: 'unsent', problem: 'it would not take it' })])
    expect(due({ items, now: AT + 1_000 })).toEqual({
      outbox: 'wait',
      until: AT + INTAKE_REPLY_RETRY_MS,
      because: 'saying accepted about req-1 failed less than a minute ago',
    })
    const later = due({ items, now: AT + INTAKE_REPLY_RETRY_MS + 1 })
    expect(later).toMatchObject({ outbox: 'due' })
    // And it is the second try, which is what a failure says out loud: the
    // third is the last one there will be.
    expect(later).toMatchObject({ entry: { attempt: 2 } })
  })

  it('tries again at once where the clock moved backwards under it', () => {
    // A failure "in the future" is a clock that moved, not a minute that has
    // not passed — and waiting on one would strand the status for ever.
    const items = accepted([said('accepted', { state: 'unsent', at: AT + 3_600_000 })])
    expect(due({ items, now: AT })).toMatchObject({ outbox: 'due' })
  })

  it('stops after three tries, and says what it was that failed', () => {
    const items = accepted(
      Array.from({ length: INTAKE_REPLY_ATTEMPTS }, () =>
        said('accepted', { state: 'unsent', problem: 'the source is read-only' }),
      ),
    )
    expect(due({ items, now: AT + 3_600_000 })).toMatchObject({
      outbox: 'nothing',
      because: expect.stringContaining(
        'failed 3 times and was given up on: the source is read-only',
      ),
    })
  })

  it('stops at the cap, which only a journal nobody can read ever reaches', () => {
    // The cap is as high as the number of sayings, so one per saying is always
    // the binding bound and the cap can never be what stops an honest status.
    // It was lower once, and what it silently dropped was `finished`. What
    // reaches it now is a line saying something left this machine that names
    // no status: counted, because the one thing a bound must never do is
    // quietly widen.
    const items = accepted(
      Array.from({ length: INTAKE_REPLY_CAP }, () => event('intake_replied', { ...where })),
    )
    expect(due({ items })).toMatchObject({
      outbox: 'nothing',
      because: expect.stringContaining('enough has already been said back about req-1 today'),
    })
    // And a day later it is a day later.
    expect(due({ items, now: AT + 25 * 3_600_000 })).toMatchObject({ outbox: 'due' })
  })

  it('never lets the cap bind before the rule does', () => {
    // Every saying a request's life has, said: the cap is `INTAKE_SAYINGS`
    // long, so running out of cap before running out of sayings is impossible
    // rather than unlikely.
    expect(INTAKE_REPLY_CAP).toBe(INTAKE_SAYINGS.length)
  })
})

describe('the whole outbox', () => {
  it('offers one entry per request with something due, and skips a source that is gone', () => {
    const items = accepted()
    const rows = [row(items), { ...row(items), item: 'linear:ENG-1', source: 'linear' }]
    expect(
      outboxOf({
        rows,
        items,
        grantOf: (source) => (source === 'cli' ? grant() : null),
        now: AT,
        machine: 'studio',
      }).map((entry) => entry.item),
    ).toEqual(['cli:req-1'])
  })
})

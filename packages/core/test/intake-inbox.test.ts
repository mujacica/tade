import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import {
  INBOX_STATES,
  type InboxRow,
  type InboxWork,
  inboxActs,
  inboxOf,
  inboxProvenance,
  inboxRowOf,
  inboxWaiting,
  MATERIAL_LABEL,
  materialUnread,
  whyNotAct,
} from '../src/intake-inbox.ts'
import { intakeFrom } from '../src/intake-journal.ts'

// The inbox: the seven answers to "where does this request stand", and the one
// rule that says what may be done about one.
//
// Every test here is about a *difference the old three states could not say*.
// `IntakeItem.state` is what the rule decided — received, refused, accepted —
// and the thing somebody actually needs to know is whether they are the one
// being waited on, which is the task's answer and not the rule's.

let seq = 0
const event = (
  type: TadeEvent['type'],
  detail: Record<string, unknown>,
  task?: string,
): TadeEvent =>
  ({
    seq: ++seq,
    ts: new Date(1_760_000_000_000 + seq * 1000).toISOString(),
    type,
    task: task ?? null,
    detail,
  }) as TadeEvent

const WHERE = {
  item: 'cli:req-1',
  source: 'cli',
  external_id: 'req-1',
  revision: '1',
  project: 'app',
  requester: 'kim',
  hash: 'sha256:aaa',
  ref: 'req-1.0001.json',
  url: 'https://example.invalid/req-1',
  watch: 'intake.cli',
  schedule: 'intake-cli',
}

const work = (over: Partial<InboxWork> = {}): InboxWork => ({
  task: 'app/cli-req-1',
  parked: true,
  started: false,
  finished: false,
  held: null,
  state: null,
  ...over,
})

/** The journal for one delivery that was accepted, and whatever came after. */
function accepted(after: TadeEvent[] = []): TadeEvent[] {
  return [
    event('intake_received', WHERE),
    event(
      'intake_accepted',
      {
        ...WHERE,
        grant: 'surfaces.intake.sources.cli',
        mode: 'propose',
        template: 'bug',
        version: 3,
      },
      'app/cli-req-1',
    ),
    ...after,
  ]
}

const only = (events: TadeEvent[], tasks: InboxWork[] = []): InboxRow => {
  const rows = inboxOf(intakeFrom(events), tasks)
  const row = rows[0]
  if (!row) throw new Error('no row')
  return row
}

describe('the inbox', () => {
  it('has a state for each of the four waits and each of the three ways it stops', () => {
    expect([...INBOX_STATES]).toEqual([
      'noticed',
      'proposed',
      'accepted',
      'started',
      'held',
      'refused',
      'failure',
    ])
  })

  it('tells a parked proposal from a queued task from a running agent', () => {
    expect(only(accepted(), [work()]).state).toBe('proposed')
    expect(only(accepted(), [work({ parked: false })]).state).toBe('accepted')
    expect(only(accepted(), [work({ parked: false, started: true })]).state).toBe('started')
    // All three are `accepted` to the rule that decided them, which is why the
    // journal's own three states cannot answer "is somebody waiting on me".
    expect(intakeFrom(accepted()).get('cli:req-1')?.state).toBe('accepted')
  })

  it('says a delivery nothing has been made for is noticed, not accepted', () => {
    const row = only([event('intake_received', WHERE)])
    expect(row.state).toBe('noticed')
    expect(row.because).toContain('nothing has been made')
  })

  it('reads a hold after acceptance as held, over whatever the work says', () => {
    const row = only(
      accepted([event('intake_held', { ...WHERE, problem: 'it is now revision 2' })]),
      [work()],
    )
    expect(row.state).toBe('held')
    expect(row.because).toContain('revision 2')
    expect(row.attempts).toBe(1)
  })

  it('reads a giving-up as a failure, which outranks everything', () => {
    const row = only(
      accepted([
        event('intake_held', { ...WHERE, problem: 'the source will not answer', gave_up: true }),
      ]),
      [work()],
    )
    expect(row.state).toBe('failure')
    expect(row.because).toContain('will not answer')
  })

  it('says the queue is the one holding it, naming the task', () => {
    const row = only(accepted(), [work({ parked: false, held: 'tade has spent its budget today' })])
    expect(row.state).toBe('held')
    expect(row.because).toContain('app/cli-req-1 is held')
    expect(row.because).toContain('budget')
  })

  it('says a refusal in the words of the rule that made it', () => {
    const row = only([
      event('intake_received', WHERE),
      event('intake_refused', { ...WHERE, why: 'not_allowed' }),
    ])
    expect(row.state).toBe('refused')
    expect(row.because).toContain('@kim')
  })

  it('says a person’s own refusal, which is not one of the rule’s four', () => {
    const row = only(
      accepted([event('intake_refused', { ...WHERE, why: 'by_hand', problem: 'not this week' })]),
      [work()],
    )
    expect(row.state).toBe('refused')
    expect(row.because).toBe('not this week')
  })

  it('calls finished work finished rather than drawing it as running', () => {
    const row = only(accepted(), [work({ parked: false, started: true, finished: true })])
    expect(row.state).toBe('started')
    expect(row.because).toContain('finished')
  })

  it('counts only what a person has to answer as waiting', () => {
    const rows = [
      only(accepted(), [work()]),
      only(accepted(), [work({ parked: false, started: true })]),
    ]
    expect(inboxWaiting(rows).map((row) => row.state)).toEqual(['proposed'])
  })

  it('leaves out the work whose task file is gone, and says so', () => {
    const row = only(accepted(), [])
    expect(row.state).toBe('accepted')
    expect(row.because).toContain('not there now')
    // And it cannot be approved: there is nothing left to lift a park on.
    expect(whyNotAct(row, 'approve')).toContain('nothing of')
  })

  it('carries the template version resolved when it was accepted', () => {
    const row = only(accepted(), [work()])
    expect(row.template).toEqual({ name: 'bug', version: 3 })
    expect(inboxProvenance(row).find((fact) => fact.label === 'template')?.value).toBe('bug@3')
  })
})

describe('what may be done about one', () => {
  it('offers approve only where there is parked work', () => {
    expect(whyNotAct(only(accepted(), [work()]), 'approve')).toBeNull()
    expect(whyNotAct(only(accepted(), [work({ parked: false })]), 'approve')).toContain(
      'already picked up',
    )
    expect(whyNotAct(only([event('intake_received', WHERE)]), 'approve')).toContain(
      'nothing has been made',
    )
  })

  it('refuses to approve something that was refused, and says a new revision is a new request', () => {
    const row = only([
      event('intake_received', WHERE),
      event('intake_refused', { ...WHERE, why: 'no_grant' }),
    ])
    expect(whyNotAct(row, 'approve')).toContain('new revision')
  })

  it('offers retry only for a delivery that failed, and names the queue when it is the queue', () => {
    expect(
      whyNotAct(
        only(accepted([event('intake_held', { ...WHERE, problem: 'off' })]), [work()]),
        'retry',
      ),
    ).toBeNull()
    const held = only(accepted(), [work({ parked: false, held: 'it could not start' })])
    expect(whyNotAct(held, 'retry')).toContain('answer that in the queue')
    expect(whyNotAct(only(accepted(), [work()]), 'retry')).toContain('nothing to try again')
  })

  it('offers refuse for anything not already refused', () => {
    expect(whyNotAct(only(accepted(), [work()]), 'refuse')).toBeNull()
    const refused = only([
      event('intake_received', WHERE),
      event('intake_refused', { ...WHERE, why: 'is_bot' }),
    ])
    expect(whyNotAct(refused, 'refuse')).toContain('already refused')
  })

  it('offers the same four acts with the same reasons to every surface', () => {
    const row = only(accepted(), [work()])
    const acts = inboxActs(row)
    expect(acts.map((one) => one.act)).toEqual(['approve', 'start', 'refuse', 'retry'])
    // The refusal a button is greyed with is the sentence the door throws: one
    // rule, read by the drawing and by the act.
    for (const one of acts) expect(one.off).toBe(whyNotAct(row, one.act))
  })
})

describe('provenance, and the request it is not', () => {
  it('names the grant as the key somebody can go and remove', () => {
    const facts = inboxProvenance(only(accepted(), [work()]))
    expect(facts.find((fact) => fact.label === 'allowed by')?.value).toBe(
      'surfaces.intake.sources.cli',
    )
  })

  it('draws nothing nobody said as a blank or a nought', () => {
    const row = only([event('intake_received', { item: 'cli:x', source: 'cli', external_id: 'x' })])
    for (const fact of inboxProvenance(row)) expect(fact.value).not.toBe('')
  })

  it('says both revisions where the request has moved since the work was made', () => {
    const row = only(accepted([event('intake_received', { ...WHERE, revision: '2' })]), [work()])
    expect(inboxProvenance(row).find((fact) => fact.label === 'revision')?.value).toContain(
      'the work was made for 1',
    )
  })

  it('has nowhere to put the request itself, which is the enforcement', () => {
    const row = only(accepted(), [work()])
    // Not a substring assertion over a value: the type has no field for a body
    // at all, so a surface, a tool or a reply cannot leak one through it.
    expect(Object.keys(row)).not.toContain('verbatim')
    expect(Object.keys(row)).not.toContain('body')
    expect(JSON.stringify(row)).not.toContain('export button')
  })

  it('labels the material and carries the whole wording with it', () => {
    const row = only(accepted(), [work()])
    const unread = materialUnread(row, 'nothing was made for it')
    expect(unread.body).toBeNull()
    expect(unread.problem).toContain('nothing was made')
    expect(unread.heading).toContain('material, not instruction')
    expect(MATERIAL_LABEL).toContain('not an instruction')
  })
})

describe('one row at a time', () => {
  it('folds a row out of an item and the work it made', () => {
    const item = intakeFrom(accepted()).get('cli:req-1')
    if (!item) throw new Error('no item')
    const row = inboxRowOf(item, [work(), work({ task: 'other/thing', parked: false })])
    // Only its own work: another task that happens to be parked is not its
    // business, and reading one as its own is how two requests come to share
    // one answer.
    expect(row.work.map((one) => one.task)).toEqual(['app/cli-req-1'])
  })

  it('narrows to one project when asked, and is newest first', () => {
    const events = [
      ...accepted(),
      event('intake_received', {
        ...WHERE,
        item: 'cli:req-2',
        external_id: 'req-2',
        project: 'web',
      }),
    ]
    const all = inboxOf(intakeFrom(events), [work()])
    expect(all.map((row) => row.item)).toEqual(['cli:req-2', 'cli:req-1'])
    expect(
      inboxOf(intakeFrom(events), [work()], { project: 'app' }).map((row) => row.item),
    ).toEqual(['cli:req-1'])
  })
})

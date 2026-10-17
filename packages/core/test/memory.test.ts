import { describe, expect, it } from 'vitest'
import {
  allNotes,
  appliesTo,
  type Note,
  NoteSchema,
  note,
  notesToRetire,
  recall,
  scopeList,
  scopesOf,
  type TaskLast,
  unnoted,
} from '../src/memory.ts'

// Notes are the one thing Tade knows that it could not have worked out for
// itself, so the rules about what applies where are the whole substance.

const NOW = Date.parse('2026-09-12T10:00:00Z')

const at = (iso: string, scope: string | null, text = 'something'): Note => ({
  text,
  scope,
  by: 'test',
  at: iso,
})

describe('note', () => {
  it('keeps what was said, exactly', () => {
    const saved = note('  the staging key rotates on the 1st  ', 'checkout', 'voice', NOW)
    // Trimmed, never reworded: the wording is the point.
    expect(saved.text).toBe('the staging key rotates on the 1st')
    expect(saved.scope).toBe('checkout')
    // Who set it and when, so "why does it keep doing that" is answerable.
    expect(saved.by).toBe('voice')
    expect(saved.at).toBe('2026-09-12T10:00:00.000Z')
  })

  it('keeps a headline beside the words, never instead of them', () => {
    const saved = note(
      'refunds go through the ledger service',
      'checkout/refunds',
      'orchestrator',
      NOW,
      '  Refunds via the ledger  ',
    )
    expect(saved.summary).toBe('Refunds via the ledger')
    // The words themselves are untouched by having one.
    expect(saved.text).toBe('refunds go through the ledger service')
    expect(NoteSchema.parse(saved)).toEqual(saved)
  })

  it('has no headline where nobody wrote one, rather than one made up', () => {
    const saved = note('we pin major versions', null, 'window', NOW)
    expect(saved.summary).toBeUndefined()
    expect('summary' in saved).toBe(false)
    // An empty one is nobody writing one.
    expect(note('a thing', null, 'cli', NOW, '   ').summary).toBeUndefined()
  })

  it('still loads a note written before a headline could be given', () => {
    const old = { text: 'we pin majors', scope: null, by: 'voice', at: '2026-09-01T00:00:00.000Z' }
    const parsed = NoteSchema.parse(old)
    expect(parsed.summary).toBeUndefined()
    expect(parsed.text).toBe('we pin majors')
  })

  it('round-trips through its schema', () => {
    const one = note('a thing', null, 'cli', NOW)
    expect(NoteSchema.parse(one)).toEqual(one)
  })

  it('still loads a note written before provenance was kept', () => {
    // Losing old notes to a schema change would be losing the one thing
    // nothing else can recover.
    const old = { text: 'we pin majors', scope: null, at: '2026-09-01T00:00:00.000Z' }
    expect(NoteSchema.parse(old)).toMatchObject({ text: 'we pin majors', by: 'unknown' })
  })

  it('refuses a note that says nothing', () => {
    expect(NoteSchema.safeParse({ text: '', scope: null, at: 'x' }).success).toBe(false)
  })
})

describe('appliesTo', () => {
  it('applies a note about everything, everywhere', () => {
    expect(appliesTo(at('x', null), 'checkout/refunds')).toBe(true)
    expect(appliesTo(at('x', null), null)).toBe(true)
  })

  it('applies a project note to the tasks in it', () => {
    expect(appliesTo(at('x', 'checkout'), 'checkout/refunds')).toBe(true)
  })

  it('never leaks a task note to its siblings', () => {
    expect(appliesTo(at('x', 'checkout/refunds'), 'checkout/stripe-v15')).toBe(false)
    // Nor to the project as a whole.
    expect(appliesTo(at('x', 'checkout/refunds'), 'checkout')).toBe(false)
  })

  it('does not confuse projects that start alike', () => {
    expect(appliesTo(at('x', 'check'), 'checkout/refunds')).toBe(false)
  })

  it('keeps something specific out of a general question', () => {
    expect(appliesTo(at('x', 'checkout'), null)).toBe(false)
  })
})

describe('recall', () => {
  const notes = [
    at('2026-09-10T10:00:00.000Z', null, 'I work from home on Fridays'),
    at('2026-09-11T10:00:00.000Z', 'checkout', 'staging key rotates on the 1st'),
    at('2026-09-12T10:00:00.000Z', 'checkout/refunds', 'the webhook retries twice'),
    at('2026-09-12T09:00:00.000Z', 'search/pagination', 'cursor, not offset'),
  ]

  it('believes the narrowest, even when something general was said later', () => {
    const contradicting = [
      at('2026-09-01T10:00:00.000Z', 'checkout/refunds', 'retry twice here'),
      at('2026-09-12T10:00:00.000Z', null, 'never retry anything'),
    ]
    // The one about this task comes first even though it is much older: a
    // passing general remark should not outrank a specific instruction.
    expect(recall(contradicting, 'checkout/refunds').map((n) => n.text)).toEqual([
      'retry twice here',
      'never retry anything',
    ])
  })

  it('gathers the task, its project and everything, narrowest first', () => {
    expect(recall(notes, 'checkout/refunds').map((n) => n.text)).toEqual([
      'the webhook retries twice',
      'staging key rotates on the 1st',
      'I work from home on Fridays',
    ])
  })

  it('leaves out other projects entirely', () => {
    expect(recall(notes, 'checkout/refunds').map((n) => n.text)).not.toContain('cursor, not offset')
  })

  it('answers a general question with only what is general', () => {
    expect(recall(notes, null).map((n) => n.text)).toEqual(['I work from home on Fridays'])
  })

  it('has nothing to say about something it was never told about', () => {
    expect(recall(notes, 'billing/invoices').map((n) => n.text)).toEqual([
      'I work from home on Fridays',
    ])
  })
})

describe('allNotes', () => {
  it('is everything, newest first, whatever it is about', () => {
    const notes = [at('2026-09-10T10:00:00.000Z', 'a'), at('2026-09-12T10:00:00.000Z', 'b')]
    expect(allNotes(notes).map((n) => n.scope)).toEqual(['b', 'a'])
  })
})

describe('a note about several things', () => {
  it('is one note, its first scope its own and the rest beside it', () => {
    const one = note(
      'no remote terminal access',
      ['tade/away-a', 'tade/away-b'],
      'orchestrator',
      NOW,
    )
    expect(one.scope).toBe('tade/away-a')
    expect(one.also).toEqual(['tade/away-b'])
    expect(scopesOf(one)).toEqual(['tade/away-a', 'tade/away-b'])
    expect(NoteSchema.parse(one)).toEqual(one)
    // A note about one thing has nothing beside it, rather than an empty list.
    expect('also' in note('x', 'tade', 'cli', NOW)).toBe(false)
  })

  it('reaches every task it names, and none it does not', () => {
    const one = note('mobile matters', ['tade/away-a', 'cruxed'], 'orchestrator', NOW)
    expect(appliesTo(one, 'tade/away-a')).toBe(true)
    expect(appliesTo(one, 'cruxed/marketing')).toBe(true)
    expect(appliesTo(one, 'tade/away-c')).toBe(false)
    expect(recall([one], 'cruxed/marketing').map((n) => n.text)).toEqual(['mobile matters'])
  })

  it('reads a list of scopes once each, and nothing — or everything — as everything', () => {
    expect(scopeList([' a/b ', 'a/b', '', 'c'])).toEqual(['a/b', 'c'])
    expect(scopeList([])).toEqual([null])
    expect(scopeList(null)).toEqual([null])
    expect(scopeList(['a/b', null])).toEqual([null])
  })
})

describe('the same words again', () => {
  const kept = note('route AI through OpenRouter', 'zz/c3', 'orchestrator', NOW)

  it('adds nothing about what the note already reaches', () => {
    expect(unnoted(kept, 'route AI through OpenRouter', 'zz/c3')).toEqual([])
    // Compared after the same trim the note was given, and never loosened.
    expect(unnoted(kept, '  route AI through OpenRouter ', 'zz/c3')).toEqual([])
    expect(unnoted(kept, 'route ai through openrouter', 'zz/c3')).toEqual(['zz/c3'])
  })

  it('adds what it does not reach: another task, or everything', () => {
    expect(unnoted(kept, kept.text, ['zz/c3', 'zz/c4'])).toEqual(['zz/c4'])
    expect(unnoted(kept, kept.text, null)).toEqual([null])
  })

  it('adds nothing under a note about everything, or about the task’s project', () => {
    expect(unnoted({ ...kept, scope: null }, kept.text, 'zz/c3')).toEqual([])
    expect(unnoted({ ...kept, scope: 'zz' }, kept.text, 'zz/c3')).toEqual([])
  })

  it('is a new note where the one with those words was retired', () => {
    const retired = { ...kept, retired: { by: 'cleanup', at: 'x', because: 'gone' } }
    expect(unnoted(retired, kept.text, 'zz/c3')).toEqual(['zz/c3'])
  })
})

describe('a retired note', () => {
  const live = at('2026-09-10T10:00:00.000Z', 'tade/a', 'still true')
  const retired: Note = {
    ...at('2026-09-11T10:00:00.000Z', 'tade/a', 'not any more'),
    retired: { by: 'cleanup', at: '2026-09-12T00:00:00.000Z', because: 'tade/a was removed' },
  }

  it('is told to nobody', () => {
    expect(recall([live, retired], 'tade/a').map((n) => n.text)).toEqual(['still true'])
    expect(allNotes([live, retired]).map((n) => n.text)).toEqual(['still true'])
  })

  it('is still read on asking, with why', () => {
    const all = allNotes([live, retired], { retired: true })
    expect(all.map((n) => n.text)).toEqual(['not any more', 'still true'])
    expect(all[0]?.retired?.because).toBe('tade/a was removed')
  })
})

describe('what the cleanup retires', () => {
  const DAY = 86_400_000
  const TODAY = Date.parse('2026-10-16T09:00:00Z')
  const daysAgo = (days: number) => new Date(TODAY - days * DAY).toISOString()
  const keep = 3 * DAY
  const last = (entries: Record<string, [TaskLast['type'], number]>) =>
    new Map(
      Object.entries(entries).map(([task, [type, days]]) => [
        task,
        { type, at: TODAY - days * DAY },
      ]),
    )
  const nothing = { last: new Map<string, TaskLast>(), present: () => true }
  const said = (iso: string, scope: string | null, text: string, also?: string[]): Note => ({
    ...at(iso, scope, text),
    ...(also ? { also } : {}),
  })

  it('retires the same words again about the same, and keeps the first', () => {
    const first = said(daysAgo(9), 'tade/a', 'mobile matters')
    const again = said(daysAgo(8), 'tade/a', 'mobile matters')
    const taken = notesToRetire([again, first], nothing, TODAY, keep)
    expect(taken.map((one) => [one.note.at, one.rule])).toEqual([[again.at, 'duplicate']])
    expect(taken[0]?.because).toBe(
      `the same words as the note of ${first.at.slice(0, 10)}, about the same`,
    )
  })

  it('keeps the same words about something else: that needs somebody to say which was meant', () => {
    // The unscoped-then-scoped pair on the machine this was written on: which
    // one was meant is a judgement, so the rule leaves both.
    const everything = said(daysAgo(9), null, 'route AI through OpenRouter')
    const task = said(daysAgo(9), 'zz/c3', 'route AI through OpenRouter')
    const fanned = said(daysAgo(9), 'tade/b', 'route AI through OpenRouter')
    expect(notesToRetire([everything, task, fanned], nothing, TODAY, keep)).toEqual([])
  })

  it('retires a note about a task removed longer ago than it keeps them', () => {
    const one = said(daysAgo(30), 'tade/purple', 'hover too')
    const taken = notesToRetire(
      [one],
      { last: last({ 'tade/purple': ['task_removed', 25] }), present: () => false },
      TODAY,
      keep,
    )
    expect(taken.map((t) => [t.rule, t.because])).toEqual([
      ['gone', 'tade/purple was removed 25 days ago'],
    ])
  })

  it('keeps one removed more recently, and one taken after its task went until that ages too', () => {
    const facts = {
      last: last({ 'tade/x': ['task_removed', 2], 'tade/y': ['task_removed', 20] }),
      present: () => false,
    }
    expect(notesToRetire([said(daysAgo(10), 'tade/x', 'a')], facts, TODAY, keep)).toEqual([])
    expect(notesToRetire([said(daysAgo(1), 'tade/y', 'b')], facts, TODAY, keep)).toEqual([])
  })

  it('retires one about a finished task, whose file may still be there', () => {
    const facts = { last: last({ 'cruxed/site': ['task_done', 5] }), present: () => true }
    const taken = notesToRetire(
      [said(daysAgo(6), 'cruxed/site', 'no prose in the UI')],
      facts,
      TODAY,
      keep,
    )
    expect(taken.map((t) => t.because)).toEqual(['cruxed/site finished 5 days ago'])
  })

  it('retires one whose task file went with nothing in the journal to say how', () => {
    // A task removed and started again, then gone: its last word is a start.
    const facts = { last: last({ 'tade/perf': ['run_started', 5] }), present: () => false }
    const taken = notesToRetire([said(daysAgo(6), 'tade/perf', 'hold it')], facts, TODAY, keep)
    expect(taken.map((t) => t.because)).toEqual([
      'tade/perf is gone, and nothing has happened to it since 5 days ago',
    ])
  })

  it('never retires one about work still there, a project, or everything', () => {
    const facts = { last: last({ 'tade/live': ['run_started', 40] }), present: () => true }
    const notes = [
      said(daysAgo(40), 'tade/live', 'still going'),
      said(daysAgo(40), 'tade', 'a project'),
      said(daysAgo(40), null, 'everything'),
    ]
    expect(
      notesToRetire(notes, { ...facts, present: (t) => t === 'tade/live' }, TODAY, keep),
    ).toEqual([])
  })

  it('retires a note about several tasks only once every one is gone, by the last to go', () => {
    const facts = {
      last: last({ 'tade/a': ['task_removed', 10], 'tade/b': ['task_removed', 4] }),
      present: () => false,
    }
    const both = said(daysAgo(20), 'tade/a', 'one sentence', ['tade/b'])
    expect(notesToRetire([both], facts, TODAY, keep).map((t) => t.because)).toEqual([
      'tade/b was removed 4 days ago',
    ])
    const stillOne = said(daysAgo(20), 'tade/a', 'other sentence', ['tade/c'])
    expect(
      notesToRetire([stillOne], { ...facts, present: (t) => t === 'tade/c' }, TODAY, keep),
    ).toEqual([])
  })

  it('leaves a note taken on another machine about a task nothing here has heard of to that machine', () => {
    // Shared between homes, tasks not: the task is most likely running there,
    // and that machine's retirement comes back over the link.
    const far: Note = { ...said(daysAgo(30), 'vps/nightly', 'run it at two'), from: 'vps' }
    const gone = { last: new Map<string, TaskLast>(), present: () => false }
    expect(notesToRetire([far], gone, TODAY, keep)).toEqual([])
    // What this journal does know, it still judges: finished here is finished.
    const done = { last: last({ 'vps/nightly': ['task_done', 10] }), present: () => false }
    expect(notesToRetire([far], done, TODAY, keep).map((t) => t.because)).toEqual([
      'vps/nightly finished 10 days ago',
    ])
    // And one taken here about a task nothing knows is aged as it always was.
    const here = said(daysAgo(30), 'vps/nightly', 'run it at two')
    expect(notesToRetire([here], gone, TODAY, keep).map((t) => t.rule)).toEqual(['gone'])
  })

  it('leaves alone what is already retired', () => {
    const done: Note = {
      ...said(daysAgo(30), 'tade/purple', 'hover too'),
      retired: { by: 'cleanup', at: daysAgo(1), because: 'gone' },
    }
    expect(notesToRetire([done], { last: new Map(), present: () => false }, TODAY, keep)).toEqual(
      [],
    )
  })
})

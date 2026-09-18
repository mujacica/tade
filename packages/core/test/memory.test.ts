import { describe, expect, it } from 'vitest'
import { allNotes, appliesTo, type Note, NoteSchema, note, recall } from '../src/memory.ts'

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

import { describe, expect, it } from 'vitest'
import {
  allNotes,
  appliesTo,
  describeNotes,
  type Note,
  NoteSchema,
  note,
  recall,
} from '../src/memory.ts'

// Notes are the one thing Wilco knows that it could not have worked out for
// itself, so the rules about what applies where are the whole substance.

const NOW = Date.parse('2026-09-12T10:00:00Z')

const at = (iso: string, scope: string | null, text = 'something'): Note => ({
  text,
  scope,
  at: iso,
})

describe('note', () => {
  it('keeps what was said, exactly', () => {
    const saved = note('  the staging key rotates on the 1st  ', 'checkout', NOW)
    // Trimmed, never reworded: the wording is the point.
    expect(saved.text).toBe('the staging key rotates on the 1st')
    expect(saved.scope).toBe('checkout')
    expect(saved.at).toBe('2026-09-12T10:00:00.000Z')
  })

  it('round-trips through its schema', () => {
    expect(NoteSchema.parse(note('a thing', null, NOW))).toEqual(note('a thing', null, NOW))
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

  it('gathers the task, its project and everything, newest first', () => {
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

describe('describeNotes', () => {
  it('says nothing rather than pretending', () => {
    expect(describeNotes([])).toBe('Nothing yet.')
  })

  it('reads as a sentence', () => {
    expect(describeNotes([at('x', null, 'the webhook retries twice')])).toBe(
      'the webhook retries twice.',
    )
  })

  it('counts the rest instead of reciting them', () => {
    // Speech is expensive; a list of nine things down an earbud is unusable.
    const many = Array.from({ length: 9 }, (_, i) => at('x', null, `thing ${i}`))
    expect(describeNotes(many)).toBe('thing 0. thing 1. thing 2. And 6 more.')
  })
})

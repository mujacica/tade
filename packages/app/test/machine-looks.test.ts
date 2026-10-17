import { EvaluationsAnswerSchema, RecordsAnswerSchema } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { cardsOf, heldSaid, recordsOf } from '../src/machine-looks.ts'

// What another machine says only while somebody here looks, folded for the
// drawing (`machine-looks.ts`): nothing before an answer, every word a person
// reads made text, and when it came kept in this machine's clock.

const NOW = Date.UTC(2026, 9, 17, 12, 0)
const ESC = '\x1b]0;pwned\x07'

const RECORDS = RecordsAnswerSchema.parse({
  at: '2026-10-17T11:00:00.000Z',
  name: `tade.example.com${ESC}`,
  head: null,
  lines: [
    {
      record: 'AAAA',
      state: 'wrong',
      said: `AAAA: elsewhere${ESC}`,
      add: null,
      remove: [`tade.example.com. AAAA 2001:db8::7${ESC}`],
      loud: true,
    },
  ],
  cannot: `the look ran out of time${ESC}`,
})

const CARD = {
  key: `pi${ESC}`,
  label: `pi${ESC}`,
  named: false,
  tasks: 2,
  done: { count: 1, of: 2, said: '1 of 2' },
  landed: { count: 1, of: 2, said: '1 of 2' },
  merged: 0,
  firstPushGreen: { count: 0, of: 0, said: '—' },
  redsHere: 3,
  findings: { fired: 2, on: 1, confirmed: 1, wrong: 0, open: 1 },
  cost: [{ said: `$1.20${ESC}`, kind: 'worked out' }],
  tokensPerLanded: 1200,
  toDoneMs: 60_000,
  moved: 1,
}

describe('another machine’s records, folded', () => {
  it('is nothing before an answer came, and nothing without when it came', () => {
    expect(recordsOf(null)).toBeNull()
    expect(recordsOf({ answer: null, at: null, said: 'asking', busy: true })).toBeNull()
    expect(recordsOf({ answer: RECORDS, at: null, said: null, busy: false })).toBeNull()
  })

  it('keeps when it came here, why it could not look, and a record to take away, all as text', () => {
    const seen = recordsOf({ answer: RECORDS, at: NOW, said: null, busy: false })
    expect(seen?.at).toBe(NOW)
    expect(seen?.name).toBe('tade.example.com␛')
    expect(seen?.head).toBeNull()
    expect(seen?.cannot).toBe('the look ran out of time␛')
    expect(seen?.lines[0]).toEqual({
      record: 'AAAA',
      state: 'wrong',
      said: 'AAAA: elsewhere␛',
      add: null,
      remove: ['tade.example.com. AAAA 2001:db8::7␛'],
      loud: true,
    })
  })
})

describe('another machine’s scorecards, folded', () => {
  it('is nothing before an answer, and every grouping’s rows as text with the counts it sent', () => {
    expect(cardsOf(undefined)).toBeNull()
    const answer = EvaluationsAnswerSchema.parse({
      read: true,
      mergedFrom: 'journal',
      granted: { spend: true, findings: false },
      judge: 'not granted',
      total: CARD,
      by: { harness: [CARD], model: [], persona: [], template: [] },
    })
    const cards = cardsOf({ answer, at: NOW, said: null, busy: false })
    expect(cards?.at).toBe(NOW)
    expect(cards?.granted).toEqual({ spend: true, findings: false })
    expect(cards?.by.model).toEqual([])
    expect(cards?.by.harness[0]).toMatchObject({
      label: 'pi␛',
      named: false,
      done: { count: 1, of: 2 },
      redsHere: 3,
      findings: { fired: 2, confirmed: 1, wrong: 0, open: 1 },
      cost: [{ said: '$1.20␛', kind: 'worked out' }],
      tokensPerLanded: 1200,
    })
  })
})

describe('why there is nothing held', () => {
  it('is the asking’s own words or that machine’s, as text, and nothing where nothing was said', () => {
    expect(heldSaid(null)).toBeNull()
    expect(heldSaid({ answer: null, at: null, said: null, busy: false })).toBeNull()
    expect(heldSaid({ answer: null, at: null, said: `   ${ESC}`, busy: false })).toBe('␛')
    expect(heldSaid({ answer: null, at: null, said: '  \t ', busy: false })).toBeNull()
    expect(heldSaid({ answer: null, at: null, said: `vps answered 500${ESC}`, busy: false })).toBe(
      'vps answered 500␛',
    )
  })
})

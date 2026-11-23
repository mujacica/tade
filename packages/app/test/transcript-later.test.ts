import { describe, expect, it } from 'vitest'
import { emptyTranscript, withLater } from '../src/transcript.ts'

// What another machine said in the one conversation, taken into this one's
// record between turns and drawn below what is shown (`withLater`): only what
// is newer than the newest line shown, so a page read twice adds nothing.

describe('what was said after what is shown', () => {
  it('draws only what is newer, once', () => {
    const shown = withLater(
      emptyTranscript(),
      [{ kind: 'reply', text: 'heron, noted', at: 10 }],
      () => false,
    )
    expect(shown.entries.map((entry) => entry.kind)).toEqual(['said'])
    const page = [
      { kind: 'reply' as const, text: 'heron, noted', at: 10 },
      { kind: 'sent' as const, text: 'what word did I say?', images: [], at: 20 },
      { kind: 'reply' as const, text: 'heron', at: 30 },
    ]
    const next = withLater(shown, page, (text) => text === 'what word did I say?')
    expect(next.entries.map((entry) => [entry.kind, 'text' in entry ? entry.text : ''])).toEqual([
      ['said', 'heron, noted'],
      ['you', 'what word did I say?'],
      ['said', 'heron'],
    ])
    expect(withLater(next, page, () => true)).toBe(next)
  })
})

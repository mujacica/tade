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

  it('marks what another machine said with its name, Tade’s news included, and leaves unmarked what nobody could say whose it was', () => {
    // A turn Tade composed on vps, while the machines could not reach each
    // other: no projection carries its news, so the record is the only way in.
    const page = [
      {
        kind: 'sent' as const,
        text: 'What happened:\n- checkout/refunds finished',
        images: [],
        at: 10,
      },
      { kind: 'reply' as const, text: 'noted', at: 11 },
      {
        kind: 'tool' as const,
        id: 'call-1',
        tool: 'status',
        input: {},
        ok: true,
        result: 'fine',
        at: 11,
      },
      { kind: 'reply' as const, text: 'whose was this?', at: 20 },
    ]
    const shown = withLater(
      emptyTranscript(),
      page,
      () => false,
      new Map([
        [10, 'vps'],
        [11, 'vps'],
      ]),
    )
    expect(
      shown.entries.map((entry) => [entry.kind, entry.there?.machine ?? null, entry.read]),
    ).toEqual([
      ['tade', 'vps', true],
      ['said', 'vps', true],
      ['tool', 'vps', true],
      ['said', null, true],
    ])
    const told = shown.entries[0]
    expect(told?.kind === 'tade' && told.text).toContain('told the orchestrator')
    // Its call is asked for by its id in the record, as one folded as it ran is.
    expect(shown.entries[2]?.there?.call).toBe('call-1')
    // Each line its own: what a later look at that machine's projection matches by.
    expect(new Set(shown.entries.flatMap((entry) => entry.there?.line ?? [])).size).toBe(3)
  })
})

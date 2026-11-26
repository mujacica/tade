import { describe, expect, it } from 'vitest'
import { chatLines } from '../src/away.ts'
import {
  emptyTranscript,
  fromThinker,
  type ThereLine,
  type Transcript,
  withEarlier,
  withLater,
  withThere,
  youSaid,
} from '../src/transcript.ts'

// One orchestrator strip on every machine (`withThere`): another machine's
// turns of the one conversation, as its projection carries them, folded into
// this one's drawing in time order with that machine's name for a mark — and
// never drawn twice, whether its record arrives after (`withLater`) or before
// (`withEarlier`), and never this machine's own turn coming back.

let n = 0
function line(kind: string, text: string, over: Partial<ThereLine> = {}): ThereLine {
  n += 1
  return {
    id: `l${n}`,
    at: 1_000 + n,
    kind,
    from: kind === 'asked' ? 'you' : null,
    text,
    tool: null,
    outcome: null,
    streaming: false,
    there: null,
    read: false,
    call: null,
    ...over,
  }
}

const drawn = (transcript: Transcript) =>
  transcript.entries.map((entry) => [
    entry.kind,
    'text' in entry ? entry.text : entry.kind === 'tool' ? entry.tool : '',
    entry.there?.machine ?? '',
  ])

describe('another machine’s turns, drawn here as they run there', () => {
  it('folds them in time order with the machine’s mark, grows a reply in place, and moves nothing when nothing moved', () => {
    const here = youSaid(emptyTranscript(), 'what is running?', 1_000)
    const asked = line('asked', 'and on ipax?', { at: 2_000 })
    const reply = line('reply', 'Two agents', { at: 2_100, streaming: true })
    const one = withThere(here, 'ipax', [asked, reply], 0)
    expect(drawn(one)).toEqual([
      ['you', 'what is running?', ''],
      ['you', 'and on ipax?', 'ipax'],
      ['said', 'Two agents', 'ipax'],
    ])
    // The same lines again: the same transcript, so a quiet frame stays quiet.
    expect(withThere(one, 'ipax', [asked, reply], 0)).toBe(one)
    // The reply finished there: the same line, grown, and no longer streaming.
    const done = { ...reply, text: 'Two agents, both green.', streaming: false }
    const two = withThere(one, 'ipax', [asked, done], 0)
    expect(two.entries).toHaveLength(3)
    expect(two.entries[2]).toMatchObject({ text: 'Two agents, both green.', streaming: false })
    // A line said here later stays after it.
    const three = youSaid(two, 'thanks', 3_000)
    const late = line('tool', '', { at: 2_200, tool: 'tade_status', outcome: 'ok' })
    expect(drawn(withThere(three, 'ipax', [asked, done, late], 0)).map(([kind]) => kind)).toEqual([
      'you',
      'you',
      'said',
      'tool',
      'you',
    ])
  })

  it('leaves out what that machine folded in or read back, what came before this window, and its news', () => {
    const lines = [
      line('asked', 'from the Mac', { there: 'mac' }),
      line('reply', 'read from its record', { read: true }),
      line('asked', 'before this window opened', { at: 10 }),
      line('tade', 'ipax not linked since 14:02'),
      line('suggestion', 'ask it what it found'),
      line('reply', 'its own, said there now'),
    ]
    expect(drawn(withThere(emptyTranscript(), 'ipax', lines, 500))).toEqual([
      ['said', 'its own, said there now', 'ipax'],
    ])
  })

  it('reads the person at that keyboard, or this machine through its link, as the person, and a phone as the phone', () => {
    const lines = [
      line('asked', 'typed there'),
      line('asked', 'typed here on its tab', { from: 'device mac1' }),
      line('asked', 'from a phone', { from: 'device ph0ne' }),
    ]
    const folded = withThere(emptyTranscript(), 'ipax', lines, 0, 'device mac1')
    expect(folded.entries.map((entry) => (entry.kind === 'you' ? entry.from : ''))).toEqual([
      'you',
      'you',
      'device ph0ne',
    ])
  })

  it('never lets a turn here stream into another machine’s reply', () => {
    const folded = withThere(
      emptyTranscript(),
      'ipax',
      [line('reply', 'still arriving there', { streaming: true })],
      0,
    )
    const here = fromThinker(
      fromThinker(folded, { type: 'delta', text: 'mine' }, 5_000),
      {
        type: 'idle',
      },
      5_100,
    )
    expect(drawn(here)).toEqual([
      ['said', 'still arriving there', 'ipax'],
      ['said', 'mine', ''],
    ])
    // Its own projection settles it, not a turn here.
    expect(here.entries[0]).toMatchObject({ streaming: true })
  })

  it('draws a turn once: its record arriving after it was drawn adds only what was not', () => {
    const folded = withThere(
      youSaid(emptyTranscript(), 'hello', 1_000),
      'ipax',
      [
        line('asked', 'is /Users/amir/tade green?', { text: 'is … green?', at: 2_000 }),
        line('tool', '', { tool: 'tade_status', outcome: 'ok', call: 'toolu_1', at: 2_010 }),
        line('reply', 'Green, all of it.', { at: 2_020 }),
      ],
      0,
    )
    const record = [
      {
        kind: 'sent' as const,
        text: 'What happened: an agent finished\n\nWhat they said:\nis /Users/amir/tade green?',
        images: [],
        at: 2_050,
      },
      {
        kind: 'tool' as const,
        id: 'toolu_1',
        tool: 'tade_status',
        input: {},
        ok: true,
        result: '',
        at: 2_060,
      },
      { kind: 'reply' as const, text: 'Green, all of it.', at: 2_070 },
      { kind: 'reply' as const, text: 'And one more thing.', at: 2_080 },
    ]
    const later = withLater(folded, record, () => false)
    expect(drawn(later)).toEqual([
      ['you', 'hello', ''],
      ['you', 'is … green?', 'ipax'],
      ['tool', 'tade_status', 'ipax'],
      ['said', 'Green, all of it.', 'ipax'],
      ['said', 'And one more thing.', ''],
    ])
  })

  it('draws a turn once: its record read before its projection is not folded again', () => {
    const read = withEarlier(
      emptyTranscript(),
      [{ kind: 'reply', text: 'Read from the record.', at: 2_000 }],
      null,
      () => false,
    )
    const folded = withThere(
      read,
      'ipax',
      [line('reply', 'Read from the record.', { at: 1_990 })],
      0,
    )
    expect(folded).toBe(read)
  })

  it('carries where each line came from to the page and to the other machine, and asks a call’s answer by its id in the record', () => {
    const folded = withThere(
      withEarlier(emptyTranscript(), [{ kind: 'reply', text: 'old', at: 500 }], null, () => false),
      'ipax',
      [
        line('asked', 'from ipax', { at: 1_000 }),
        line('tool', '', { tool: 'tade_status', outcome: 'ok', call: 'toolu_9', at: 1_001 }),
      ],
      0,
    )
    const rows = chatLines(folded)
    expect(rows.map((row) => [row.kind, row.there ?? null, row.read ?? false])).toEqual([
      ['reply', null, true],
      ['asked', 'ipax', false],
      ['tool', 'ipax', false],
    ])
    expect(rows[2]?.call).toMatchObject({ id: 'toolu_9' })
  })
})

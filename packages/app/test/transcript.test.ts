import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { PLAIN } from '../src/skin.ts'
import {
  emptyTranscript,
  fromThinker,
  fromTurn,
  problem,
  suggest,
  TRANSCRIPT_MAX,
  type Transcript,
  thinking,
  toolDetail,
  youSaid,
} from '../src/transcript.ts'
import { transcriptLines } from '../src/transcript-view.ts'

// The conversation with the orchestrator, watched as it happens. It used to
// show nothing until an answer was complete: not what you had said, not what
// it was doing, and not that it had failed or why.

const pointer = { hover: null, pressed: null }
const text = (transcript: Transcript, width = 60, now = 0) =>
  transcriptLines(transcript, width, PLAIN, pointer, now).map((line) => line.text.trimEnd())

describe('the conversation', () => {
  it('shows what you said at once, before anything answers', () => {
    const said = youSaid(emptyTranscript(), 'where are we with refunds?', 0)
    expect(text(said)).toEqual(['❯ where are we with refunds?'])
  })

  it('says it is thinking until something comes back', () => {
    const asked = thinking(youSaid(emptyTranscript(), 'status', 0), 0)
    expect(text(asked, 60, 3_000).at(-1)).toMatch(/thinking · 3s$/)
    const answered = fromThinker(asked, { type: 'idle' }, 3_000)
    expect(text(answered).join('\n')).not.toContain('thinking')
  })

  it('writes an answer out as it streams, then settles on the whole block', () => {
    let current = thinking(youSaid(emptyTranscript(), 'status', 0), 0)
    current = fromThinker(current, { type: 'delta', text: 'Two agents' }, 1)
    current = fromThinker(current, { type: 'delta', text: ' are working' }, 2)
    expect(text(current).at(-1)).toBe('  Two agents are working▍')
    current = fromThinker(current, { type: 'message', text: 'Two agents are working.' }, 3)
    // Still its turn: it may reach for a tool next.
    expect(text(current).at(-1)).toMatch(/thinking$/)
    current = fromThinker(current, { type: 'idle' }, 4)
    expect(text(current).at(-1)).toBe('  Two agents are working.')
  })

  it('shows each tool as it runs, and the whole reason when one fails', () => {
    let current = youSaid(emptyTranscript(), 'run the tests in the tests terminal', 0)
    current = fromThinker(
      current,
      { type: 'tool', id: 't1', tool: 'wilco_terminal_run', input: { command: 'pnpm test' } },
      1,
    )
    expect(text(current).at(-1)).toMatch(/^ {2}\S terminal run · "pnpm test"$/)
    current = fromThinker(
      current,
      {
        type: 'tool_done',
        id: 't1',
        ok: false,
        text: 'which terminal? tests, server — say its name, or its number, so I type into the right one',
      },
      2,
    )
    const lines = text(current, 50)
    expect(lines).toContain('  ✗ terminal run · "pnpm test"')
    // Wrapped, not cut: the end of the reason is usually the part that matters.
    expect(lines.join(' ')).toContain('so I type into the right one')
  })

  it('says the orchestrator stopped, and why, instead of going quiet', () => {
    let current = thinking(youSaid(emptyTranscript(), 'status', 0), 0)
    current = fromThinker(current, { type: 'tool', id: 't1', tool: 'wilco_status', input: {} }, 1)
    current = fromThinker(current, { type: 'failed', reason: 'Model "x" not found' }, 2)
    current = fromThinker(current, { type: 'exited', code: 1 }, 2)
    expect(current.thinking).toBeNull()
    const lines = text(current).join('\n')
    expect(lines).toContain('! The orchestrator stopped: Model "x" not found')
    expect(lines).toContain('✗ status')
  })

  it("routes Wilco's own commands visibly, and does not repeat the orchestrator's answer", () => {
    const grammar = fromTurn(youSaid(emptyTranscript(), 'park the stripe one', 0), {
      utterance: 'park the stripe one',
      intent: 'park',
      task: 'checkout/stripe-v15',
      why: 'you mentioned it last',
      reply: 'Parked stripe-v15.',
      at: 1,
    })
    expect(text(grammar)).toEqual([
      '❯ park the stripe one',
      '  → park · checkout/stripe-v15 · "you mentioned it last"',
      '  Parked stripe-v15.',
    ])

    let free = youSaid(emptyTranscript(), 'why is refunds slow?', 0)
    free = fromThinker(free, { type: 'message', text: 'It is waiting on CI.' }, 1)
    free = fromTurn(free, {
      utterance: 'why is refunds slow?',
      intent: 'free',
      reply: 'It is waiting on CI.',
      at: 2,
    })
    expect(text(free).filter((line) => line.includes('waiting on CI'))).toHaveLength(1)

    // Nothing from the orchestrator at all: the reply is the only explanation.
    const unanswered = fromTurn(youSaid(emptyTranscript(), 'hello', 0), {
      utterance: 'hello',
      intent: 'free',
      reply: 'The orchestrator is still starting.',
      at: 1,
    })
    expect(text(unanswered).at(-1)).toBe('  The orchestrator is still starting.')
  })

  it('offers a suggestion as something to click', () => {
    const offered = suggest(
      emptyTranscript(),
      'Sentry has 3 new issues in wilco',
      'look at them',
      0,
    )
    const [line] = transcriptLines(offered, 60, PLAIN, pointer, 0)
    expect(line?.text).toContain('[ ask ]')
    expect(line?.hits.some((hit) => hit.target.kind === 'action')).toBe(true)
  })

  it('makes links in answers and problems clickable', () => {
    const said = problem(emptyTranscript(), 'see https://sentry.io/issues/1/', 0)
    const [line] = transcriptLines(said, 60, PLAIN, pointer, 0)
    expect(line?.hits).toContainEqual(
      expect.objectContaining({ target: { kind: 'link', url: 'https://sentry.io/issues/1/' } }),
    )
  })

  it('keeps every line its width, and a bounded history', () => {
    let current = emptyTranscript()
    for (let i = 0; i < TRANSCRIPT_MAX + 10; i++)
      current = youSaid(current, `said ${i} `.repeat(9), 0)
    expect(current.entries).toHaveLength(TRANSCRIPT_MAX)
    for (const line of transcriptLines(current, 23, PLAIN, pointer, 0)) {
      expect(visibleWidth(line.text)).toBe(23)
      expect(stripTerminalSequences(line.text)).not.toContain('\n')
    }
  })
})

describe('what a tool was used on', () => {
  it('is the few arguments that name it', () => {
    expect(toolDetail({ project: 'wilco', command: 'pnpm test', lines: 50 })).toBe(
      'wilco · "pnpm test" · lines 50',
    )
    expect(toolDetail({ text: 'x'.repeat(80) })).toMatch(/…$/)
    expect(toolDetail(null)).toBe('')
  })
})

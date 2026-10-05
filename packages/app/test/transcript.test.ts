import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { PLAIN } from '../src/skin.ts'
import {
  emptyTranscript,
  fromThinker,
  fromTurn,
  interrupted,
  problem,
  said,
  suggest,
  TRANSCRIPT_MAX,
  type Transcript,
  tadeDid,
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
    expect(text(current).at(-1)).toBe('◆ Two agents are working▍')
    current = fromThinker(current, { type: 'message', text: 'Two agents are working.' }, 3)
    // Still its turn: it may reach for a tool next.
    expect(text(current).at(-1)).toMatch(/thinking$/)
    current = fromThinker(current, { type: 'idle' }, 4)
    expect(text(current).at(-1)).toBe('◆ Two agents are working.')
  })

  it('shows each tool as it runs, and the whole reason when one fails', () => {
    let current = youSaid(emptyTranscript(), 'run the tests in the tests terminal', 0)
    current = fromThinker(
      current,
      { type: 'tool', id: 't1', tool: 'tade_terminal_run', input: { command: 'pnpm test' } },
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
    current = fromThinker(current, { type: 'tool', id: 't1', tool: 'tade_status', input: {} }, 1)
    current = fromThinker(current, { type: 'failed', reason: 'Model "x" not found' }, 2)
    current = fromThinker(current, { type: 'exited', code: 1 }, 2)
    expect(current.thinking).toBeNull()
    const lines = text(current).join('\n')
    expect(lines).toContain('✗ The orchestrator stopped: Model "x" not found')
    expect(lines).toContain('✗ status')
  })

  it('says why the model would not answer, once, while the orchestrator keeps going', () => {
    let current = thinking(youSaid(emptyTranscript(), 'change your model to opus 5', 0), 0)
    const refused = {
      type: 'error',
      reason: 'Mid-conversation reasoning effort is not supported (400)',
    } as const
    current = fromThinker(current, refused, 1)
    current = fromThinker(current, refused, 2)
    const lines = text(current, 120).join('\n')
    expect(lines).toContain(
      '✗ The orchestrator could not answer: Mid-conversation reasoning effort is not supported (400)',
    )
    expect(lines.split('could not answer').length).toBe(2)
    expect(current.thinking).not.toBeNull()
    expect(fromThinker(current, { type: 'idle' }, 3).thinking).toBeNull()
  })

  it("routes Tade's own commands visibly, and does not repeat the orchestrator's answer", () => {
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
      '● Parked stripe-v15.',
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
    expect(text(unanswered).at(-1)).toBe('● The orchestrator is still starting.')
  })

  it('shows a brief once, however it was asked for', () => {
    let current = youSaid(emptyTranscript(), 'brief me', 0)
    current = suggest(
      said(current, 'Morning. Nothing running.', 1),
      'Sentry has 1 new issue',
      'look',
      1,
    )
    current = fromTurn(current, {
      utterance: 'brief me',
      intent: 'brief',
      reply: 'Morning. Nothing running.',
      at: 2,
    })
    expect(text(current).filter((line) => line.includes('Morning.'))).toHaveLength(1)
  })

  it('shows what Tade itself did, once, and how to read it all before anything is said', () => {
    expect(text(emptyTranscript())[0]).toContain('❯ what you say')
    let current = tadeDid(emptyTranscript(), 'opened tade/agent-1 where it left off', 0)
    current = tadeDid(current, 'opened tade/agent-1 where it left off', 1)
    expect(text(current)).toEqual(['● opened tade/agent-1 where it left off'])
  })

  it('offers a suggestion as something to click', () => {
    const offered = suggest(emptyTranscript(), 'Sentry has 3 new issues in tade', 'look at them', 0)
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

describe('a turn that said nothing', () => {
  /** A turn that calls a tool, gets its answer, and then just ends. */
  function quietTurn(tool = 'tade_status'): Transcript {
    let current = thinking(youSaid(emptyTranscript(), 'where are we', 0), 0)
    current = fromThinker(current, { type: 'tool', id: '1', tool, input: {} }, 1)
    current = fromThinker(current, { type: 'tool_done', id: '1', ok: true, text: '' }, 2)
    return current
  }

  it('cannot end with nothing said after a tool call', () => {
    // The worst failure the conversation has: a tool that worked is the most
    // convincing possible picture of a model still thinking, so until this
    // was said the person waited on a spinner that had already stopped and
    // then asked again for something that had already happened.
    let current = quietTurn()
    current = fromThinker(current, { type: 'quiet', tool: 'tade_status' }, 3)
    current = fromThinker(current, { type: 'idle' }, 3)
    // Read wide, so the one sentence is one line to assert on.
    const lines = text(current, 200).join('\n')
    expect(lines).toContain('ran status and ended the turn without saying anything')
    // The half the person cannot get from a spinner.
    expect(lines).toContain('is not still thinking')
    expect(current.thinking).toBeNull()
    // And the answer is a click away rather than a question to retype.
    const asking = transcriptLines(current, 80, PLAIN, pointer, 0).find((line) =>
      line.hits.some((hit) => hit.target.kind === 'action'),
    )
    expect(asking?.hits[0]?.target).toMatchObject({
      name: expect.stringContaining('what did it answer'),
    })
  })

  it('is not reported when the turn said something after its last tool call', () => {
    // A "done" after every tool call is a sentence nobody can trust, which is
    // worse than the silence it replaces.
    let current = quietTurn()
    current = fromThinker(current, { type: 'message', text: 'Nothing is running.' }, 3)
    current = fromThinker(current, { type: 'idle' }, 3)
    expect(text(current, 200).join('\n')).not.toContain('without saying anything')
  })

  it('is still reported when the words came before the tool call', () => {
    // "Let me look at that" and then three tool calls and nothing is the same
    // failure as silence from the start: what was said does not answer what
    // the tools found, and the person watching cannot tell the two apart.
    let current = thinking(youSaid(emptyTranscript(), 'plan the refunds work', 0), 0)
    current = fromThinker(current, { type: 'message', text: 'Let me plan that.' }, 1)
    current = fromThinker(current, { type: 'tool', id: '1', tool: 'tade_plan', input: {} }, 2)
    current = fromThinker(current, { type: 'quiet', tool: 'tade_plan' }, 3)
    expect(text(current, 200).join('\n')).toContain(
      'ran plan and ended the turn without saying anything',
    )
  })

  it('is reported even where a tool call is the only thing on screen', () => {
    // What used to happen here: `fromTurn` counted a tool line as an answer,
    // so a turn whose whole visible output was one tool call reached the end
    // of the exchange looking answered and nothing was ever said about it.
    const settled = fromTurn(quietTurn(), {
      utterance: 'where are we',
      intent: 'free',
      reply: '',
      task: null,
      why: null,
      at: 3,
    })
    expect(text(settled, 200).join('\n')).toContain('without saying anything')
    expect(settled.thinking).toBeNull()
  })
})

describe('a turn you stopped', () => {
  it('keeps everything it said, and stops saying it is thinking', () => {
    let current = thinking(youSaid(emptyTranscript(), 'run the webhook tests', 0), 0)
    current = fromThinker(current, { type: 'delta', text: 'looking at the retries' }, 1)
    const stopped = interrupted(current)
    expect(stopped.thinking).toBeNull()
    expect(text(stopped, 60, 9_000).join('\n')).toContain('looking at the retries')
    expect(text(stopped, 60, 9_000).join('\n')).not.toContain('thinking')
  })

  it('never leaves a tool claiming to still be running', () => {
    let current = thinking(youSaid(emptyTranscript(), 'run the webhook tests', 0), 0)
    current = fromThinker(
      current,
      { type: 'tool', id: '1', tool: 'tade_terminal_run', input: {} },
      1,
    )
    const stopped = interrupted(current)
    expect(stopped.entries.at(-1)).toMatchObject({
      kind: 'tool',
      state: 'failed',
      result: 'you stopped it before it answered',
    })
  })

  // The one line that would be a lie: it did not go quiet, you stopped it.
  it('is not reported as the orchestrator finishing without saying anything', () => {
    const stopped = interrupted(thinking(youSaid(emptyTranscript(), 'status', 0), 0))
    const settled = fromTurn(stopped, {
      utterance: 'status',
      intent: 'free',
      at: 2,
      reply: '',
      task: null,
      why: null,
    })
    expect(text(settled).join('\n')).not.toContain('without saying anything')
    // And the next thing you say clears it, so a real silence is still reported.
    const again = thinking(youSaid(settled, 'and now?', 3), 3)
    expect(again.stopped).toBe(false)
    const quiet = fromTurn(again, {
      utterance: 'and now?',
      intent: 'free',
      at: 4,
      reply: '',
      task: null,
      why: null,
    })
    expect(text(quiet).join('\n')).toContain('without saying anything')
  })

  it('says escape stops it, where the harness says it can be stopped', () => {
    const asked = thinking(youSaid(emptyTranscript(), 'status', 0), 0)
    const stoppable = transcriptLines(asked, 60, PLAIN, pointer, 3_000, [], true)
    expect(stoppable.at(-1)?.text).toContain('esc stops it')
    expect(text(asked, 60, 3_000).at(-1)).not.toContain('esc stops it')
  })
})

describe('what a tool was used on', () => {
  it('is the few arguments that name it', () => {
    expect(toolDetail({ project: 'tade', command: 'pnpm test', lines: 50 })).toBe(
      'tade · "pnpm test" · lines 50',
    )
    expect(toolDetail({ text: 'x'.repeat(80) })).toMatch(/…$/)
    expect(toolDetail(null)).toBe('')
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  historyLine,
  joinReplies,
  sessionIdFor,
  spentIn,
  toolOf,
  turnIn,
  turnSpend,
} from '../src/record.ts'

// Grok's record of a session (`updates.jsonl`), read the way the adapter reads
// it: what was spent, whether a turn is under way, and what was said. The
// fixtures were written by Grok 1.0.92 itself, against a scripted model, with
// the paths taken out.

/** Grok files a session under its directory URL-encoded, which a file URL may not hold: joined. */
const SESSIONS = join(
  fileURLToPath(new URL('../../../../test/fixtures/transcripts/grok/1.0', import.meta.url)),
  '%2Fwork%2Fsearch',
)
const read = (id: string) => readFileSync(join(SESSIONS, id, 'updates.jsonl'), 'utf8')
const IDLE = read('01a2fa11-0000-7000-8000-0000000000a1')
const RETRYING = read('01a2fa11-0000-7000-8000-0000000000b2')
const GATED = read('11111111-2222-4333-8444-555555555558')

describe('a session’s id', () => {
  it('is a UUID made from the task, the same every time, and another for another task', () => {
    expect(sessionIdFor('app/refunds')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(sessionIdFor('app/refunds')).toBe(sessionIdFor('app/refunds'))
    expect(sessionIdFor('app/refunds')).not.toBe(sessionIdFor('app/search'))
  })
})

describe('what a session spent', () => {
  it('is what each completed turn says it used, with the cached prompt taken out of the input', () => {
    // Two model calls of a thousand prompt tokens each, two hundred of them cached.
    expect(spentIn(GATED)).toMatchObject({
      input: 1600,
      cacheRead: 400,
      output: 100,
      tokens: 2100,
      messages: 1,
      model: 'fake-model',
      usd: 0,
    })
  })

  it('counts nothing for a turn that never completed', () => {
    expect(spentIn(RETRYING).tokens).toBe(0)
  })

  it('counts reasoning as output, once, and dollars in xAI’s ticks', () => {
    expect(
      turnSpend({
        inputTokens: 1000,
        cachedReadTokens: 100,
        outputTokens: 50,
        reasoningTokens: 200,
        totalTokens: 1250,
        costUsdTicks: 12_500_000_000,
        primaryModelId: 'grok-4.6',
      }),
    ).toEqual({
      input: 900,
      output: 250,
      cacheRead: 100,
      cacheWrite: 0,
      tokens: 1250,
      usd: 1.25,
      model: 'grok-4.6',
    })
    // Where the output already holds it, it is not counted twice.
    expect(turnSpend({ inputTokens: 1000, outputTokens: 250, totalTokens: 1250 }).output).toBe(250)
  })
})

describe('whether a turn is under way', () => {
  it('is not, after a completed turn, or once the session has ended', () => {
    expect(turnIn(IDLE)).toBeNull()
    // Its last words were stopped with Ctrl+C, and then the session closed.
    expect(turnIn(GATED)).toBeNull()
  })

  it('is, since its words were sent, while it waits on a model it is retrying', () => {
    const under = turnIn(RETRYING)
    expect(under).not.toBeNull()
    expect(under?.since).toBeGreaterThan(Date.parse('2026-01-01'))
  })
})

describe('what was said', () => {
  const items = (text: string) =>
    joinReplies(
      text
        .split('\n')
        .map((line) => historyLine(line))
        .flatMap((line) => line?.items ?? []),
    )

  it('reads what was sent, the tool it reached for and what it said back, and nothing of its bookkeeping', () => {
    const said = items(GATED)
    expect(said.map((item) => item.kind)).toEqual(['sent', 'tool', 'reply', 'sent'])
    expect(said[0]).toMatchObject({ kind: 'sent', text: 'first prompt', images: [] })
    expect(said[1]).toMatchObject({
      kind: 'tool',
      id: 'call_1',
      tool: 'run_terminal_command',
      input: { command: 'echo DENYME', description: 'try' },
    })
    expect(said[2]).toMatchObject({ kind: 'reply', text: 'Finished here.' })
  })

  it('says a refused call failed, with what Grok told the model', () => {
    const answers = GATED.split('\n').flatMap((line) => historyLine(line)?.results ?? [])
    expect(answers).toEqual([{ id: 'call_1', ok: false, result: 'Hook denied: refused in Tade' }])
  })

  it('puts a reply that streamed in pieces back together', () => {
    const piece = (text: string) =>
      JSON.stringify({
        timestamp_us: 1_795_579_923_000_000,
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        },
      })
    const lines = [piece('Hello, '), piece('world.')]
    expect(items(lines.join('\n'))).toEqual([
      { kind: 'reply', text: 'Hello, world.', at: 1_795_579_923_000 },
    ])
  })

  it('names one of Tade’s own tools by its name, out of Grok’s use_tool', () => {
    expect(
      toolOf('use_tool', { tool_name: 'tade__tade_done', tool_input: { summary: 'x' } }),
    ).toEqual({ tool: 'tade_done', input: { summary: 'x' } })
    expect(toolOf('read_file', { target_file: 'a' })).toEqual({
      tool: 'read_file',
      input: { target_file: 'a' },
    })
  })

  it('reads nothing out of a line it does not know', () => {
    expect(historyLine('not json')).toBeNull()
    expect(historyLine('{"method":"session/update","params":{}}')).toBeNull()
  })
})

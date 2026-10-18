import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import {
  answerOf,
  append,
  conversationKey,
  emptyRecorded,
  fold,
  historyOf,
  linesIn,
  recordedIn,
  recordPath,
  spendOf,
} from '../src/record.ts'

// The record a lane writes of an ACP conversation, read the way every
// provider's transcript is: a fold over its lines, a line in a shape it does
// not know skipped, nothing thrown. The fixtures are version 1 of the record,
// written by the lane against the scripted agent and cut down by hand.

const FIXTURES = join(import.meta.dirname, '../../../../test/fixtures/transcripts/acp/1')
const fixture = (name: string) => join(FIXTURES, name)

describe('the record of an ACP conversation', () => {
  it('says which agent and session the conversation is in, and what it cost', async () => {
    const recorded = await recordedIn(fixture('conversation.jsonl'))
    expect(recorded.agent).toBe('gemini')
    expect(recorded.sessionId).toBe('sess-1')
    // Cost is the session's total so far: the last figure, never the sum of them.
    expect(spendOf(recorded)).toMatchObject({
      usd: 0.05,
      messages: 2,
      tokens: 0,
      model: 'gemini/default',
    })
  })

  it('adds up sessions, keeps a resumed one on its model, and counts dollars only', async () => {
    const recorded = await recordedIn(fixture('moved.jsonl'))
    expect(recorded.sessionId).toBe('ses_b')
    // A new session starts on the agent's own model.
    expect(recorded.model).toBeNull()
    const spend = spendOf(recorded)
    expect(spend.usd).toBeCloseTo(0.3)
    expect(spend.messages).toBe(3)
    // The resumed session kept the model chosen before it.
    const resumed = fold(
      emptyRecorded(),
      [...linesIn(readFileSync(fixture('moved.jsonl'), 'utf8'))].slice(0, 8),
    )
    expect(resumed.model).toBe('anthropic/claude-sonnet-5')
  })

  it('reads nothing out of lines it does not recognise, and never throws on them', async () => {
    expect([...linesIn(readFileSync(fixture('unrecognised.jsonl'), 'utf8'))]).toEqual([])
    const recorded = await recordedIn(fixture('unrecognised.jsonl'))
    expect(recorded.sessionId).toBeNull()
    expect(spendOf(recorded).messages).toBe(0)
  })

  it('is no conversation and nothing spent when there is no record yet', async () => {
    const recorded = await recordedIn(join(tmp('tade-acp-none-'), 'nothing.jsonl'))
    expect(recorded).toEqual(emptyRecorded())
    expect(spendOf(recorded)).toMatchObject({ usd: 0, messages: 0, model: null })
  })

  it('answers what reading from the start answers, however the lines are cut into runs', () => {
    for (const name of ['conversation.jsonl', 'moved.jsonl', 'unrecognised.jsonl']) {
      const lines = [...linesIn(readFileSync(fixture(name), 'utf8'))]
      const whole = fold(emptyRecorded(), lines)
      for (let cut = 0; cut <= lines.length; cut++) {
        const first = fold(emptyRecorded(), lines.slice(0, cut))
        expect(fold(first, lines.slice(cut)), `${name} cut at ${cut}`).toEqual(whole)
      }
    }
  })

  it('pages history by exchange, with each tool and its answer together', async () => {
    const page = await historyOf(fixture('conversation.jsonl'), { limit: 20 })
    expect(page.earlier).toBeNull()
    expect(page.items.map((item) => item.kind)).toEqual(['sent', 'tool', 'tool', 'reply'])
    expect(page.items[0]).toMatchObject({ kind: 'sent', text: 'fix the flaky login test' })
    expect(page.items[1]).toMatchObject({ kind: 'tool', tool: 'read', ok: true })
    expect(page.items[2]).toMatchObject({
      kind: 'tool',
      tool: 'execute',
      ok: false,
      result: '1 failed',
    })
    expect(page.items[3]).toMatchObject({
      kind: 'reply',
      text: 'The test waits on a timer it never advances.',
    })
  })

  it("keeps a call's whole answer, however long, and hands it back by the call", async () => {
    const path = recordPath(join(tmp('tade-acp-record-'), 'runs'), 'proj/fix-login')
    const long = Array.from({ length: 5_000 }, (_, n) => `ok ${n}`).join('\n')
    append(path, { type: 'sent', at: 1, text: 'run them' })
    append(path, {
      type: 'tool',
      at: 2,
      id: 'call-1',
      tool: 'execute',
      title: 'pnpm test',
      input: {},
    })
    append(path, { type: 'tool_result', at: 3, id: 'call-1', ok: true, result: long })
    expect(await answerOf(path, 'call-1')).toEqual({ ok: true, result: long })
    expect(await answerOf(fixture('conversation.jsonl'), 'call-2')).toEqual({
      ok: false,
      result: '1 failed',
    })
    expect(await answerOf(path, 'call-9')).toBeNull()
  })

  it('is written where Tade keeps its own files, one line at a time, readable back', async () => {
    const home = tmp('tade-acp-record-')
    const path = recordPath(join(home, 'runs'), 'proj/fix-login')
    expect(path.startsWith(join(home, 'runs', 'acp'))).toBe(true)
    expect(path).toContain(conversationKey('proj/fix-login'))
    append(path, { type: 'session', at: 1, agent: 'goose', sessionId: 's', resumed: false })
    append(path, { type: 'sent', at: 2, text: 'hello\nthere' })
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"v":1,"type":"reply","at":3,"te`, 'utf8')
    const recorded = await recordedIn(path)
    expect(recorded.agent).toBe('goose')
    const page = await historyOf(path, { limit: 5 })
    // A line half-written when the lane was killed is skipped, not thrown over.
    expect(page.items).toEqual([{ kind: 'sent', text: 'hello\nthere', images: [], at: 2 }])
  })
})

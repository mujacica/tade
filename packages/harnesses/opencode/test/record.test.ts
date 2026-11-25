import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  answerOf,
  compactionOf,
  type Exported,
  exportedIn,
  firstSaid,
  historyOf,
  lastOutcome,
  renamedTo,
  sessionIdFor,
  spentIn,
  toolName,
  turnIn,
} from '../src/record.ts'

// OpenCode's own record of a session, as `opencode session export` printed it
// in OpenCode 2.4.1 for a lane of Tade's against a scripted model: a call
// Tade refused (`refused`), a turn stopped and one after it (`stopped`), and
// a turn still waiting on its model (`running`). Paths are `/work`.

const FIXTURES = fileURLToPath(
  new URL('../../../../test/fixtures/transcripts/opencode/2.4.1/', import.meta.url),
)
const fixture = (name: string): Exported => {
  const read = exportedIn(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
  if (!read) throw new Error(`${name} is not an export`)
  return read
}
const noPlan = () => false

describe('reading what OpenCode exported', () => {
  it('names a task’s session the same way every time, as OpenCode takes one', () => {
    expect(sessionIdFor('app/x')).toBe(sessionIdFor('app/x'))
    expect(sessionIdFor('app/x')).not.toBe(sessionIdFor('app/y'))
    expect(sessionIdFor('app/x')).toMatch(/^ses_[0-9a-z]{26}$/)
  })

  it('is null for anything that is not an export, and never throws', () => {
    for (const text of [
      '',
      'nope',
      '[]',
      '{}',
      '{"info":{},"messages":[]}',
      '{"info":{"id":"s"}}',
    ]) {
      expect(exportedIn(text)).toBeNull()
    }
    expect(spentIn(null, noPlan).messages).toBe(0)
    expect(historyOf(null, { limit: 5 })).toEqual({ items: [], earlier: null })
    expect(turnIn(null)).toBeNull()
    expect(answerOf(null, 'call_1')).toBeNull()
    expect(compactionOf(null, 'msg_c')).toBeNull()
  })

  it('says how a compaction it was asked for ended, by the id it was filed under', () => {
    const record = (compaction: Record<string, unknown>): Exported => ({
      info: { id: 'ses_x' },
      messages: [
        { id: 'msg_old', type: 'compaction', status: 'failed', error: { message: 'an old one' } },
        { id: 'msg_c', type: 'compaction', ...compaction },
      ],
    })
    expect(compactionOf(record({ status: 'completed', summary: '## Objective' }), 'msg_c')).toEqual(
      { done: true },
    )
    expect(
      compactionOf(
        record({ status: 'failed', error: { type: 'aborted', message: 'Compaction cancelled' } }),
        'msg_c',
      ),
    ).toEqual({ failed: 'Compaction cancelled' })
    expect(
      compactionOf(record({ status: 'failed', error: { type: 'compaction.failed' } }), 'msg_c'),
    ).toEqual({ failed: 'compaction.failed' })
    // Still running, or never filed: the record has no word of it.
    expect(compactionOf(record({ status: 'running' }), 'msg_c')).toBeNull()
    expect(compactionOf(record({ status: 'completed' }), 'msg_other')).toBeNull()
  })

  it('counts what every step used, cached input apart and reasoning with the output', () => {
    expect(spentIn(fixture('refused'), noPlan)).toEqual({
      input: 1600,
      output: 100,
      cacheRead: 400,
      cacheWrite: 0,
      tokens: 2100,
      usd: 0,
      messages: 2,
      model: 'tade-test/fake',
    })
    // A step that was stopped before its model answered used nothing.
    expect(spentIn(fixture('stopped'), noPlan)).toMatchObject({ tokens: 3150, messages: 3 })
  })

  it('keeps a plan’s steps out of the money and says how much a plan paid for', () => {
    const record = fixture('refused')
    const priced: Exported = {
      ...record,
      messages: record.messages.map((m, n) =>
        m.type !== 'assistant'
          ? m
          : n === 1
            ? { ...m, model: { providerID: 'openai', id: 'gpt-5.5' }, cost: 0 }
            : { ...m, model: { providerID: 'anthropic', id: 'claude-sonnet-5' }, cost: 0.25 },
      ),
    }
    const spent = spentIn(priced, (provider) => provider === 'openai')
    expect(spent.usd).toBe(0.25)
    expect(spent.tokens).toBe(2100)
    expect(spent.plan).toEqual({
      input: 800,
      output: 50,
      cacheRead: 200,
      cacheWrite: 0,
      tokens: 1050,
      messages: 1,
    })
    expect(spent.model).toBe('anthropic/claude-sonnet-5')
    expect(spentIn(record, noPlan).plan).toBeUndefined()
  })

  it('says a turn is under way only after something sent that no idle line closed', () => {
    expect(turnIn(fixture('refused'))).toBeNull()
    expect(turnIn(fixture('stopped'))).toBeNull()
    const running = turnIn(fixture('running'))
    expect(running?.since).toBeGreaterThan(0)
    expect(lastOutcome(fixture('refused'))).toBe('succeeded')
    expect(lastOutcome(fixture('running'))).toBeNull()
  })

  it('reads the conversation as it was had: what was sent, the tools and their answers, the replies', () => {
    const page = historyOf(fixture('refused'), { limit: 20 })
    expect(page.earlier).toBeNull()
    expect(page.items.map((item) => item.kind)).toEqual(['sent', 'tool', 'reply'])
    expect(page.items[0]).toMatchObject({ kind: 'sent', text: 'Write gated.txt', images: [] })
    expect(page.items[1]).toMatchObject({
      kind: 'tool',
      id: 'call_1',
      tool: 'shell',
      input: { command: 'echo hi > gated.txt', description: 'Write a file' },
      ok: false,
      result: 'not today',
    })
    expect(page.items[2]).toMatchObject({ kind: 'reply', text: 'Could not write it.' })
    expect(answerOf(fixture('refused'), 'call_1')).toEqual({ ok: false, result: 'not today' })
    expect(answerOf(fixture('stopped'), 'call_1')?.ok).toBe(true)
    expect(answerOf(fixture('stopped'), 'nobody')).toBeNull()
  })

  it('pages from the newest end, back to something sent, and on to the page before', () => {
    const record = fixture('stopped')
    const last = historyOf(record, { limit: 1 })
    expect(last.items.map((item) => item.kind)).toEqual(['sent', 'reply'])
    expect(last.items[0]).toMatchObject({ text: 'Say it again' })
    expect(last.earlier).not.toBeNull()
    const before = historyOf(record, { limit: 1, before: last.earlier })
    expect(before.items[0]).toMatchObject({ kind: 'sent', text: 'Think about it for a while' })
    const all = historyOf(record, { limit: 100 })
    expect(all.items.filter((item) => item.kind === 'sent')).toHaveLength(3)
    expect(historyOf(record, { limit: 5, before: 'nonsense' }).items).toEqual([])
  })

  it('names Tade’s own tools without their server, and every other as OpenCode does', () => {
    expect(toolName('tade_tade_done')).toBe('tade_done')
    expect(toolName('tade_checks_run')).toBe('checks_run')
    expect(toolName('shell')).toBe('shell')
  })

  it('says the first thing sent, and carries a record under another id whole', () => {
    const record = fixture('stopped')
    expect(firstSaid(record)).toBe('Write notes.txt')
    const moved = renamedTo(record, 'ses_tadeelsewhere0000000000000')
    expect(moved.info.id).toBe('ses_tadeelsewhere0000000000000')
    expect(JSON.stringify(moved)).not.toContain(String(record.info.id))
    expect(historyOf(moved, { limit: 100 })).toEqual(historyOf(record, { limit: 100 }))
  })
})

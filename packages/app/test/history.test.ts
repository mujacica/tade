import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { sessionPrompts } from '../src/wire/keyboard.ts'

// Lines typed before Tade journaled them are still in the orchestrator's pi
// sessions, which is where up and ctrl+r find them the first time.

describe('what was asked before the journal kept it', () => {
  it('is every user message in the sessions, oldest first, and nothing else', () => {
    const dir = join(tmp('tade-sessions-'), 'sessions')
    mkdirSync(dir, { recursive: true })
    const line = (role: string, content: unknown) =>
      JSON.stringify({ type: 'message', message: { role, content } })
    writeFileSync(
      join(dir, '2026-09-13T10-00-00Z_a.jsonl'),
      [
        JSON.stringify({ type: 'session', id: 'a' }),
        line('user', [{ type: 'text', text: 'where are we' }]),
        line('assistant', [{ type: 'text', text: 'All quiet.' }]),
        '{"type":"message","message":{"role":"user"',
      ].join('\n'),
    )
    writeFileSync(
      join(dir, '2026-09-14T09-00-00Z_b.jsonl'),
      line('user', [{ type: 'text', text: 'change both yours and agents model to opus5' }]),
    )
    expect(sessionPrompts(dir)).toEqual([
      'where are we',
      'change both yours and agents model to opus5',
    ])
    expect(sessionPrompts(join(dir, 'missing'))).toEqual([])
  })
})

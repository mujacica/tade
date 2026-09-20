import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { interruptedIn, sessionIdFor, spentIn, spentOn, transcriptFor } from '../src/transcript.ts'

const reply = (id: string, usage: Record<string, number>, model = 'claude-sonnet-5') =>
  JSON.stringify({ type: 'assistant', message: { id, model, usage } })

describe('a task’s conversation', () => {
  it('is a UUID Claude Code accepts, the same every time, and different for another task', () => {
    const id = sessionIdFor('app/refunds')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(sessionIdFor('app/refunds')).toBe(id)
    expect(sessionIdFor('app/refunds-2')).not.toBe(id)
  })

  it('is found by its name, wherever Claude Code filed it', async () => {
    const config = tmp('tade-claude-cfg-')
    expect(await transcriptFor('app/refunds', config)).toBeNull()
    const dir = join(config, 'projects', '-some-encoded-cwd')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionIdFor('app/refunds')}.jsonl`), '')
    expect(await transcriptFor('app/refunds', config)).toBe(
      join(dir, `${sessionIdFor('app/refunds')}.jsonl`),
    )
  })
})

describe('what a transcript spent', () => {
  it('counts a reply once, though Claude Code writes a line for each of its parts', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 40,
    }
    const spent = spentIn(
      [
        reply('m1', usage),
        reply('m1', usage),
        reply('m2', { input_tokens: 1, output_tokens: 2 }),
      ].join('\n'),
    )
    expect(spent).toMatchObject({
      input: 11,
      output: 22,
      cacheRead: 300,
      cacheWrite: 40,
      tokens: 373,
      messages: 2,
      model: 'claude-sonnet-5',
      // It records no price, and none is made up.
      usd: 0,
    })
  })

  it('counts nothing for a reply it made up itself, nor for a line it cannot read', () => {
    const spent = spentIn(
      [
        reply('m1', { input_tokens: 5 }, '<synthetic>'),
        '{"type":"assistant","message":',
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      ].join('\n'),
    )
    expect(spent.messages).toBe(0)
  })

  it('is nothing for a task with no transcript', async () => {
    expect((await spentOn('app/none', tmp('tade-claude-cfg-'))).tokens).toBe(0)
  })
})

describe('a turn cut short', () => {
  it('is read from the transcript, where Claude Code says it and nowhere else', () => {
    const cut = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    })
    expect(interruptedIn([reply('m1', {}), cut].join('\n'))).toBe(true)
    expect(interruptedIn([cut, reply('m2', {})].join('\n'))).toBe(false)
    expect(interruptedIn('')).toBe(false)
  })
})

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter } from '../src/adapter.ts'
import {
  historyLine,
  interruptedIn,
  sessionIdFor,
  spentIn,
  spentOn,
  transcriptFor,
  turnIn,
} from '../src/transcript.ts'

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

describe('a turn under way', () => {
  const recorded = (name: string) =>
    readFileSync(
      fileURLToPath(
        new URL(`../../../../test/fixtures/transcripts/claude-code/2.1/${name}`, import.meta.url),
      ),
      'utf8',
    )

  it('is read from the end of the transcript, since the words that began it', () => {
    expect(turnIn(recorded('idle.jsonl'))).toBeNull()
    // A subagent's reply that ended is its side conversation, not this turn.
    expect(turnIn(recorded('mid-tool.jsonl'))).toEqual({
      since: Date.parse('2026-09-11T10:00:00.000Z'),
    })
    expect(turnIn('')).toBeNull()
  })

  it('is over once somebody cut it short, behind its bookkeeping and a line still being written', () => {
    expect(turnIn(recorded('orchestrator.jsonl'))).toBeNull()
  })
})

// The orchestrator's own conversation as Claude Code 2.1 records it, in the
// shapes it really writes — its bookkeeping lines, a subagent's side
// conversation, its own commands, a turn cut short and a last line still
// being written — so what comes back is what was said and nothing else.
const RECORDED = fileURLToPath(
  new URL(
    '../../../../test/fixtures/transcripts/claude-code/2.1/orchestrator.jsonl',
    import.meta.url,
  ),
)

describe('a conversation read back', () => {
  it('is what was sent, what it said and the tools it called, in order, out of its own record', async () => {
    const config = tmp('tade-claude-cfg-')
    const dir = join(config, 'projects', '-work-shop')
    mkdirSync(dir, { recursive: true })
    copyFileSync(RECORDED, join(dir, `${sessionIdFor('tade/orchestrator')}.jsonl`))
    const adapter = new ClaudeAdapter({
      runDir: tmp('tcc-'),
      configDir: config,
      home: tmp('tcc-home-'),
    })

    const page = await adapter.history('tade/orchestrator', '/work/shop', { limit: 100 })
    expect(page.earlier).toBeNull()
    expect(
      page.items.map((item) =>
        item.kind === 'tool'
          ? ['tool', item.tool, item.ok, item.result]
          : [item.kind, item.text.split('\n').at(-1)],
      ),
    ).toEqual([
      ['sent', 'what is running?'],
      // One of Tade's own tools, by the name Tade gave it.
      ['tool', 'tade_status', true, ''],
      ['reply', 'Two agents are working in **shop**: `search` and `refunds`.'],
      ['sent', 'Tell the person what it found.'],
      ['tool', 'Bash', false, 'fatal: not a git repository'],
      ['reply', 'That repository has no history yet, so there is nothing to review.'],
      ['sent', 'stop the flaky agent'],
      ['reply', 'A paired device can only read, so I cannot stop it from there.'],
      ['sent', 'what is wrong here?'],
      // Cut short before it answered, which is all that is known about it.
      ['tool', 'Read', null, ''],
    ])
    const first = page.items[0]
    expect(first?.kind === 'sent' && first.text.startsWith('Since you last heard from Tade:')).toBe(
      true,
    )
    const tool = page.items[1]
    expect(tool?.kind === 'tool' && tool.input).toEqual({ project: 'shop' })
    // The picture it was pointed at is the picture, not words of the message.
    const pictured = page.items[8]
    expect(pictured).toMatchObject({
      kind: 'sent',
      text: 'What they said:\nwhat is wrong here?',
      images: ['/tmp/orchestrator/attachments/1791-1.png'],
    })
    expect(page.items.every((item) => item.at > Date.UTC(2026, 9, 12))).toBe(true)
  })

  it('has nothing for a task it never talked in, and null for a line that is not the conversation', async () => {
    const adapter = new ClaudeAdapter({
      runDir: tmp('tcc-'),
      configDir: tmp('tade-claude-cfg-'),
      home: tmp('tcc-home-'),
    })
    expect(await adapter.history('tade/orchestrator', '/work', { limit: 10 })).toEqual({
      items: [],
      earlier: null,
    })
    expect(historyLine('{"type":"cost-state","totalCostUSD":1}')).toBeNull()
    expect(historyLine('[1,2]')).toBeNull()
    expect(historyLine('{"type":"user"}')).toBeNull()
    expect(historyLine('not json')).toBeNull()
  })
})

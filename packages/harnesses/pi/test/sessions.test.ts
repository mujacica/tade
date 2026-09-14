import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { sessionIdFor } from '../src/adapter.ts'
import { sessionFileFor, usageOf, usageOfTask } from '../src/sessions.ts'

// Reading an agent's spend out of the harness's own session file, which is the
// record that survives Wilco being closed.
//
// The files here are written by hand rather than by a real agent: what is under
// test is that we read a private format defensively, and a fabricated file can
// contain the shapes a real one would take years to produce. Every entry is
// shaped the way pi writes it — a reply's usage on its message, a summary's on
// the entry — copied from a real session: a fixture that put usage anywhere
// kinder once let Wilco count compactions and not one reply.

/** Write a session where the harness would put one for this cwd. */
function writeSession(root: string, cwd: string, task: string, lines: unknown[]): string {
  const dir = join(root, `-${cwd.replace(/\//g, '-')}-`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `2026-09-13T04-14-42-404Z_${sessionIdFor(task)}.jsonl`)
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return path
}

const usage = (input: number, output: number, usd: number, cacheRead = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: input + output + cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd },
})

/** A reply, as pi writes one. */
const priced = (input: number, output: number, usd: number, cacheRead = 0) => ({
  type: 'message',
  id: 'a1b2c3d4',
  parentId: 'e5f6a7b8',
  timestamp: '2026-09-14T07:25:44.133Z',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'Done.' }],
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'moonshotai/kimi-k2.6',
    usage: usage(input, output, usd, cacheRead),
    stopReason: 'stop',
    timestamp: 1789370742438,
  },
})

describe('reading a task’s session', () => {
  it('finds the file by the session id, whatever the directory is called', async () => {
    const root = tmp('pi-sessions-')
    const written = writeSession(root, '/src/app-refunds', 'app/refunds', [priced(10, 5, 0.01)])
    expect(await sessionFileFor('app/refunds', { root })).toBe(written)
  })

  it('has nothing to say about a task that has never run', async () => {
    const root = tmp('pi-sessions-')
    expect(await sessionFileFor('app/ghost', { root })).toBeNull()
    expect(await usageOfTask('app/ghost', { root })).toMatchObject({ messages: 0, tokens: 0 })
  })

  it('sums every priced message', async () => {
    const root = tmp('pi-sessions-')
    writeSession(root, '/src/app-refunds', 'app/refunds', [
      { type: 'session', version: 3, id: 'wilco-app-refunds', cwd: '/src/app-refunds' },
      priced(100, 20, 0.03),
      { type: 'message', message: { role: 'user', content: 'go on', timestamp: 1 } },
      priced(50, 10, 0.02),
    ])
    const usage = await usageOfTask('app/refunds', { root })
    expect(usage).toMatchObject({ input: 150, output: 30, tokens: 180, messages: 2 })
    expect(usage.usd).toBeCloseTo(0.05)
    expect(usage.model).toBe('openrouter/moonshotai/kimi-k2.6')
  })

  it('counts what pi counts, and so agrees with the footer of the agent', async () => {
    const root = tmp('pi-sessions-')
    const path = writeSession(root, '/src/app-costly', 'app/costly', [
      { type: 'model_change', provider: 'openrouter', modelId: 'moonshotai/kimi-k2.6' },
      // Most of what a long session costs is reading its own cache back.
      priced(4_368, 63, 0.0046, 1_520),
      {
        type: 'message',
        message: { role: 'toolResult', toolName: 'read', content: [], isError: false },
      },
      // A tool that ran a model of its own says so on its result.
      {
        type: 'message',
        message: { role: 'toolResult', toolName: 'ask', content: [], usage: usage(10, 5, 0.001) },
      },
      // Compacting is a model writing a summary, and is paid for like one.
      {
        type: 'compaction',
        summary: 'what happened so far',
        firstKeptEntryId: 'ca71eb30',
        tokensBefore: 257_982,
        usage: usage(31_879, 11_681, 0.077, 48),
        fromHook: false,
      },
      {
        type: 'branch_summary',
        fromId: 'x',
        summary: 'the other branch',
        usage: usage(7, 3, 0.0005),
      },
      // Usage anywhere pi does not put it is not usage.
      { type: 'message', usage: usage(1_000_000, 0, 100) },
      { type: 'custom', customType: 'notes', data: { usage: usage(1_000_000, 0, 100) } },
    ])
    const spent = await usageOf(path)
    expect(spent).toMatchObject({
      input: 4_368 + 10 + 31_879 + 7,
      output: 63 + 5 + 11_681 + 3,
      cacheRead: 1_520 + 48,
      messages: 4,
    })
    expect(spent.tokens).toBe(spent.input + spent.output + spent.cacheRead)
    expect(spent.usd).toBeCloseTo(0.0046 + 0.001 + 0.077 + 0.0005)
  })

  it('reads a session that is being written to right now', async () => {
    const root = tmp('pi-sessions-')
    const path = writeSession(root, '/src/app-live', 'app/live', [priced(10, 5, 0.01)])
    // A live session's last line is whatever made it to disk so far. Skipping
    // it is right; throwing over it would lose the whole file's accounting.
    writeFileSync(path, `${JSON.stringify(priced(10, 5, 0.01))}\n{"type":"mess`)
    expect(await usageOf(path)).toMatchObject({ messages: 1, tokens: 15 })
  })

  it('counts nothing rather than guessing when the shapes are unfamiliar', async () => {
    const root = tmp('pi-sessions-')
    const path = writeSession(root, '/src/app-odd', 'app/odd', [
      { type: 'message', message: { role: 'assistant', usage: { input: 'lots', cost: 'free' } } },
      { type: 'message', message: { role: 'assistant', usage: null } },
      { type: 'compaction', usage: { totalTokens: Number.NaN, cost: { total: 'a lot' } } },
      { type: 'message', message: 'hello' },
    ])
    // The format is the harness's and will change. Unknown is zero, never NaN:
    // one NaN would poison every total that adds it.
    const usage = await usageOf(path)
    expect(usage.tokens).toBe(0)
    expect(usage.usd).toBe(0)
  })
})

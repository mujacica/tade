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
// contain the shapes a real one would take years to produce.

/** Write a session where the harness would put one for this cwd. */
function writeSession(root: string, cwd: string, task: string, lines: unknown[]): string {
  const dir = join(root, `-${cwd.replace(/\//g, '-')}-`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `2026-09-13T04-14-42-404Z_${sessionIdFor(task)}.jsonl`)
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return path
}

const priced = (input: number, output: number, usd: number) => ({
  type: 'message',
  usage: {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { total: usd },
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
      { type: 'session', id: 'wilco-app-refunds' },
      priced(100, 20, 0.03),
      { type: 'message', role: 'user' },
      priced(50, 10, 0.02),
    ])
    const usage = await usageOfTask('app/refunds', { root })
    expect(usage).toMatchObject({ input: 150, output: 30, tokens: 180, messages: 2 })
    expect(usage.usd).toBeCloseTo(0.05)
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
      { type: 'message', usage: { input: 'lots', cost: 'free' } },
      { type: 'message', usage: null },
    ])
    // The format is the harness's and will change. Unknown is zero, never NaN:
    // one NaN would poison every total that adds it.
    const usage = await usageOf(path)
    expect(usage.tokens).toBe(0)
    expect(usage.usd).toBe(0)
  })
})

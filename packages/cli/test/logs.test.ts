import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventLog } from '@tade/workbench/events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// `tade logs --size` is where somebody who came looking because a folder got
// big finds out what the journal is made of — and the one place that says the
// index beside it is derived and safe to delete, which nothing anywhere said.

describe('tade logs --size', () => {
  let log: EventLog
  let home: string
  let env: Record<string, string>

  const tade = (...args: string[]): Promise<{ code: number | null; stdout: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } })
      let stdout = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        stdout += d
      })
      child.on('exit', (code) => resolve({ code, stdout: stdout.trim() }))
    })

  beforeEach(async () => {
    home = tmp('tade-cli-logs-')
    env = { TADE_HOME: home, TADE_NO_GH: '1', HOME: home }
    log = await EventLog.open({ path: join(home, 'events.jsonl'), indexPath: null })
    for (let i = 0; i < 20; i++) await log.append({ type: 'output', detail: { bytes: 4_096 } })
    await log.append({ type: 'commit_seen', detail: { sha: 'abc' } })
  })

  afterEach(async () => {
    await log.close().catch(() => {})
  })

  it('says which part of it nothing reads back, and which part is the only record there is', async () => {
    const result = await tade('logs', '--size')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('21 lines')
    expect(result.stdout).toContain('20 (')
    expect(result.stdout).toContain('sampled lane output')
    expect(result.stdout).toContain('1 (')
    expect(result.stdout).toContain('the only record there is of themselves')
  })

  it('says the index is derived and safe to delete, which is the whole reason it is here', async () => {
    const result = await tade('logs', '--size')
    expect(result.stdout).toContain('events.jsonl.db')
    expect(result.stdout).toContain('Deleting it is always safe')
  })

  it('answers a machine too, with the ceiling it was read against', async () => {
    const result = await tade('logs', '--size', '--json')
    const said = JSON.parse(result.stdout) as Record<string, number>
    expect(said.lines).toBe(21)
    expect(said.sampled).toBe(20)
    expect(said.max_mb).toBe(16)
    // Nothing is near the ceiling, so nothing goes.
    expect(said.droppable).toBe(0)
  })

  it('reads the journal without taking the home, so it answers with a window open', async () => {
    // The log above is still open on this home, which is what a window is.
    const result = await tade('logs', '--size')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('events.jsonl')
  })
})

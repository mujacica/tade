import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TaskId } from '@tade/core'
import type { LaunchSpec, RunId, WorkerSpec } from '@tade/harnesses-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter } from '../src/adapter.ts'

// What one run is launched with — its settings, MCP config, instructions,
// plugin and pictures — is written into a folder of its own under the run
// folder, and taken away once nothing can launch the run again.

const spec = (task: string, over: Partial<WorkerSpec> = {}): WorkerSpec => ({
  run: `${task}/agent` as RunId,
  task: task as TaskId,
  cwd: tmp('tade-claude-cwd-'),
  prompt: '',
  ...over,
})

const settingsOf = (line: LaunchSpec) => line.args[line.args.indexOf('--settings') + 1] ?? ''
const pictureIn = (line: LaunchSpec) => /\[picture: (.+)\]/.exec(line.opening?.[0] ?? '')?.[1] ?? ''
const picture = (bytes: string) => ({
  data: Buffer.from(bytes).toString('base64'),
  mimeType: 'image/png',
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('what a Claude Code run was launched with', () => {
  it('goes when the run is forgotten, and another run’s and the conversation stay', async () => {
    const configDir = tmp('tade-claude-a-')
    const one = new ClaudeAdapter({ runDir: tmp('tcc-'), configDir })
    const over = spec('shop/refunds', { extras: { instructions: 'mind the money' } })
    const staying = spec('shop/returns')
    const overLine = one.launchSpec(over)
    const stayingLine = one.launchSpec(staying)
    const transcript = join(configDir, 'projects', 'shop', 'refunds.jsonl')
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, '{}\n')
    expect(existsSync(settingsOf(overLine))).toBe(true)

    expect(await one.forgetRuns([over.run])).toEqual([over.run])
    expect(existsSync(dirname(settingsOf(overLine)))).toBe(false)
    expect(existsSync(settingsOf(stayingLine))).toBe(true)
    expect(readFileSync(transcript, 'utf8')).toBe('{}\n')
    // Already gone, it is nothing to take away a second time.
    expect(await one.forgetRuns([over.run])).toEqual([])
  })

  it('points at a picture of its own for each of two said in the same millisecond', () => {
    const one = new ClaudeAdapter({ runDir: tmp('tcc-'), configDir: tmp('tade-claude-a-') })
    vi.spyOn(Date, 'now').mockReturnValue(1_791_000_000_000)
    const first = pictureIn(
      one.launchSpec(spec('shop/refunds', { prompt: 'this', images: [picture('first')] })),
    )
    const second = pictureIn(
      one.launchSpec(spec('shop/refunds', { prompt: 'and this', images: [picture('second')] })),
    )
    expect(second).not.toBe(first)
    expect(readFileSync(first, 'utf8')).toBe('first')
    expect(readFileSync(second, 'utf8')).toBe('second')
  })
})

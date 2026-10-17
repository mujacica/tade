import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { TaskId } from '@tade/core'
import type { LaunchSpec, RunId, WorkerSpec } from '@tade/harnesses-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { AcpAdapter } from '../src/adapter.ts'
import { recordPath } from '../src/record.ts'

// What one run is launched with — the lane's launch file and the pictures it
// was pointed at — is written beside the harness's other runs, and taken away
// once nothing can launch the run again; the record a task's conversation is
// read from is the task's, and stays.

const spec = (task: string, over: Partial<WorkerSpec> = {}): WorkerSpec => ({
  run: `${task}/agent` as RunId,
  task: task as TaskId,
  cwd: tmp('tade-acp-cwd-'),
  prompt: 'look at this',
  ...over,
})

const adapters: AcpAdapter[] = []
const adapter = (runDir: string) => {
  const one = new AcpAdapter({ runDir, env: { PATH: tmp('tade-acp-empty-path-') } })
  adapters.push(one)
  return one
}

const launchFileOf = (line: LaunchSpec) => line.args[1] ?? ''
const pictureIn = (line: LaunchSpec) => /\[picture: (.+)\]/.exec(line.opening?.[0] ?? '')?.[1] ?? ''
const picture = (bytes: string) => ({
  data: Buffer.from(bytes).toString('base64'),
  mimeType: 'image/png',
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const one of adapters.splice(0)) await one.shutdown()
})

describe('what an ACP run was launched with', () => {
  it('goes when the run is forgotten, and another run’s and the task’s record stay', async () => {
    const runDir = tmp('tade-acp-run-')
    const one = adapter(runDir)
    const over = spec('proj/refunds', { images: [picture('over')] })
    const overLine = one.launchSpec(over)
    const stayingLine = one.launchSpec(spec('proj/returns'))
    const record = recordPath(runDir, over.task)
    writeFileSync(record, '{"v":1}\n')

    expect(await one.forgetRuns([over.run])).toEqual([over.run])
    expect(existsSync(launchFileOf(overLine))).toBe(false)
    expect(existsSync(pictureIn(overLine))).toBe(false)
    expect(existsSync(launchFileOf(stayingLine))).toBe(true)
    expect(readFileSync(record, 'utf8')).toBe('{"v":1}\n')
  })

  it('points at a picture of its own for each of two said in the same millisecond', () => {
    const one = adapter(tmp('tade-acp-run-'))
    vi.spyOn(Date, 'now').mockReturnValue(1_791_000_000_000)
    const first = pictureIn(one.launchSpec(spec('proj/refunds', { images: [picture('first')] })))
    const second = pictureIn(one.launchSpec(spec('proj/refunds', { images: [picture('second')] })))
    expect(second).not.toBe(first)
    expect(readFileSync(first, 'utf8')).toBe('first')
    expect(readFileSync(second, 'utf8')).toBe('second')
  })
})

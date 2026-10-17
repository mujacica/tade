import { existsSync, readFileSync } from 'node:fs'
import type { TaskId } from '@tade/core'
import type { LaunchSpec, RunId, WorkerSpec } from '@tade/harnesses-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { CodexAdapter } from '../src/adapter.ts'
import { rememberThread, threadFile } from '../src/sessions.ts'

// What one run wrote for itself — the pictures it was pointed at — is in a
// folder of its own under the run folder, and taken away once nothing can
// launch the run again; the thread a task talks in is the task's, and stays.

const spec = (task: string, over: Partial<WorkerSpec> = {}): WorkerSpec => ({
  run: `${task}/agent` as RunId,
  task: task as TaskId,
  cwd: '/work/refunds',
  prompt: 'look at this',
  ...over,
})

const adapter = (runDir: string) =>
  new CodexAdapter({
    runDir,
    codexHome: '/accounts/work',
    home: tmp('tade-codex-home-'),
    bin: 'codex',
  })

const pictureIn = (line: LaunchSpec) => /\[picture: (.+)\]/.exec(line.opening?.[0] ?? '')?.[1] ?? ''
const picture = (bytes: string) => ({
  data: Buffer.from(bytes).toString('base64'),
  mimeType: 'image/png',
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('what a Codex run wrote for itself', () => {
  it('goes when the run is forgotten, and another run’s and the task’s thread stay', async () => {
    const runDir = tmp('tade-codex-run-')
    const one = adapter(runDir)
    const over = spec('app/refunds', { images: [picture('over')] })
    const shown = pictureIn(one.launchSpec(over))
    const staying = pictureIn(one.launchSpec(spec('app/returns', { images: [picture('stay')] })))
    await rememberThread(over.task, runDir, 'thread-1')

    expect(await one.forgetRuns([over.run])).toEqual([over.run])
    expect(existsSync(shown)).toBe(false)
    expect(readFileSync(staying, 'utf8')).toBe('stay')
    expect(readFileSync(threadFile(over.task, runDir), 'utf8')).toBe('thread-1\n')
  })

  it('points at a picture of its own for each of two said in the same millisecond', () => {
    const one = adapter(tmp('tade-codex-run-'))
    vi.spyOn(Date, 'now').mockReturnValue(1_791_000_000_000)
    const first = pictureIn(one.launchSpec(spec('app/refunds', { images: [picture('first')] })))
    const second = pictureIn(one.launchSpec(spec('app/refunds', { images: [picture('second')] })))
    expect(second).not.toBe(first)
    expect(readFileSync(first, 'utf8')).toBe('first')
    expect(readFileSync(second, 'utf8')).toBe('second')
  })
})

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkerSignal } from '@wilco/core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { PiAdapter, piBinary } from '../src/adapter.ts'
import { describeToolCall } from '../src/extension.ts'

async function until(check: () => boolean | Promise<boolean>, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timed out')
}

// These run the real pi binary. No model is configured, so nothing reaches an
// LLM: what is under test is that pi loads the Wilco extension, the extension
// reaches the supervision socket, and the adapter speaks pi's RPC protocol.

describe('PiAdapter', () => {
  let adapter: PiAdapter | null = null

  afterEach(async () => {
    await adapter?.shutdown()
    adapter = null
  })

  it('ships a pi binary', () => {
    expect(existsSync(piBinary())).toBe(true)
  })

  it('starts pi with the Wilco extension attached and the run supervised', async () => {
    const runDir = tmp('wilco-pi-')
    adapter = new PiAdapter({ runDir })
    const signals: WorkerSignal[] = []
    // Subscribing before start: the first signals arrive while it is running.
    adapter.onSignal('r1', (s) => signals.push(s))

    const handle = await adapter.start({
      run: 'r1',
      task: 'app/t',
      cwd: tmp('wilco-work-'),
      prompt: '',
    })

    expect(handle).toMatchObject({ run: 'r1', task: 'app/t' })
    // `started` only arrives if pi loaded our extension and it dialled back.
    await until(() => signals.some((s) => s.type === 'started'))
    expect(existsSync(join(runDir, 'r1.sock'))).toBe(true)
    // get_state answered during start, so the RPC framing round-trips.
    expect(handle.sessionId === null || typeof handle.sessionId === 'string').toBe(true)
    expect((await adapter.list()).map((h) => h.run)).toEqual(['r1'])
  }, 60_000)

  it('stop() shuts the agent down and cleans up its socket', async () => {
    const runDir = tmp('wilco-pi-')
    adapter = new PiAdapter({ runDir })
    const signals: WorkerSignal[] = []
    adapter.onSignal('r2', (s) => signals.push(s))
    await adapter.start({ run: 'r2', task: 'app/t', cwd: tmp('wilco-work-'), prompt: '' })
    await until(() => signals.some((s) => s.type === 'started'))

    await adapter.stop('r2')
    expect(await adapter.list()).toEqual([])
    await until(() => !existsSync(join(runDir, 'r2.sock')))
  }, 60_000)

  it('rejects commands for an unknown run instead of hanging', async () => {
    adapter = new PiAdapter({ runDir: tmp('wilco-pi-') })
    await expect(adapter.prompt('ghost', 'hello')).rejects.toThrow(/no such run/)
  })
})

describe('describeToolCall', () => {
  const call = (toolName: string, input: Record<string, unknown>) => ({
    toolCallId: 'c1',
    toolName,
    input,
  })

  it('quotes the exact command for bash, which is what gets read back', () => {
    expect(describeToolCall(call('bash', { command: 'git push --force origin main' }))).toBe(
      'bash: git push --force origin main',
    )
  })

  it('names the file for edits and writes', () => {
    expect(describeToolCall(call('write', { path: 'src/app.ts' }))).toBe('write src/app.ts')
  })

  it('collapses whitespace and truncates runaway input', () => {
    const summary = describeToolCall(call('bash', { command: `echo ${'x'.repeat(400)}` }))
    expect(summary.length).toBeLessThanOrEqual(126)
    expect(summary).toMatch(/…$/)
  })

  it('falls back to the arguments for unknown tools', () => {
    expect(describeToolCall(call('deploy', { env: 'prod' }))).toBe('deploy {"env":"prod"}')
  })
})

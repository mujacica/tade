import { execFileSync, spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { PiAdapter, piBinary, runSocket, sessionIdFor } from '../src/adapter.ts'
import { describeToolCall } from '../src/tade.ts'

/** Processes whose command line carries this mark, by pid. */
function running(mark: string): number[] {
  const listed = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
  return listed
    .split('\n')
    .filter((line) => line.includes(mark) && !line.includes(' ps -ax'))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid))
}

async function until(check: () => boolean | Promise<boolean>, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timed out')
}

// These run the real pi binary. No model is configured, so nothing reaches an
// LLM: what is under test is that pi loads the Tade extension, the extension
// reaches the supervision socket, and the adapter speaks pi's RPC protocol.

describe('PiAdapter', () => {
  let adapter: PiAdapter | null = null

  afterEach(async () => {
    await adapter?.shutdown()
    adapter = null
  })

  it('does not outlive Tade, even when Tade is killed outright', async () => {
    const mark = `tade-orphan-pi-${process.pid}-${Date.now()}`
    const runDir = tmp('tade-pi-orphan-')
    const script = join(runDir, 'parent.ts')
    // A stand-in for Tade: it starts the one Tade draws itself, and then sits
    // there as a window does. Nothing of its own runs after a SIGKILL.
    writeFileSync(
      script,
      [
        `import { PiAdapter } from '${fileURLToPath(new URL('../src/adapter.ts', import.meta.url))}'`,
        `const adapter = new PiAdapter({ runDir: '${runDir}', supervise: false, args: ['--append-system-prompt', '${mark}'] })`,
        `await adapter.start({ run: 'orchestrator', task: 'tade/${mark}', cwd: '${runDir}', prompt: '' })`,
        `setInterval(() => {}, 1000)`,
      ].join('\n'),
    )
    const parent = spawn(process.execPath, [script], { stdio: 'ignore' })
    try {
      await until(() => running(mark).length > 0)
      process.kill(parent.pid ?? 0, 'SIGKILL')
      await until(() => running(mark).length === 0)
      expect(running(mark)).toEqual([])
    } finally {
      for (const pid of running(mark)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  }, 60_000)

  it('ships a pi binary', () => {
    expect(existsSync(piBinary())).toBe(true)
  })

  it('contains a worker when the route asks for one', () => {
    adapter = new PiAdapter({ runDir: tmp('tade-pi-') })
    const launch = adapter.launchSpec({
      run: 'r1',
      task: 'app/t',
      cwd: '/wt/t',
      prompt: '',
      sandbox: { kind: 'seatbelt', worktree: '/wt/t', platform: 'darwin' },
    })
    expect(launch.command).toBe('sandbox-exec')
    // Wrapped, not replaced: what was going to run is still what runs.
    expect(launch.args).toContain(process.execPath)
  })

  it('leaves a worker alone when no sandbox was asked for', () => {
    adapter = new PiAdapter({ runDir: tmp('tade-pi-') })
    const launch = adapter.launchSpec({ run: 'r1', task: 'app/t', cwd: '/wt/t', prompt: '' })
    expect(launch.command).toBe(process.execPath)
  })

  it('keeps the opening instruction out of the line that comes back to a session', () => {
    adapter = new PiAdapter({ runDir: tmp('tade-pi-') })
    const launch = adapter.launchSpec({
      run: 'r1',
      task: 'app/refunds',
      cwd: '/wt/refunds',
      prompt: 'fix the double charge',
    })
    // Said once, on its own, so nothing that relaunches from what was written
    // down can say it again.
    expect(launch.opening).toEqual(['fix the double charge'])
    expect(launch.args).not.toContain('fix the double charge')
    // And that line is the one that continues the conversation: same session.
    expect(launch.args).toContain('--session-id')
    expect(launch.args).toContain(sessionIdFor('app/refunds'))

    // Nothing to say, nothing appended: reopening looks exactly like this.
    const again = adapter.launchSpec({
      run: 'r1',
      task: 'app/refunds',
      cwd: '/wt/refunds',
      prompt: '',
    })
    expect(again.opening).toBeUndefined()
    expect(again.args).toEqual(launch.args)
  })

  it('starts pi with the Tade extension attached and the run supervised', async () => {
    const runDir = tmp('tade-pi-')
    adapter = new PiAdapter({ runDir })
    const signals: WorkerSignal[] = []
    // Subscribing before start: the first signals arrive while it is running.
    adapter.onSignal('r1', (s) => signals.push(s))

    const handle = await adapter.start({
      run: 'r1',
      task: 'app/t',
      cwd: tmp('tade-work-'),
      prompt: '',
    })

    expect(handle).toMatchObject({ run: 'r1', task: 'app/t' })
    // `started` only arrives if pi loaded our extension and it dialled back.
    await until(() => signals.some((s) => s.type === 'started'))
    expect(existsSync(runSocket(runDir, 'r1'))).toBe(true)
    // get_state answered during start, so the RPC framing round-trips.
    expect(handle.sessionId === null || typeof handle.sessionId === 'string').toBe(true)
    expect((await adapter.list()).map((h) => h.run)).toEqual(['r1'])
  }, 60_000)

  it('stop() shuts the agent down and cleans up its socket', async () => {
    const runDir = tmp('tade-pi-')
    adapter = new PiAdapter({ runDir })
    const signals: WorkerSignal[] = []
    adapter.onSignal('r2', (s) => signals.push(s))
    await adapter.start({ run: 'r2', task: 'app/t', cwd: tmp('tade-work-'), prompt: '' })
    await until(() => signals.some((s) => s.type === 'started'))

    await adapter.stop('r2')
    expect(await adapter.list()).toEqual([])
    await until(() => !existsSync(runSocket(runDir, 'r2')))
  }, 60_000)

  it('rejects commands for an unknown run instead of hanging', async () => {
    adapter = new PiAdapter({ runDir: tmp('tade-pi-') })
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

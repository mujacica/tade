import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaneId } from '@tade/core'
import { until } from '@tade/drivers-core/conformance'
import { PtyDriver } from '@tade/drivers-pty'
import type { WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeAnthropic, startFakeAnthropic } from '../../../../test/fixtures/fake-anthropic.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter } from '../src/adapter.ts'
import { sessionIdFor } from '../src/transcript.ts'

// The real Claude Code, in a real terminal, launched from the line the adapter
// writes — against a scripted model on this machine and an account made for
// the test. No network, no sign-in, nothing of anybody's own touched. It is
// the only evidence that the hooks, the tool server, the gate and coming back
// to a session work in the program they were written for.

const claude = (() => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

describe.runIf(claude)('Claude Code in a lane', () => {
  let model: FakeAnthropic | null = null
  let driver: PtyDriver | null = null
  let adapter: ClaudeAdapter | null = null

  afterEach(async () => {
    await adapter?.shutdown()
    await driver?.shutdown()
    await model?.close()
  })

  it('is gated, says its turn, spends, and comes back to its conversation', async () => {
    model = await startFakeAnthropic({
      tool: { name: 'Bash', input: { command: 'echo hi > gated.txt', description: 'write' } },
      finalText: 'Could not write it.',
    })
    const account = tmp('tade-claude-live-')
    // A key from a helper, so the account needs no sign-in; first run already done.
    writeFileSync(join(account, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo sk-fake' }))
    writeFileSync(join(account, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
    const cwd = tmp('tade-claude-work-')
    const runDir = tmp('tcc-')
    const pty = new PtyDriver({ scrollback: 500 })
    driver = pty
    const one = new ClaudeAdapter({
      runDir,
      configDir: account,
      approvals: 'policy',
      type: (run, text) => pty.write(run as LaneId, Buffer.from(text, 'utf8')),
    })
    adapter = one
    const spec = { run: 'app/live/agent', task: 'app/live', cwd, prompt: 'write the file' }
    const signals: WorkerSignal[] = []
    one.onSignal(spec.run, (signal) => {
      signals.push(signal)
      if (signal.type === 'permission_request') {
        void one.decide(spec.run, signal.requestId, { allow: false, reason: 'not today' })
      }
    })
    const open = async (prompt: string) => {
      await one.supervise({ ...spec, prompt })
      const launch = one.launchSpec({ ...spec, prompt })
      await pty.open({
        id: spec.run as LaneId,
        cwd,
        command: launch.command,
        args: [...launch.args, ...(launch.opening ?? [])],
        // Nothing reaches the network: no marketplace, no update check, no telemetry.
        env: {
          ...launch.env,
          ANTHROPIC_BASE_URL: model?.url ?? '',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        cols: 120,
        rows: 40,
      })
    }
    const screen = async () => pty.capture(spec.run as LaneId, { lines: 40 }).catch(() => '')

    await open(spec.prompt)
    await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 45_000 }).catch(
      async (err) => {
        throw new Error(`${(err as Error).message}\n${await screen()}\n${JSON.stringify(signals)}`)
      },
    )
    const kinds = signals.map((signal) => signal.type)
    expect(kinds).toEqual(expect.arrayContaining(['started', 'turn_started', 'permission_request']))
    expect(signals.find((s) => s.type === 'started')).toMatchObject({
      sessionId: sessionIdFor(spec.task),
    })
    expect(signals.find((s) => s.type === 'permission_request')).toMatchObject({
      summary: 'Bash: echo hi > gated.txt',
    })
    // Refused in Tade, so never run.
    expect(existsSync(join(cwd, 'gated.txt'))).toBe(false)
    expect(signals.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'ok' })
    expect(signals.find((s) => s.type === 'message')).toMatchObject({ text: 'Could not write it.' })
    expect((await one.spent(spec.task, cwd)).tokens).toBeGreaterThan(0)
    expect(await one.hasConversation(spec.task, cwd)).toBe(true)

    // Closed, and opened again from the line that was written down: the same
    // conversation, and nothing said to it.
    await pty.close(spec.run as LaneId)
    await one.stop(spec.run)
    const before = model.requests.length
    signals.length = 0
    await open('')
    await until(() => signals.some((s) => s.type === 'started'), { timeout: 30_000 })
    expect(signals.find((s) => s.type === 'started')).toMatchObject({
      sessionId: sessionIdFor(spec.task),
    })
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(signals.some((s) => s.type === 'turn_started')).toBe(false)
    expect(model.requests.slice(before).some((r) => Array.isArray(r.tools))).toBe(false)
  }, 120_000)
})

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaneId } from '@tade/core'
import { until } from '@tade/drivers-core/conformance'
import { PtyDriver } from '@tade/drivers-pty'
import type { WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeAnthropic, startFakeAnthropic } from '../../../../test/fixtures/fake-anthropic.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter } from '../src/adapter.ts'

// The real `claude`, in a lane, with the sandbox Tade turns on where its
// agents run as a user of their own (`WorkerSpec.sandbox`, `sandboxOf`): the
// only evidence that the keys Tade writes are ones this Claude Code takes,
// that a command writes where it may and is refused where it may not, and
// that a refused command is not quietly run again outside the sandbox.
//
// Only where `claude` is installed and its sandbox can start: on a Mac that
// is Seatbelt, which is built in; on Linux, bubblewrap the kernel lets an
// unprivileged user run — which Ubuntu 24.04 does not until bwrap has an
// AppArmor profile, and which CI has no `claude` for in any case.

const claude = (() => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

describe.runIf(claude && process.platform === 'darwin')(
  'Claude Code with its own sandbox on',
  () => {
    let model: FakeAnthropic | null = null
    let driver: PtyDriver | null = null
    let adapter: ClaudeAdapter | null = null

    afterEach(async () => {
      await adapter?.shutdown()
      await driver?.shutdown()
      await model?.close()
    })

    it('writes in its own folder and what it was handed, and is refused everywhere else, with no retry outside', async () => {
      const cwd = tmp('tade-claude-boxed-')
      const handed = tmp('tade-claude-handed-')
      const outside = tmp('tade-claude-outside-')
      model = await startFakeAnthropic({
        tool: {
          name: 'Bash',
          input: {
            command: `echo in > inside.txt; echo handed > ${join(handed, 'handed.txt')}; echo out > ${join(outside, 'outside.txt')}; true`,
            description: 'write three files',
          },
        },
        finalText: 'Tried.',
      })
      const account = tmp('tade-claude-live-')
      writeFileSync(
        join(account, 'settings.json'),
        JSON.stringify({ apiKeyHelper: 'echo sk-fake' }),
      )
      writeFileSync(join(account, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
      const pty = new PtyDriver({ scrollback: 500 })
      driver = pty
      const one = new ClaudeAdapter({ runDir: tmp('tcc-'), configDir: account })
      adapter = one
      const spec = {
        run: 'app/boxed/agent',
        task: 'app/boxed',
        cwd,
        prompt: 'write them',
        sandbox: { writes: [handed] },
      }
      const signals: WorkerSignal[] = []
      one.onSignal(spec.run, (signal) => signals.push(signal))
      await one.supervise(spec)
      const launch = one.launchSpec(spec)
      await pty.open({
        id: spec.run as LaneId,
        cwd,
        command: launch.command,
        args: [...launch.args, ...(launch.opening ?? [])],
        env: {
          ...launch.env,
          ANTHROPIC_BASE_URL: model.url,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        cols: 120,
        rows: 40,
      })
      const screen = async () => pty.capture(spec.run as LaneId, { lines: 40 }).catch(() => '')
      await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 60_000 }).catch(
        async (err) => {
          throw new Error(`${(err as Error).message}\n${await screen()}`)
        },
      )
      expect(readFileSync(join(cwd, 'inside.txt'), 'utf8').trim()).toBe('in')
      expect(readFileSync(join(handed, 'handed.txt'), 'utf8').trim()).toBe('handed')
      expect(existsSync(join(outside, 'outside.txt'))).toBe(false)
      // One call, and only one: a refusal is not a reason to run it unsandboxed.
      expect(signals.filter((s) => s.type === 'tool_call')).toHaveLength(1)
    }, 90_000)
  },
)

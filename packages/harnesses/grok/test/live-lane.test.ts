import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaneId } from '@tade/core'
import { until } from '@tade/drivers-core/conformance'
import { PtyDriver } from '@tade/drivers-pty'
import type { WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeModel, startFakeModel } from '../../../../test/fixtures/fake-model.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { GrokAdapter } from '../src/adapter.ts'
import { sessionIdFor } from '../src/record.ts'

// The real Grok Build, in a real terminal, launched from the line the adapter
// writes — against a scripted model on this machine and an account folder
// made for the test. No network, no sign-in, nothing of anybody's own touched:
// Grok takes a model of the account's own (`[model.<id>]`, an OpenAI-style
// endpoint with its own key), which needs no xAI sign-in at all. It is the
// only evidence that the hooks, the tool server, the gate, the status line and
// coming back to a session work in the program they were written for.

const grok = (() => {
  try {
    execFileSync('grok', ['--version'], { stdio: 'pipe', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

/** The agent's own turns: Grok also lists models and asks for a title on the side. */
const own = (request: Record<string, unknown>) =>
  Array.isArray(request.tools) && request.tools.length > 5

/** An account folder whose only model is the scripted one. */
function accountFor(model: FakeModel): string {
  const account = tmp('tade-grok-live-')
  writeFileSync(
    join(account, 'config.toml'),
    [
      '[models]',
      'default = "fake"',
      '',
      '[model.fake]',
      'model = "fake-model"',
      `base_url = "${model.url}"`,
      'api_key = "sk-fake"',
      'name = "Fake"',
      'context_window = 100000',
      '',
    ].join('\n'),
  )
  return account
}

describe.runIf(grok)('Grok Build in a lane', () => {
  let model: FakeModel | null = null
  let driver: PtyDriver | null = null
  let adapter: GrokAdapter | null = null

  afterEach(async () => {
    await adapter?.shutdown()
    await driver?.shutdown()
    await model?.close()
  })

  /** A lane of the adapter's, opened from the line it writes, and how to read its screen. */
  function lanes(one: GrokAdapter, pty: PtyDriver) {
    return {
      open: async (spec: { run: string; task: string; cwd: string }, prompt: string) => {
        await one.supervise({ ...spec, prompt })
        const launch = one.launchSpec({ ...spec, prompt })
        await pty.open({
          id: spec.run as LaneId,
          cwd: spec.cwd,
          command: launch.command,
          args: [...launch.args, ...(launch.opening ?? [])],
          env: launch.env,
          cols: 120,
          rows: 40,
        })
      },
      screen: (run: string) => pty.capture(run as LaneId, { lines: 40 }).catch(() => ''),
    }
  }

  it('is gated, says its turn, spends, takes what it is told, and comes back to its conversation', async () => {
    model = await startFakeModel({
      tool: {
        name: 'run_terminal_command',
        arguments: { command: 'echo hi > gated.txt', description: 'write a file' },
      },
      finalText: 'Could not write it.',
      main: own,
      usage: { prompt: 1000, completion: 50, cached: 200 },
    })
    const account = accountFor(model)
    const cwd = tmp('tade-grok-work-')
    const pty = new PtyDriver({ scrollback: 500 })
    driver = pty
    const one = new GrokAdapter({
      runDir: tmp('tade-grok-runs-'),
      grokHome: account,
      home: tmp('tade-grok-home-'),
      approvals: 'policy',
      type: (run, text) => pty.write(run as LaneId, Buffer.from(text, 'utf8')),
    })
    adapter = one
    const spec = { run: 'app/grok-live/agent', task: 'app/grok-live', cwd }
    const signals: WorkerSignal[] = []
    one.onSignal(spec.run, (signal) => {
      signals.push(signal)
      if (signal.type === 'permission_request') {
        void one.decide(spec.run, signal.requestId, { allow: false, reason: 'not today' })
      }
    })
    const { open, screen } = lanes(one, pty)
    const failing = async (err: unknown) => {
      throw new Error(
        `${(err as Error).message}\n${await screen(spec.run)}\n${JSON.stringify(signals)}`,
      )
    }

    await open(spec, 'write the file')
    await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 60_000 }).catch(
      failing,
    )
    const kinds = signals.map((signal) => signal.type)
    expect(kinds).toEqual(expect.arrayContaining(['started', 'turn_started', 'permission_request']))
    expect(signals.find((s) => s.type === 'started')).toMatchObject({
      sessionId: sessionIdFor(spec.task),
    })
    expect(signals.find((s) => s.type === 'permission_request')).toMatchObject({
      tool: 'run_terminal_command',
      summary: 'run_terminal_command: echo hi > gated.txt',
    })
    // Refused in Tade, so never run.
    expect(existsSync(join(cwd, 'gated.txt'))).toBe(false)
    expect(signals.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'ok' })
    expect(signals.find((s) => s.type === 'message')).toMatchObject({ text: 'Could not write it.' })
    // What it used, counted from what Grok wrote down once the turn ended.
    await until(() => signals.some((s) => s.type === 'usage'), { timeout: 20_000 }).catch(failing)
    const used = signals.find((s) => s.type === 'usage')
    expect(used).toMatchObject({ cacheRead: 400, input: 1600, output: 100, usd: 0 })
    expect(signals.some((s) => s.type === 'context')).toBe(true)
    expect((await one.spent(spec.task, cwd)).tokens).toBe(2100)
    expect(await one.hasConversation(spec.task, cwd)).toBe(true)
    // Told something more, typed into its terminal: a turn of its own.
    const turns = () => signals.filter((s) => s.type === 'turn_done').length
    await one.prompt(spec.run, 'and now say it again')
    await until(() => turns() === 2, { timeout: 30_000 }).catch(failing)
    const history = await one.history(spec.task, cwd, { limit: 20 })
    expect(history.items.filter((item) => item.kind === 'sent').map((item) => item.text)).toEqual([
      'write the file',
      'and now say it again',
    ])
    expect(history.items.find((item) => item.kind === 'tool')).toMatchObject({
      tool: 'run_terminal_command',
      ok: false,
    })

    // Closed, and opened again from the line that was written down: the same
    // conversation, and nothing said to it.
    await pty.close(spec.run as LaneId)
    await one.stop(spec.run)
    const before = model.requests.filter(own).length
    signals.length = 0
    await open(spec, '')
    await until(() => signals.some((s) => s.type === 'started'), { timeout: 30_000 }).catch(failing)
    expect(signals.find((s) => s.type === 'started')).toMatchObject({
      sessionId: sessionIdFor(spec.task),
    })
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(signals.some((s) => s.type === 'turn_started')).toBe(false)
    expect(model.requests.filter(own).length).toBe(before)
    // Its account folder brought nothing of Claude Code's or Cursor's in.
    expect(readFileSync(join(account, 'hooks', 'tade.json'), 'utf8')).toContain('failClosed')
  }, 180_000)

  it('says its task is done through Tade’s own tool server, and stops a turn when told', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding = false
    model = await startFakeModel({
      tool: {
        name: 'use_tool',
        arguments: { tool_name: 'tade__tade_done', tool_input: { summary: 'all finished' } },
      },
      finalText: 'Done.',
      main: own,
      hold: () => (holding ? held : Promise.resolve()),
    })
    const account = accountFor(model)
    const cwd = tmp('tade-grok-work-')
    const pty = new PtyDriver({ scrollback: 500 })
    driver = pty
    const one = new GrokAdapter({
      runDir: tmp('tade-grok-runs-'),
      grokHome: account,
      home: tmp('tade-grok-home-'),
      type: (run, text) => pty.write(run as LaneId, Buffer.from(text, 'utf8')),
    })
    adapter = one
    const spec = { run: 'app/grok-done/agent', task: 'app/grok-done', cwd }
    const signals: WorkerSignal[] = []
    one.onSignal(spec.run, (signal) => signals.push(signal))
    const { open, screen } = lanes(one, pty)
    const failing = async (err: unknown) => {
      throw new Error(
        `${(err as Error).message}\n${await screen(spec.run)}\n${JSON.stringify(signals)}`,
      )
    }

    await open(spec, 'finish up')
    await until(() => signals.some((s) => s.type === 'done'), { timeout: 60_000 }).catch(failing)
    expect(signals.find((s) => s.type === 'done')).toMatchObject({ summary: 'all finished' })
    await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 30_000 }).catch(
      failing,
    )

    // A turn still waiting on its model, stopped from Tade: Ctrl+C, the turn
    // said stopped, and the line it put back cleared — so what is said next
    // is said on its own.
    holding = true
    signals.length = 0
    await one.prompt(spec.run, 'think about it for a long while')
    await until(() => signals.some((s) => s.type === 'turn_started'), { timeout: 30_000 }).catch(
      failing,
    )
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await one.abort(spec.run)
    expect(signals.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'aborted' })
    holding = false
    release()
    signals.length = 0
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await one.prompt(spec.run, 'one more thing')
    await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 30_000 }).catch(
      failing,
    )
    const history = await one.history(spec.task, cwd, { limit: 30 })
    const sent = history.items.filter((item) => item.kind === 'sent').map((item) => item.text)
    expect(sent.at(-1)).toBe('one more thing')
  }, 180_000)
})

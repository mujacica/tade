import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaneId } from '@tade/core'
import { until } from '@tade/drivers-core/conformance'
import { PtyDriver } from '@tade/drivers-pty'
import type { WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeModel, startFakeModel } from '../../../../test/fixtures/fake-model.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { OpenCodeAdapter } from '../src/adapter.ts'
import { sessionIdFor } from '../src/record.ts'

// The real OpenCode 2, in a real terminal, launched from the line the adapter
// writes — against a scripted model on this machine and an account folder
// made for the test. No network, no sign-in, nothing of anybody's own touched:
// the account has a config folder of its own whose one provider is the
// scripted model, an OpenAI-compatible endpoint with a key in the environment.
// It is the only evidence that the plugin, the tool server, the gate, saying
// things through the session API and coming back to a session work in the
// program they were written for.

const opencode = (() => {
  try {
    const said = execFileSync('opencode', ['--version'], { stdio: 'pipe', timeout: 15_000 })
    return /\bv?2\.\d+\.\d+/.test(said.toString())
  } catch {
    return false
  }
})()

/** The agent's own turns: OpenCode also asks the model for a title, with no tools. */
const own = (request: Record<string, unknown>) =>
  Array.isArray(request.tools) && request.tools.length > 3

/** An account folder whose only provider is the scripted model. */
function accountFor(model: FakeModel): string {
  const account = tmp('tade-opencode-live-')
  mkdirSync(join(account, 'config'), { recursive: true })
  writeFileSync(join(account, 'tade-opencode.json'), '{"shareConfig":false}\n')
  writeFileSync(
    join(account, 'config', 'opencode.json'),
    JSON.stringify({
      providers: {
        'tade-test': {
          name: 'Tade Test',
          env: ['TADE_TEST_KEY'],
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: model.url },
          models: {
            fake: { name: 'Fake', limit: { context: 100_000, output: 4_096 } },
            other: { name: 'Other', limit: { context: 200_000, output: 4_096 } },
          },
        },
      },
    }),
  )
  return account
}

describe.runIf(opencode)('OpenCode in a lane', () => {
  let model: FakeModel | null = null
  let driver: PtyDriver | null = null
  let adapter: OpenCodeAdapter | null = null

  afterEach(async () => {
    await adapter?.shutdown()
    await driver?.shutdown()
    await model?.close()
  })

  function make(account: string, approvals: 'bypass' | 'policy'): OpenCodeAdapter {
    const one = new OpenCodeAdapter({
      runDir: tmp('tade-opencode-runs-'),
      socketDir: tmp('tade-oc-s-'),
      approvals,
      account: { name: 'live', dir: account, kind: 'subscription' },
      env: { ...process.env, TADE_TEST_KEY: 'sk-fake' },
    })
    adapter = one
    return one
  }

  /** A lane of the adapter's, opened from the line it writes, and how to read its screen. */
  function lanes(one: OpenCodeAdapter, pty: PtyDriver) {
    return {
      open: async (spec: { run: string; task: string; cwd: string }, prompt: string) => {
        const told = {
          ...spec,
          prompt,
          model: { provider: 'tade-test', id: 'fake' },
          called: 'Write the gated file',
        }
        await one.supervise(told)
        const launch = one.launchSpec(told)
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
      tool: { name: 'shell', arguments: { command: 'echo hi > gated.txt', description: 'write' } },
      finalText: 'Could not write it.',
      main: own,
      usage: { prompt: 1000, completion: 50, cached: 200 },
    })
    const account = accountFor(model)
    const cwd = tmp('tade-opencode-work-')
    const pty = new PtyDriver({ scrollback: 500 })
    driver = pty
    const one = make(account, 'policy')
    const spec = { run: 'app/oc-live/agent', task: 'app/oc-live', cwd }
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
    const turns = () => signals.filter((s) => s.type === 'turn_done').length

    await open(spec, 'write the file')
    await until(() => turns() === 1, { timeout: 60_000 }).catch(failing)
    expect(signals.find((s) => s.type === 'started')).toMatchObject({
      sessionId: sessionIdFor(spec.task),
    })
    expect(signals.find((s) => s.type === 'permission_request')).toMatchObject({
      tool: 'shell',
      summary: 'shell: echo hi > gated.txt',
    })
    // Refused in Tade, so never run, and OpenCode said so.
    expect(existsSync(join(cwd, 'gated.txt'))).toBe(false)
    expect(signals.find((s) => s.type === 'tool_result')).toMatchObject({
      ok: false,
      summary: 'not today',
    })
    expect(signals.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'ok' })
    expect(signals.find((s) => s.type === 'message')).toMatchObject({ text: 'Could not write it.' })
    expect(signals.at(-1)?.type).toBe('idle')
    // Each step said what it used, OpenCode's way: cached input apart, and no
    // plan paying for the scripted provider.
    const used = signals.filter((s) => s.type === 'usage')
    expect(used).toHaveLength(2)
    expect(used[0]).toMatchObject({
      model: 'tade-test/fake',
      input: 800,
      cacheRead: 200,
      output: 50,
      tokens: 1050,
      plan: false,
    })
    expect(signals.find((s) => s.type === 'context')).toMatchObject({ tokens: 1000, percent: 1 })
    expect(await one.spent(spec.task, cwd)).toMatchObject({ tokens: 2100, messages: 2 })
    expect(await one.hasConversation(spec.task, cwd)).toBe(true)
    expect(await one.modelOf(spec.run)).toEqual({ provider: 'tade-test', id: 'fake' })

    // Told something more, through the session API: a turn of its own, and
    // shown in its terminal as if typed.
    await one.prompt(spec.run, 'and now say it again')
    await until(() => turns() === 2, { timeout: 30_000 }).catch(failing)
    await until(async () => (await screen(spec.run)).includes('and now say it again'), {
      timeout: 10_000,
    }).catch(failing)
    // Named in Tade: OpenCode's session takes it, and says it is a person's.
    await one.name(spec.run, 'Gate the file write')
    await until(() => signals.some((s) => s.type === 'titled' && s.named), {
      timeout: 10_000,
    }).catch(failing)
    const history = await one.history(spec.task, cwd, { limit: 20 })
    expect(history.items.filter((item) => item.kind === 'sent').map((item) => item.text)).toEqual([
      'write the file',
      'and now say it again',
    ])
    expect(history.items.find((item) => item.kind === 'tool')).toMatchObject({
      tool: 'shell',
      ok: false,
      result: 'not today',
    })
    expect(await one.callAnswer(spec.task, cwd, 'call_1')).toEqual({
      ok: false,
      result: 'not today',
    })
    expect(
      (await one.sessions(cwd, [spec.task])).find((s) => s.id === sessionIdFor(spec.task)),
    ).toMatchObject({ task: spec.task, first: 'Gate the file write' })

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
      model: 'tade-test/fake',
    })
    await until(async () => (await screen(spec.run)).includes('and now say it again'), {
      timeout: 15_000,
    }).catch(failing)
    expect(signals.some((s) => s.type === 'turn_started')).toBe(false)
    expect(model.requests.filter(own).length).toBe(before)
  }, 240_000)

  it('says its task is done through Tade’s tool server, runs ungated without approvals, switches model and stops a turn', async () => {
    let release = (): void => {}
    let holding = false
    model = await startFakeModel({
      tool: { name: 'tade_tade_done', arguments: { summary: 'all finished' } },
      finalText: 'Done.',
      main: own,
      hold: () =>
        holding
          ? new Promise<void>((resolve) => {
              release = resolve
            })
          : Promise.resolve(),
    })
    const account = accountFor(model)
    const cwd = tmp('tade-opencode-work-')
    const pty = new PtyDriver({ scrollback: 500 })
    driver = pty
    const one = make(account, 'bypass')
    const spec = { run: 'app/oc-done/agent', task: 'app/oc-done', cwd }
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
    // Tade's own tools lose their server's name, and nothing was held.
    expect(signals.find((s) => s.type === 'tool_call')).toMatchObject({ tool: 'tade_done' })
    expect(signals.some((s) => s.type === 'permission_request')).toBe(false)
    await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 30_000 }).catch(
      failing,
    )

    // Another model, for this session only: said back as the one it runs on.
    await one.setModel(spec.run, { provider: 'tade-test', id: 'other' })
    await until(() => signals.some((s) => s.type === 'started' && s.model === 'tade-test/other'), {
      timeout: 15_000,
    }).catch(failing)

    // A turn still waiting on its model, stopped from Tade.
    holding = true
    signals.length = 0
    await one.prompt(spec.run, 'think about it for a long while')
    await until(() => signals.some((s) => s.type === 'turn_started'), { timeout: 30_000 }).catch(
      failing,
    )
    await until(() => model?.requests.some((r) => own(r) && r.model === 'other') ?? false, {
      timeout: 30_000,
    }).catch(failing)
    await one.abort(spec.run)
    await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 30_000 }).catch(
      failing,
    )
    expect(signals.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'aborted' })
    holding = false
    release()
    signals.length = 0
    await one.prompt(spec.run, 'one more thing')
    await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 30_000 }).catch(
      failing,
    )
    expect(signals.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'ok' })
    const history = await one.history(spec.task, cwd, { limit: 30 })
    const sent = history.items.filter((item) => item.kind === 'sent').map((item) => item.text)
    expect(sent.at(-1)).toBe('one more thing')
  }, 240_000)
})

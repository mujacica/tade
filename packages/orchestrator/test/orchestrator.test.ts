import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Daemon } from '@wilco/daemon/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeModel,
  startFakeModel,
  writeProviderExtension,
} from '../../../test/fixtures/fake-model.ts'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { Orchestrator } from '../src/orchestrator.ts'

// The thing you talk to, driven by a scripted model: it answers, it reaches
// for Wilco's own tools, and it says when it has finished.

async function until(check: () => boolean | Promise<boolean>, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('Orchestrator', () => {
  let daemon: Daemon
  let model: FakeModel | null = null
  let orchestrator: Orchestrator | null = null
  let home: string
  let repo: ReturnType<typeof mkrepo>

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('wilco-chat-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    daemon = await Daemon.start({ home, socket: join(home, 'w.sock') })
  })

  afterEach(async () => {
    await orchestrator?.stop()
    await model?.close()
    await daemon.stop().catch(() => {})
    orchestrator = null
    model = null
  })

  async function start(options: Parameters<typeof startFakeModel>[0]) {
    model = await startFakeModel(options)
    const runDir = tmp('wilco-chat-run-')
    orchestrator = await Orchestrator.start({
      home,
      socket: daemon.socketPath,
      runDir,
      cwd: repo.root,
      model: { provider: 'wilco-test', id: 'fake' },
      args: ['-e', writeProviderExtension(runDir)],
      env: { ...process.env, WILCO_TEST_BASE_URL: model.url },
    })
    return orchestrator
  }

  it('answers, and says when it has finished', async () => {
    const said: string[] = []
    let idle = false
    const chat = await start({ finalText: 'Nothing is running.' })
    chat.onMessage((text) => said.push(text))
    chat.onIdle(() => {
      idle = true
    })

    await chat.ask('where are we')
    await until(() => said.length > 0)
    expect(said[0]).toBe('Nothing is running.')
    // Without this a surface would never know it could speak again.
    await until(() => idle)
  }, 90_000)

  it("reaches for Wilco's own tools and reports which one", async () => {
    const tools: string[] = []
    const chat = await start({
      tool: {
        name: 'wilco_task_create',
        arguments: { project: 'app', name: 'refunds', intent: 'the refund flow double-charges' },
      },
      finalText: 'Started it.',
    })
    chat.onTool((tool) => tools.push(tool))

    await chat.ask('start a task in app about the refund flow double-charging')
    await until(() => tools.includes('wilco_task_create'))

    // That signal fires BEFORE the tool runs, so wait for the effect itself.
    // On failure, report what the model was told: a tool that errored hands
    // the reason back rather than throwing, so it would otherwise be silent.
    await until(async () => (await daemon.log.read({ types: ['task_created'] })).length > 0).catch(
      () => {
        throw new Error(
          `task never created. The model was told: ${JSON.stringify(model?.requests[1] ?? {}).slice(
            0,
            600,
          )}`,
        )
      },
    )

    // The task exists and the intent is kept word for word.
    const [created] = await daemon.log.read({ types: ['task_created'] })
    expect(created?.task).toBe('app/refunds')
    expect(created?.detail.intent_spoken).toBe('the refund flow double-charges')
  }, 90_000)
})

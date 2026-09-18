import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { Orchestrator } from '../src/orchestrator.ts'
import { ToolHost } from '../src/tool-host.ts'

// The one test that uses a real model.
//
// Everything else in this repo runs against a scripted provider, which is what
// keeps the suite fast, offline and credential-free — and means none of it can
// tell you whether a real model can actually *choose* the right tool from the
// descriptions we wrote. That is the one question a fake model can never
// answer, because the fake one is told what to call.
//
// So this is gated behind TADE_LIVE=1: it costs money and needs credentials,
// and it runs before a release rather than in the inner loop. Skipped, it must
// never fail; run, it is the only evidence that the tool surface is usable.

const live = process.env.TADE_LIVE === '1'
const describeLive = live ? describe : describe.skip

describeLive('against a real model', () => {
  let tade: Workbench
  let tools: ToolHost
  let orchestrator: Orchestrator | null = null
  let home: string
  let repo: ReturnType<typeof mkrepo>

  beforeEach(async () => {
    repo = mkrepo()
    repo.commit('first')
    home = tmp('tade-live-')
    mkdirSync(home, { recursive: true })
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  app:\n    root: ${repo.root}\norchestrator:\n  model: ${
        process.env.TADE_LIVE_MODEL ?? 'claude-opus-5'
      }\n`,
    )
    tade = await Workbench.open({ home })
    tools = await ToolHost.listen({ tade, path: join(home, 'tools.sock') })
  })

  afterEach(async () => {
    await orchestrator?.stop().catch(() => {})
    await tools?.close().catch(() => {})
    await tade?.close().catch(() => {})
    orchestrator = null
  })

  async function ask(question: string): Promise<{ answer: string; tools: string[] }> {
    const used: string[] = []
    orchestrator = await Orchestrator.start({
      home,
      socket: tools.path,
      runDir: join(home, 'orchestrator'),
      cwd: repo.root,
      config: tade.config,
    })
    orchestrator.onTool((tool) => used.push(tool))
    const answer = await orchestrator.askFor(question, 180_000)
    return { answer, tools: used }
  }

  it('reaches for status when asked where things stand', async () => {
    // The assertion is about *choosing*: nothing here says which tool to use,
    // so this passes only if the descriptions we wrote are good enough for a
    // model that has never seen this codebase.
    const { answer, tools: used } = await ask('where are we?')
    expect(used).toContain('tade_status')
    expect(answer.length).toBeGreaterThan(0)
  }, 240_000)

  it('creates a task, keeping the words that were used', async () => {
    const intent = 'the refund flow double-charges when the webhook retries'
    const { tools: used } = await ask(`start a task in app called refunds: ${intent}`)
    expect(used).toContain('tade_task_create')

    const [created] = await tade.events({ types: ['task_created'] })
    expect(created?.task).toBe('app/refunds')
    // Verbatim: the one field nothing can reconstruct later. A model that
    // tidies it up here would be a model that quietly loses why you started.
    expect(created?.detail.intent_spoken).toBe(intent)
  }, 240_000)

  it('answers a question about the past from the journal, not from guessing', async () => {
    await tade.remember('the staging key rotates on the first', 'app', 'you')
    const { answer, tools: used } = await ask('what did I tell you about app?')
    expect(used.some((tool) => tool.startsWith('tade_'))).toBe(true)
    expect(answer.toLowerCase()).toContain('staging key')
  }, 240_000)
})

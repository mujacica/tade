import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PiAdapter } from '@tade/harnesses-pi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { Workbench } from '../src/workbench.ts'

// A route whose provider and model disagree in config.yaml: the old
// route-keeping wrote `provider: anthropic` beside `claude-opus-5`, and the
// model row later wrote OpenRouter's spelling over the model alone. Handed
// both, pi makes up an anthropic model of that name (`route-model.test.ts` in
// the pi harness asks pi itself), so new agents start on what the harness
// offers instead, and that is said once.

const INTENT = 'the refund flow double-charges when the webhook retries'

/** What pi offers here, as it would say once somebody is signed in. */
const OFFERED = [
  { id: 'anthropic/claude-opus-5', provider: 'anthropic', name: 'Claude Opus 5' },
  {
    id: 'openrouter/anthropic/claude-opus-4.5',
    provider: 'openrouter',
    name: 'Claude Opus 4.5',
  },
]

describe('new agents on a route whose provider and model disagree', () => {
  let client: Workbench | null = null

  afterEach(async () => {
    vi.restoreAllMocks()
    await client?.close().catch(() => {})
    client = null
  })

  /** A workbench over a config whose default route is `route`, three agents allowed. */
  async function open(
    route: string,
  ): Promise<{ bench: Workbench; repo: ReturnType<typeof mkrepo> }> {
    const repo = mkrepo()
    const home = tmp('tade-route-model-')
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  app:\n    root: ${repo.root}\n    max_parallel: 3\nworkers:\n  routes:\n    default:\n${route}`,
    )
    // Only what pi itself would answer is stood in for: its catalog, which
    // needs a sign-in.
    vi.spyOn(PiAdapter.prototype, 'models').mockResolvedValue(OFFERED)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    return { bench: client, repo }
  }

  async function started(bench: Workbench, slug: string): Promise<string[]> {
    const task = await bench.createTask({ project: 'app', slug, intent: INTENT })
    const lane = await bench.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })
    return lane.spec.args
  }

  it('start on the model the harness has, and are told why once', async () => {
    const { bench } = await open(
      '      provider: anthropic\n      model: openrouter/anthropic/claude-opus-4.5\n',
    )
    for (const slug of ['refunds', 'search']) {
      const args = await started(bench, slug)
      expect(args.join(' '), slug).toContain('--model openrouter/anthropic/claude-opus-4.5')
      expect(args, slug).not.toContain('--provider')
    }
    const said = (await bench.events({ types: ['warning'] }))
      .map((event) => String(event.detail?.message ?? ''))
      .filter((message) => message.includes('workers.routes.default.provider'))
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('anthropic')
    expect(said[0]).toContain('Settings › Models')
  }, 60_000)

  it('keep a pair that is the provider’s own, and say nothing', async () => {
    // The same shape is one of OpenRouter's, which only its catalog can tell.
    const { bench } = await open(
      '      provider: openrouter\n      model: anthropic/claude-opus-4.5\n',
    )
    const args = (await started(bench, 'refunds')).join(' ')
    expect(args).toContain('--provider openrouter --model anthropic/claude-opus-4.5')
    const said = (await bench.events({ types: ['warning'] })).map((event) =>
      String(event.detail?.message ?? ''),
    )
    expect(said.filter((message) => message.includes('workers.routes'))).toEqual([])
  }, 60_000)
})

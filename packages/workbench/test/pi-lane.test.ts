import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PiAdapter } from '@tade/harnesses-pi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { Workbench } from '../src/workbench.ts'

// pi has drawn fullscreen by default since 1.0: on the alternate screen, where
// a lane keeps no scrollback. An agent's lane keeps its history, so pi is
// started in its regular mode — in the lane as launched, not only in what
// the adapter would say if asked.

describe('a pi agent’s lane', () => {
  let client: Workbench | null = null

  afterEach(async () => {
    vi.restoreAllMocks()
    await client?.close().catch(() => {})
    client = null
  })

  it('starts pi in its regular mode, so the lane keeps its scrollback', async () => {
    const repo = mkrepo()
    const home = tmp('tade-pi-lane-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    // Only what pi itself would answer is stood in for: its catalog, which
    // needs a sign-in.
    vi.spyOn(PiAdapter.prototype, 'models').mockResolvedValue([
      { id: 'anthropic/claude-opus-5', provider: 'anthropic', name: 'Claude Opus 5' },
    ])
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: 'the refund flow double-charges when the webhook retries',
    })
    const lane = await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })

    const regular = (args: readonly string[] | undefined) =>
      (args ?? []).some((arg, i) => arg === '--tui-mode' && args?.[i + 1] === 'regular')
    expect(regular(lane.spec.args)).toBe(true)
    const launched = (await client.driver.list()).find((one) => one.id === lane.id)
    expect(regular(launched?.spec.args)).toBe(true)
  }, 60_000)
})

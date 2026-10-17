import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Config, loadConfig, type ThinkingLevel } from '@tade/core'
import { describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { keptOnRoute } from '../src/config-kept.ts'
import { Workbench } from '../src/workbench.ts'

// What a change an agent was moved to does for new agents: kept on its
// project's route, or not, and why — the orchestrator held to `settingReach`,
// and a write that failed said rather than swallowed. The agent has switched
// either way, so neither is thrown — nor a journal that would not take the
// line saying it was kept.

const ROUTE = 'workers:\n  routes:\n    default:\n      harness: pi\n      provider: anthropic\n'

/** A home whose config is `text`, and the config it loads as. */
async function homeWith(text: string): Promise<{ home: string; config: Config }> {
  const home = tmp('tade-kept-')
  writeFileSync(join(home, 'config.yaml'), text)
  const loaded = await loadConfig(join(home, 'config.yaml'))
  if (!loaded.ok) throw new Error(loaded.issues[0]?.message)
  return { home, config: loaded.config }
}

describe('keeping what an agent was moved to for new agents', () => {
  it('keeps the orchestrator’s model where the route already sends work to its provider', async () => {
    const { home, config } = await homeWith(ROUTE)
    const kept = keptOnRoute(home, config, {
      task: 'app/refunds',
      change: { provider: 'anthropic', model: 'claude-opus-5' },
      harness: 'pi',
      by: 'orchestrator',
    })
    expect(kept.kept && kept.changes).toEqual([
      { path: 'workers.routes.default.model', was: '', now: 'claude-opus-5', by: 'orchestrator' },
    ])
  })

  it('keeps nothing of the orchestrator’s that is not its to change, and says whose it is', async () => {
    const { home, config } = await homeWith(ROUTE)
    const elsewhere = keptOnRoute(home, config, {
      task: 'app/refunds',
      change: { provider: 'openai', model: 'gpt-5' },
      harness: 'pi',
      by: 'orchestrator',
    })
    // Not the model without its provider either: that is a route nobody chose.
    expect(elsewhere).toEqual({
      kept: false,
      why: expect.stringMatching(
        /^workers\.routes\.default\.provider is not mine to change — .*Changing the route is the person's, in Settings/,
      ),
    })
    // A thinking level for an agent in another harness than the route's lives
    // under the route too, where `ALLOWED_UNDER` names nothing.
    const thinking = keptOnRoute(home, config, {
      task: 'app/refunds',
      change: { thinking: 'high' },
      harness: 'claude-code',
      by: 'orchestrator',
    })
    expect(thinking.kept === false && thinking.why).toMatch(
      /^workers\.routes\.default\.harnesses\.claude-code\.thinking is not mine to change/,
    )
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(ROUTE)
    // The person, in the window, moves the route as they choose.
    const theirs = keptOnRoute(home, config, {
      task: 'app/refunds',
      change: { provider: 'openai', model: 'gpt-5' },
      harness: 'pi',
      by: 'window',
    })
    expect(theirs.kept && theirs.changes.map((one) => one.path)).toEqual([
      'workers.routes.default.provider',
      'workers.routes.default.model',
    ])
  })

  it('says a route it could not write, and leaves the file as it was', async () => {
    const { home, config } = await homeWith(ROUTE)
    const refused = keptOnRoute(home, config, {
      task: 'app/refunds',
      change: { thinking: 'ludicrous' as ThinkingLevel },
      harness: 'pi',
      by: 'window',
    })
    expect(refused).toEqual({
      kept: false,
      why: expect.stringMatching(
        /^the route could not be written: that would make config\.yaml invalid/,
      ),
    })
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(ROUTE)
  })

  it('says kept, and that the journal would not take its line, rather than throw', async () => {
    const { home } = await homeWith(ROUTE)
    const client = await Workbench.open({ home, version: '9.9.9' })
    try {
      vi.spyOn(client.log, 'append').mockRejectedValue(new Error('ENOSPC: no space left'))
      const kept = await client.keepAgentRoute('app/refunds', { model: 'claude-opus-5' }, 'pi')
      expect(kept).toEqual({
        kept: true,
        unrecorded:
          'workers.routes.default.model is written, but the journal would not take the line that says so: ENOSPC: no space left',
      })
      expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('model: claude-opus-5')
    } finally {
      vi.restoreAllMocks()
      await client.close()
    }
  })
})

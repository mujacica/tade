import { type Arm, ConfigSchema } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { FakeAdapter } from '../../workbench/test/workers-harness.ts'
import { Orchestrator } from '../src/orchestrator.ts'

// The person's own device, through a harness that cannot hold its own tool
// calls — Claude Code's and Codex's shape. Sentry TADE-4 was this harness
// warning at every start that nothing from away would be answered, and every
// message from the person's phone refused: a phone with full access is them,
// so its turn needs no narrowing and is run as the keyboard's.

/** A harness that takes Tade's tools as a server and cannot hold one of its own calls. */
function claudeShaped(): FakeAdapter {
  const adapter = new FakeAdapter()
  adapter.capabilities.mcp = true
  adapter.capabilities.nativeExtensions = false
  adapter.capabilities.permissionGate = false
  adapter.capabilities.why.nativeExtensions =
    'has no place for pi extensions: their tools and skills still reach it, their own code does not'
  return adapter
}

const yours: Arm = { how: 'owner', device: 'a1b2c3d4e5f60718', theirs: true }
const narrowedOne: Arm = { how: 'remote', device: 'a1b2c3d4e5f60718', projects: null, may: [] }

describe('the person’s own device, on a harness that cannot be narrowed', () => {
  const started: Orchestrator[] = []
  afterEach(async () => {
    for (const one of started.splice(0)) await one.stop()
  })

  const start = async (adapter: FakeAdapter, warnings: string[]) => {
    const runDir = tmp('tade-owner-away-run-')
    const one = await Orchestrator.start({
      home: tmp('tade-owner-away-'),
      socket: '/nowhere.sock',
      runDir,
      cwd: runDir,
      config: ConfigSchema.parse({}),
      adapter,
      onWarning: (said) => warnings.push(said),
    })
    started.push(one)
    return one
  }

  it('says nothing at start-up about a paired device not being answered', async () => {
    const warnings: string[] = []
    await start(claudeShaped(), warnings)
    expect(warnings.filter((one) => /paired device|from away/.test(one))).toEqual([])
  })

  it('answers the person’s own device, told as their own words', async () => {
    const adapter = claudeShaped()
    const one = await start(adapter, [])
    await one.askFrom('turn the commit judge on', yours)
    const asked = adapter.prompted.at(-1)?.message ?? ''
    expect(asked).toContain('the person’s own device')
    expect(asked).toContain('What they said:')
    expect(asked).not.toContain('What a paired device asked:')
    expect(asked).toContain('turn the commit judge on')
    // The lease is the owner's, which every gate answers as the keyboard's.
    expect(one.arm).toEqual(yours)
  })

  it('still refuses a device somebody narrowed, and says why', async () => {
    const adapter = claudeShaped()
    const one = await start(adapter, [])
    expect(one.unarmed).not.toBeNull()
    await expect(one.askFrom('push it', narrowedOne)).rejects.toThrow(
      /cannot answer a paired device here/,
    )
    expect(adapter.prompted).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { againForToolsAt, TOOLS_AGAIN, TOOLS_AGAIN_MS } from '../src/orchestrating.ts'

// How often the orchestrator is started again because its tools did not
// connect. A server that missed its deadline on a loaded machine usually makes
// the next one; one that never comes up must not be a restart every turn.

describe('starting it again for its tools', () => {
  const now = 10 * TOOLS_AGAIN_MS

  it('goes ahead the first times, and writes each down', () => {
    expect(againForToolsAt([], now)).toEqual([now])
    expect(againForToolsAt([now - 1_000], now)).toEqual([now - 1_000, now])
  })

  it(`stops at ${TOOLS_AGAIN} within the hour`, () => {
    const twice = [now - 2_000, now - 1_000]
    expect(twice).toHaveLength(TOOLS_AGAIN)
    expect(againForToolsAt(twice, now)).toBeNull()
  })

  it('counts only the last hour, so a later spell of load is answered again', () => {
    expect(againForToolsAt([now - TOOLS_AGAIN_MS, now - TOOLS_AGAIN_MS - 1], now)).toEqual([now])
    expect(againForToolsAt([now - TOOLS_AGAIN_MS, now - 1_000], now)).toEqual([now - 1_000, now])
  })
})

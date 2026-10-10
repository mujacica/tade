import { describe, expect, it } from 'vitest'
import { gateTools, type Rpc, type ToolCallGate } from '../src/tools-gate.ts'

// The gate on every tool the orchestrator has, over the four answers it can
// get back.
//
// **The one that matters most is the third**: a socket that cannot be answered
// means *allow*, and that is a decision with an argument rather than a
// shortcut — the thing that answers `origin/allow` is the window, and the
// window is also the only thing that can serve a message from a paired device.
// No window, no remote turn, nobody to narrow. Failing closed there would
// break the orchestrator of a window that died, for no safety at all.

/** A harness that records its hook, so a test can call it as pi would. */
function harness(): {
  pi: { on(event: 'tool_call', hook: (e: { toolName?: unknown }) => Promise<ToolCallGate>): void }
  call(tool: unknown): Promise<ToolCallGate>
} {
  let hook: ((e: { toolName?: unknown }) => Promise<ToolCallGate>) | null = null
  return {
    pi: {
      on(_event, one) {
        hook = one
      },
    },
    call: (tool) =>
      hook === null
        ? Promise.reject(new Error('nothing registered a hook'))
        : hook({ toolName: tool }),
  }
}

describe('the gate before every tool call', () => {
  it('lets a call through when Tade says so', async () => {
    const made = harness()
    const asked: Record<string, unknown>[] = []
    const rpc: Rpc = async (method, params) => {
      asked.push({ method, ...params })
      return { allow: true }
    }
    gateTools(made.pi, rpc)
    expect(await made.call('bash')).toEqual({})
    expect(asked).toEqual([{ method: 'origin/allow', tool: 'bash' }])
  })

  it('blocks it with Tade’s sentence when Tade says no', async () => {
    const made = harness()
    const rpc: Rpc = async () => ({ allow: false, reason: 'needs the person at the machine' })
    gateTools(made.pi, rpc)
    expect(await made.call('bash')).toEqual({
      block: true,
      reason: 'needs the person at the machine',
    })
  })

  it('lets it through when the socket cannot be answered at all', async () => {
    const made = harness()
    gateTools(made.pi, () => Promise.reject(new Error('ENOENT')))
    expect(await made.call('bash')).toEqual({})
  })

  it('blocks it, with words of its own, on an answer it cannot read', async () => {
    // Anything but a plain yes is a no: an answer this cannot read is a window
    // that has changed under it, and *allow* is the wrong way to be wrong
    // about that. The empty answer is the one a socket gives when a method
    // returns nothing, which is why it is here by name.
    const made = harness()
    for (const said of [null, {}, { allow: 'yes' }, { allow: false }, 'nonsense']) {
      gateTools(made.pi, async () => said)
      const came = await made.call('bash')
      expect(came.block, JSON.stringify(said)).toBe(true)
      expect(came.reason, JSON.stringify(said)).toContain('bash')
    }
  })

  it('names the tool as the empty string where the harness gave none', async () => {
    const made = harness()
    const asked: unknown[] = []
    gateTools(made.pi, async (_method, params) => {
      asked.push(params.tool)
      return { allow: true }
    })
    await made.call(undefined)
    await made.call(7)
    expect(asked).toEqual(['', ''])
  })

  it('registers nothing on a harness with no hook, rather than pretending', async () => {
    // A harness that offers none cannot be gated, and `canBeArmed` is what
    // keeps a remote turn off it. Registering a hook that could not run would
    // be the comfortable half of that.
    let touched = false
    gateTools({}, async () => {
      touched = true
      return { allow: false }
    })
    expect(touched).toBe(false)
  })
})

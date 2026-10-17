import { describe, expect, it } from 'vitest'
import { remoteMethods } from '../src/host-remotes.ts'
import { remoteTools } from '../src/tools-remotes.ts'

// Passing a sentence to another machine's orchestrator: the tool a model
// reads, and the method behind it. What may reach it is `origin.ts`'s
// (`origin.test.ts`), and the person's line naming the machine is the
// window's; what is here is that both halves carry exactly the three things
// and that no window is said as no window.

describe('passing a sentence to another machine', () => {
  it('carries the machine, the sentence and their line, and nothing else', async () => {
    const asked: { method: string; params: Record<string, unknown> }[] = []
    const [tool] = remoteTools(async (method, params) => {
      asked.push({ method, params })
      return 'passed on'
    })
    expect(tool?.name).toBe('tade_remote_tell')
    expect(tool?.parameters).toMatchObject({ required: ['machine', 'said', 'asked'] })
    const answer = await tool?.run(
      {
        machine: 'vps',
        said: 'start the release',
        asked: 'ask vps to start the release',
        extra: 1,
      },
      'call-1',
      {} as never,
    )
    expect(answer).toBe('passed on')
    expect(asked).toEqual([
      {
        method: 'remote/tell',
        params: {
          machine: 'vps',
          said: 'start the release',
          asked: 'ask vps to start the release',
        },
      },
    ])
  })

  it('is the window’s, and says so where no window is open', async () => {
    const told: unknown[] = []
    const methods = remoteMethods(() => ({
      tell: async (req) => {
        told.push(req)
        return 'passed on'
      },
    }))
    await expect(methods['remote/tell']?.({ machine: 'vps', said: 'x' })).resolves.toBe('passed on')
    expect(told).toEqual([{ machine: 'vps', said: 'x', asked: '' }])
    await expect(remoteMethods(() => undefined)['remote/tell']?.({})).rejects.toThrow(
      'no window is open',
    )
  })
})

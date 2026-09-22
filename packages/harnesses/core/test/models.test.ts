import { describe, expect, it } from 'vitest'
import {
  type HarnessModel,
  modelsOffered,
  type WorkerAdapter,
  type WorkerCapabilities,
} from '../src/port.ts'

// What a harness runs is the harness's own to say, and an empty answer is an
// answer about that harness — never a reason to reach for somebody else's
// catalog. A model of another harness is no model at all here.

const adapter = (id: string, models: () => Promise<HarnessModel[]>, why?: string): WorkerAdapter =>
  ({
    id,
    capabilities: { why: why ? { models: why } : {} } as WorkerCapabilities,
    models,
  }) as unknown as WorkerAdapter

const opus: HarnessModel = {
  id: 'anthropic/claude-opus-5',
  provider: 'anthropic',
  name: 'Claude Opus 5',
}

describe('what a harness offers to run', () => {
  it('comes back as that harness’s, with nothing to explain', async () => {
    expect(await modelsOffered(adapter('pi', async () => [opus]))).toEqual({
      harness: 'pi',
      models: [opus],
      why: null,
    })
  })

  it('says so in the harness’s own words when it has none to offer', async () => {
    const offered = await modelsOffered(
      adapter('codex', async () => [], 'names its own models, and the codex here did not answer'),
    )
    expect(offered).toEqual({
      harness: 'codex',
      models: [],
      why: 'names its own models, and the codex here did not answer',
    })
  })

  it('still says something where the harness declared no sentence', async () => {
    // Nothing may fall back to another harness's list, so there is always a
    // sentence — the harness's where it wrote one, a plain one where it did not.
    const offered = await modelsOffered(adapter('pi', async () => []))
    expect(offered.models).toEqual([])
    expect(offered.why).toBe('could not say which models it runs')
  })

  it('never throws: a harness that fell over has nothing to offer, which is an answer', async () => {
    const offered = await modelsOffered(
      adapter(
        'codex',
        async () => {
          throw new Error('codex: command not found')
        },
        'names its own models, and the codex here did not answer',
      ),
    )
    expect(offered.models).toEqual([])
    expect(offered.why).toContain('did not answer')
  })
})

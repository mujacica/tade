import type { Workspace } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { Forecast } from '../src/wire/forecast.ts'

// What the forecast does when it cannot write down what it would tell: says so
// once, tells nothing it could not write down, and tells it once it can.

const world = {
  projects: [
    {
      name: 'app',
      tasks: [],
      conflicts: [{ kind: 'hunks', tasks: ['app/a', 'app/b'], files: ['x.ts'] }],
    },
  ],
} as unknown as Workspace

function wired(append: () => Promise<void>) {
  return {
    live: { world, queueFacts: () => ({ events: [] }), queued: [] },
    opts: { config: { queue: { holds: 'orchestrator' } }, client: { log: { append } } },
  } as never
}

describe('telling what would collide', () => {
  it('says once that it could not, tells nothing it could not write down, then tells it', async () => {
    let refusing = true
    const told: string[] = []
    const said: string[] = []
    const forecast = new Forecast(
      wired(async () => {
        if (refusing) throw new Error('the journal is closed')
      }),
      {
        tell: async (text) => {
          told.push(text)
        },
        news: () => {},
        said: (text) => said.push(text),
      },
    )
    await forecast.look()
    await forecast.look()
    expect(told).toEqual([])
    expect(said).toEqual([
      'could not tell the orchestrator about work that would collide: the journal is closed',
    ])
    refusing = false
    await forecast.look()
    await forecast.look()
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('app/a and app/b both have uncommitted changes in x.ts')
  })
})

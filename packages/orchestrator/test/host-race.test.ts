import { join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import type { RaceHost } from '../src/host-race.ts'
import { ToolHost } from '../src/tool-host.ts'
import { raceTools } from '../src/tools-race.ts'
import { call } from './host-harness.ts'

// Starting, reading and picking a race, from the tool to the window and back.
//
// Whether a pick may happen — a line of the person's asking for one — is the
// window's (`wire/races.ts`, held by `test/wire/races.test.ts`), so what is
// held here is that the host hands each act there with what it was given, read
// carefully, that a refusal reaches the model as a failed call, and that with
// no window there is no queue to start one, said rather than answered emptily.

describe('a race, from the tool to the window', () => {
  let host: ToolHost | null = null

  afterEach(async () => {
    await host?.close()
    host = null
  })

  async function listening(race?: RaceHost): Promise<string> {
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade: {} as Workbench, path, ...(race ? { race } : {}) })
    return path
  }

  it('hands each act to the window, with what it was given', async () => {
    const asked: unknown[] = []
    const path = await listening({
      start: async (req) => {
        asked.push({ start: req })
        return 'Made app/dark-1 and app/dark-2.'
      },
      standing: async (req) => {
        asked.push({ standing: req })
        return 'Race dark in app: 2 entrants.'
      },
      pick: async (req) => {
        asked.push({ pick: req })
        throw new Error('Nothing they have said since dark began asks me to pick')
      },
    })
    expect(
      (
        await call(path, 'race/start', {
          project: 'app',
          name: 'dark',
          said: 'add a dark mode',
          prompt: 'Add it.',
          entrants: [
            { harness: ' codex ', model: '' },
            { model: 'sonnet', colour: 'blue' },
          ],
          n: 2,
        })
      ).result,
    ).toBe('Made app/dark-1 and app/dark-2.')
    expect((await call(path, 'race/standing', { race: 'dark' })).result).toMatch(/2 entrants/)
    expect(
      (await call(path, 'race/pick', { race: 'dark', task: 'dark-2', why: 'smaller', said: 'hm' }))
        .error?.message,
    ).toMatch(/asks me to pick/)
    expect(asked).toEqual([
      {
        start: {
          project: 'app',
          name: 'dark',
          said: 'add a dark mode',
          prompt: 'Add it.',
          // Trimmed, empty dropped, and nothing but a harness and a model kept.
          entrants: [{ harness: 'codex' }, { model: 'sonnet' }],
          n: 2,
        },
      },
      { standing: { race: 'dark' } },
      { pick: { race: 'dark', task: 'dark-2', why: 'smaller', said: 'hm' } },
    ])
  })

  it('refuses entrants that are not a list of entrants, before the window is asked', async () => {
    const path = await listening({
      start: async () => 'made',
      standing: async () => '',
      pick: async () => '',
    })
    expect((await call(path, 'race/start', { entrants: 'claude' })).error?.message).toMatch(
      /entrants is a list/,
    )
    expect((await call(path, 'race/start', { entrants: ['claude'] })).error?.message).toMatch(
      /entrants\[0\] is not an entrant/,
    )
  })

  it('says there is no window to start one in, rather than answering emptily', async () => {
    const path = await listening()
    for (const method of ['race/start', 'race/standing', 'race/pick']) {
      expect((await call(path, method, {})).error?.message, method).toMatch(
        /needs the Tade window open/,
      )
    }
  })
})

describe('the race tools a model reads', () => {
  it('are three, each saying when to reach for it and what it may not do', () => {
    const tools = raceTools(async () => '')
    expect(tools.map((one) => one.name)).toEqual([
      'tade_race',
      'tade_race_standing',
      'tade_race_pick',
    ])
    const [start, standing, pick] = tools
    expect(start?.description).toMatch(/best-of-N/)
    expect(start?.description).toMatch(/Nothing is picked/)
    expect(standing?.description).toMatch(/The order is not a pick/)
    expect(pick?.description).toMatch(/Only when they asked you to pick/)
    expect(pick?.parameters).toMatchObject({ required: ['race', 'task', 'why', 'said'] })
  })
})

import { join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import type { ReplayHost } from '../src/host-replay.ts'
import { ToolHost } from '../src/tool-host.ts'
import { replayTools } from '../src/tools-replay.ts'
import { call } from './host-harness.ts'

// Starting and reading a replay, from the tool to the window and back.
//
// Whether one may start — a line of the person's asking for an eval — is the
// window's (`wire/replays.ts`, held by `app/test/wire/replays.test.ts`), so
// what is held here is that the host hands each act there read carefully, that
// no ceiling is refused before the window is asked, and that with no window
// there is no queue to start one, said rather than answered emptily.

describe('a replay, from the tool to the window', () => {
  let host: ToolHost | null = null

  afterEach(async () => {
    await host?.close()
    host = null
  })

  async function listening(replay?: ReplayHost): Promise<string> {
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade: {} as Workbench, path, ...(replay ? { replay } : {}) })
    return path
  }

  it('hands each act to the window, with what it was given', async () => {
    const asked: unknown[] = []
    const path = await listening({
      start: async (req) => {
        asked.push({ start: req })
        return 'Replay night made.'
      },
      standing: async (req) => {
        asked.push({ standing: req })
        return 'Replay night in app.'
      },
    })
    expect(
      (
        await call(path, 'replay/start', {
          project: 'app',
          name: ' night ',
          said: 'eval sonnet on my last three, two dollars at most',
          model: 'sonnet',
          harness: '',
          last: 3,
          ceiling_usd: 2,
          at: '2026-10-17T01:00:00.000Z',
        })
      ).result,
    ).toBe('Replay night made.')
    expect((await call(path, 'replay/standing', { replay: 'night' })).result).toBe(
      'Replay night in app.',
    )
    expect(asked).toEqual([
      {
        start: {
          project: 'app',
          name: 'night',
          said: 'eval sonnet on my last three, two dollars at most',
          // An empty harness is no harness: the model moves, the harness is held.
          candidate: { model: 'sonnet' },
          ceilingUsd: 2,
          last: 3,
          at: '2026-10-17T01:00:00.000Z',
        },
      },
      { standing: { replay: 'night' } },
    ])
  })

  it('refuses one with no ceiling, or a number that is not one, before the window is asked', async () => {
    const asked: unknown[] = []
    const path = await listening({
      start: async (req) => {
        asked.push(req)
        return 'made'
      },
      standing: async () => '',
    })
    expect((await call(path, 'replay/start', { project: 'app' })).error?.message).toMatch(
      /ask them the most it may spend/,
    )
    expect(
      (await call(path, 'replay/start', { ceiling_usd: 2, last: 'five' })).error?.message,
    ).toMatch(/last is a number/)
    expect(asked).toEqual([])
  })

  it('says there is no window to start one in, rather than answering emptily', async () => {
    const path = await listening()
    for (const method of ['replay/start', 'replay/standing']) {
      expect((await call(path, method, { ceiling_usd: 1 })).error?.message, method).toMatch(
        /needs the Tade window open/,
      )
    }
  })
})

describe('the replay tools a model reads', () => {
  it('say when to reach for them, that it costs money, and that nothing is picked', () => {
    const tools = replayTools(async () => '')
    expect(tools.map((one) => one.name)).toEqual(['tade_replay', 'tade_replay_standing'])
    const [start, standing] = tools
    expect(start?.description).toMatch(/only then: it spends real money/)
    expect(start?.description).toMatch(/never counted as fails/)
    expect(start?.parameters).toMatchObject({
      required: ['project', 'name', 'said', 'ceiling_usd'],
    })
    expect(standing?.description).toMatch(/nothing here picks a model/)
  })
})

import { join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import type { UpdateHost } from '../src/host-machine.ts'
import { ToolHost } from '../src/tool-host.ts'
import { machineTools } from '../src/tools-machine.ts'
import { call } from './host-harness.ts'

// Updating what Tade runs and reloading the window, from the tool to the
// window and back.
//
// The boundary — whether the person's own words asked for it — lives in the
// window (`wire/updates.ts`, held by `wire/updates.test.ts`), so what is held
// here is that the host hands each act there with what it was given, that a
// refusal reaches the model as a tool that failed, and that with no window
// there is nothing to run them in, said rather than answered emptily.

describe('updating and reloading, from the tool to the window', () => {
  let host: ToolHost | null = null

  afterEach(async () => {
    await host?.close()
    host = null
  })

  async function listening(updates?: UpdateHost): Promise<string> {
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade: {} as Workbench, path, ...(updates ? { updates } : {}) })
    return path
  }

  it('hands each act to the window, with what it was given', async () => {
    const asked: unknown[] = []
    const path = await listening({
      read: async (check) => {
        asked.push({ read: check })
        return '{"asked": true}'
      },
      run: async (req) => {
        asked.push({ run: req })
        if (req.said === 'nothing') throw new Error('Nothing they have said asks for an update')
        return 'Updated gh to 2.41.'
      },
      reload: async (req) => {
        asked.push({ reload: req })
        return 'Reloading in a moment.'
      },
    })
    expect((await call(path, 'updates/read', { check: true })).result).toBe('{"asked": true}')
    expect((await call(path, 'updates/run', { which: ['gh', 7], said: 'upgrade gh' })).result).toBe(
      'Updated gh to 2.41.',
    )
    // A refusal is a failed call, in the window's words.
    expect((await call(path, 'updates/run', { said: 'nothing' })).error?.message).toMatch(
      /asks for an update/,
    )
    expect((await call(path, 'window/reload', { said: 'reload' })).result).toBe(
      'Reloading in a moment.',
    )
    expect(asked).toEqual([
      { read: true },
      // Read as text whatever a model put in the list.
      { run: { which: ['gh', '7'], said: 'upgrade gh' } },
      { run: { which: [], said: 'nothing' } },
      { reload: { said: 'reload' } },
    ])
  })

  it('says there is no window to run them in, rather than answering emptily', async () => {
    const path = await listening()
    for (const method of ['updates/read', 'updates/run', 'window/reload']) {
      expect((await call(path, method, {})).error?.message, method).toMatch(/no window is open/)
    }
  })
})

describe('the tools a model reads', () => {
  const tools = (rpc: (method: string) => Promise<unknown>, cli: string[][] = []) =>
    machineTools(
      async (method) => rpc(method),
      async (args) => {
        cli.push(args)
        return '{"from": "the cli"}'
      },
    )

  it('reads what is current from the window, and from the CLI where there is none', async () => {
    const window = tools(async () => '{"from": "the window"}')
    expect(
      await window.find((one) => one.name === 'tade_updates')?.run({}, 'id', { cwd: '' }),
    ).toBe('{"from": "the window"}')
    const cli: string[][] = []
    const none = tools(async () => {
      throw new Error('TADE_SOCKET is not set')
    }, cli)
    const read = none.find((one) => one.name === 'tade_updates')
    expect(await read?.run({ check: true }, 'id', { cwd: '' })).toBe('{"from": "the cli"}')
    expect(cli).toEqual([['update', '--json', '--check']])
  })
})

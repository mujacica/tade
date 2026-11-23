import { join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { ToolHost } from '../src/tool-host.ts'
import { call } from './host-harness.ts'

// One of the orchestrator's own tools run on another machine of the person's
// (`tade_remote_act`): inside it, every call the tool makes back to Tade goes
// to that machine as `remote/act`, under a key of its own, with the person's
// words; the host hands that to whoever acts on other machines; and an act
// another machine sends here is judged by the same gate as any call.

describe('a tool run on another machine', () => {
  let host: ToolHost | null = null
  afterEach(async () => {
    await host?.close()
    host = null
  })

  it('sends each call the tool makes there, keyed, and hands back what that machine answered', async () => {
    const asked: unknown[] = []
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({
      tade: {} as Workbench,
      path,
      acts: {
        act: async (req) => {
          asked.push(req)
          // The machine there answers its own status, where the task's worktree is.
          if (req.method === 'status/read') {
            return { projects: [{ tasks: [{ id: 'api/migrate', worktree: '/srv/api' }] }] }
          }
          return `done on ${req.machine}`
        },
      },
    })
    // The tools read their socket once, as pi or the MCP server loads them.
    process.env.TADE_SOCKET = path
    const { orchestratorTools } = await import('../src/tools-extension.ts')
    const tools = orchestratorTools()
    const act = tools.find((one) => one.name === 'tade_remote_act')
    if (!act) throw new Error('no tade_remote_act')
    const said = await act.run(
      {
        machine: 'vps',
        tool: 'tade_park',
        input: { task: 'api/migrate' },
        asked: 'park the migrate work on the vps',
      },
      'call-1',
      { cwd: '/' },
    )
    expect(said).toContain('done on vps')
    // Two calls there, each its own key: the task looked up there, then parked there.
    expect(asked).toMatchObject([
      {
        machine: 'vps',
        asked: 'park the migrate work on the vps',
        key: 'call-1:1',
        method: 'status/read',
      },
      {
        machine: 'vps',
        key: 'call-1:2',
        method: 'task/park',
        params: { parked: true, task: 'api/migrate' },
      },
    ])

    // Tools about this machine or this conversation alone are refused, in words.
    await expect(
      act.run({ machine: 'vps', tool: 'tade_remote_tell', input: {}, asked: 'x' }, 'call-2', {
        cwd: '/',
      }),
    ).rejects.toThrow('about this machine or this conversation alone')
    await expect(
      act.run({ machine: 'vps', tool: 'tade_nothing', input: {}, asked: 'x' }, 'call-3', {
        cwd: '/',
      }),
    ).rejects.toThrow('I have no tool called tade_nothing')
  })

  it('says nothing here acts on another machine where nobody wired it', async () => {
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade: {} as Workbench, path })
    const answer = await call(path, 'remote/act', {
      machine: 'vps',
      method: 'worker/park',
      params: {},
    })
    expect(answer.error?.message).toBe('nothing here acts on another machine')
  })

  it('judges an act from another machine by the same gate, and never sends one on to a third', async () => {
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({
      tade: {} as Workbench,
      path,
      acts: { act: async () => 'sent on' },
    })
    const owner = { how: 'owner' as const, device: 'machine mac', theirs: true }
    await expect(host.act('remote/act', {}, owner)).rejects.toThrow(
      'an act from another machine is not sent on to a third',
    )
    await expect(host.act('nothing/here', {}, owner)).rejects.toThrow(
      'no such method: nothing/here',
    )
    // A narrowed arm is held to the narrowed table, here as everywhere.
    await expect(
      host.act('worker/stop', { run: 'x' }, { how: 'remote', device: 'd', projects: [], may: [] }),
    ).rejects.toThrow()
  })
})

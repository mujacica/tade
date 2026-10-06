import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHATS } from '@tade/core'
import type { LaneRecord, Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { ToolHost } from '../src/tool-host.ts'

// What the orchestrator can do about a chat: see the ones that are open, open
// one, and steer or stop it.
//
// Both ends are real — its own tools, over a real socket, to a real `ToolHost`
// — and only the workbench is scripted, so what is asserted is the whole path
// a spoken "give me an agent to talk to" takes. There are no chat verbs for
// steering and stopping on purpose: a chat is an agent, so the tools that steer
// and stop agents are the ones that do it, by the id the list hands back.

interface Tool {
  name: string
  run(params: Record<string, unknown>, callId: string, ctx: unknown): Promise<unknown>
}

/** A lane as the registry keeps one, as thin as `chatsFrom` reads it. */
function lane(over: Partial<LaneRecord> & { id: string }): LaneRecord {
  return {
    task: over.id.split('/').slice(0, 2).join('/'),
    kind: 'agent',
    spec: { id: over.id, cwd: '/somewhere', command: 'pi', args: [] },
    pid: 101,
    startedAt: 1,
    title: over.id,
    alive: true,
    exitCode: null,
    lastOutputAt: null,
    ...over,
  } as LaneRecord
}

describe('the orchestrator and the chats', () => {
  let host: ToolHost | null = null
  const started: Record<string, unknown>[] = []
  const steered: string[] = []
  const stopped: string[] = []
  let open: LaneRecord[] = []

  const tade = {
    lanes: () => open,
    events: async () => [],
    async startAgent(request: Record<string, unknown>) {
      started.push(request)
      const id = `${String(request.task)}/agent`
      open = [
        ...open,
        lane({ id, harness: 'pi', spec: { ...lane({ id }).spec, cwd: String(request.cwd) } }),
      ]
      return open.at(-1)
    },
    async steerAgent(task: string, message: string) {
      steered.push(`${task}: ${message}`)
    },
    async stopAgent(task: string) {
      stopped.push(task)
    },
  } as unknown as Workbench

  /** Tade's own tools, pointed at a real host over that workbench. */
  async function tools(): Promise<(name: string) => Tool> {
    started.length = 0
    steered.length = 0
    stopped.length = 0
    open = []
    const path = join(tmp('tade-chat-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade, path })
    vi.resetModules()
    process.env.TADE_SOCKET = path
    const loaded = (await import('../src/tools-extension.ts')) as {
      orchestratorTools(o?: unknown): Tool[]
    }
    const list = loaded.orchestratorTools({})
    return (name: string) => {
      const found = list.find((tool) => tool.name === name)
      if (!found) throw new Error(`no tool called ${name}`)
      return found
    }
  }

  afterEach(async () => {
    await host?.close()
    host = null
    delete process.env.TADE_SOCKET
    vi.resetModules()
  })

  it('opens one in the person’s own folder, with no project and no task of its own', async () => {
    const by = await tools()
    const opened = (await by('tade_chat_open').run({}, 'c1', {})) as Record<string, unknown>

    expect(opened).toMatchObject({ id: `${CHATS}/1/agent`, task: `${CHATS}/1`, project: '' })
    expect(started).toEqual([
      {
        task: `${CHATS}/1`,
        cwd: homedir(),
        // No boundary writes are measured against, because a chat owns no
        // files and stands where every file the person owns is. And no
        // extension tools: every one of them is about a task's files.
        worktree: '',
        prompt: '',
        extras: {},
      },
    ])
  })

  it('opens one in the harness that was asked for, with what to ask it first', async () => {
    const by = await tools()
    await by('tade_chat_open').run(
      { harness: 'codex', prompt: 'why is my fan running', cwd: '/tmp/notes' },
      'c1',
      {},
    )
    expect(started).toEqual([
      {
        task: `${CHATS}/1`,
        cwd: '/tmp/notes',
        worktree: '',
        prompt: 'why is my fan running',
        extras: {},
        harness: 'codex',
      },
    ])
  })

  it('lists the chats that are open, and never a terminal or an agent on a task', async () => {
    const by = await tools()
    open = [
      lane({ id: `${CHATS}/2/agent`, harness: 'claude-code', startedAt: 2 }),
      lane({ id: 'app/refunds/agent', task: 'app/refunds', startedAt: 1 }),
      lane({ id: 'app/terminals/1', task: 'app/terminals', kind: 'terminal', startedAt: 3 }),
    ]
    const listed = (await by('tade_chat_list').run({}, 'c1', {})) as Record<string, unknown>[]

    expect(listed).toMatchObject([
      { id: `${CHATS}/2/agent`, task: `${CHATS}/2`, name: 'claude-code 2', project: '' },
    ])
  })

  it('steers and stops one by that id, through the tools that steer and stop agents', async () => {
    const by = await tools()
    const opened = (await by('tade_chat_open').run({}, 'c1', {})) as { task: string }

    await by('tade_steer').run({ task: opened.task, message: 'check the launchd jobs' }, 'c2', {})
    await by('tade_run_stop').run({ task: opened.task }, 'c3', {})
    expect(steered).toEqual([`${CHATS}/1: check the launchd jobs`])
    expect(stopped).toEqual([`${CHATS}/1`])
  })
})

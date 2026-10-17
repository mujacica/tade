import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHATS, type TadeEvent } from '@tade/core'
import { type HarnessSession, resumeOffer } from '@tade/harnesses-core'
import { BACKGROUND_ENDED, type LaneRecord, type Workbench } from '@tade/workbench'
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
  /** What the journal says of chats, and what each harness says it kept. */
  let heard: TadeEvent[] = []
  let kept: HarnessSession[] = []
  const resumes: Record<string, boolean> = { pi: true, 'claude-code': true, acp: false }

  const tade = {
    lanes: () => open,
    events: async () => heard,
    resumeOf: (harness: string) =>
      resumeOffer({
        resume: resumes[harness] ?? false,
        why: { resume: 'comes back to a conversation only where the agent offers session/load' },
      }),
    sessionsIn: async (req: { tasks: readonly string[] }) =>
      kept.filter((one) => one.task === null || req.tasks.includes(one.task)),
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
    heard = []
    kept = []
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
    const listed = (await by('tade_chat_list').run({}, 'c1', {})) as Record<string, unknown>

    expect(listed).toMatchObject({
      open: [{ id: `${CHATS}/2/agent`, task: `${CHATS}/2`, name: 'claude-code 2', project: '' }],
      closed: [],
    })
  })

  /** A chat the journal heard open in `harness` at 19:02 and close at 20:08. */
  function closedChat(number: number, harness: string): TadeEvent[] {
    const task = `${CHATS}/${number}`
    const event = (ts: string, type: string, fields: Partial<TadeEvent>) =>
      ({
        seq: 0,
        ts,
        type,
        urgency: 'notable',
        task,
        lane: null,
        run: null,
        detail: {},
        ...fields,
      }) as TadeEvent
    return [
      event('2026-10-16T19:02:02.279Z', 'run_started', {
        run: `${task}/agent`,
        detail: { cwd: '/Users/me', adapter: harness, account: null },
      }),
      event('2026-10-16T19:02:02.315Z', 'lane_opened', {
        lane: `${task}/agent`,
        detail: { cwd: '/Users/me' },
      }),
      event('2026-10-16T20:08:25.928Z', 'lane_closed', { lane: `${task}/agent` }),
    ]
  }

  it('lists a closed chat whose conversation is kept, and brings it back on it', async () => {
    const by = await tools()
    heard = closedChat(5, 'claude-code')
    kept = [
      {
        id: 'ef256a55',
        at: 1,
        first: 'I spent my childhood playing SA:MP',
        task: `${CHATS}/5` as never,
      },
    ]

    const listed = (await by('tade_chat_list').run({}, 'c1', {})) as Record<string, unknown>
    expect(listed).toEqual({
      open: [],
      closed: [
        {
          id: `${CHATS}/5`,
          name: 'claude-code 5',
          harness: 'claude-code',
          cwd: '/Users/me',
          closed: '2026-10-16T20:08:25.928Z',
          first: 'I spent my childhood playing SA:MP',
        },
      ],
    })

    const back = (await by('tade_chat_reopen').run({ chat: `${CHATS}/5` }, 'c2', {})) as Record<
      string,
      unknown
    >
    // The same chat in the same harness and folder, told nothing, its tab
    // back where it was first opened.
    expect(started).toEqual([
      {
        task: `${CHATS}/5`,
        cwd: '/Users/me',
        worktree: '',
        prompt: '',
        extras: {},
        harness: 'claude-code',
        openedAt: Date.parse('2026-10-16T19:02:02.315Z'),
      },
    ])
    expect(back).toMatchObject({ id: `${CHATS}/5/agent`, said: BACKGROUND_ENDED })
  })

  it('says why a chat cannot come back rather than starting it over', async () => {
    const by = await tools()
    heard = [...closedChat(6, 'acp'), ...closedChat(7, 'pi')]

    await expect(by('tade_chat_reopen').run({ chat: `${CHATS}/6` }, 'c1', {})).rejects.toThrow(
      'chats/6 ran in acp, which comes back to a conversation only where the agent offers session/load',
    )
    // pi keeps nothing of chats/7: nothing was ever said in it.
    await expect(by('tade_chat_reopen').run({ chat: `${CHATS}/7` }, 'c2', {})).rejects.toThrow(
      /pi no longer keeps chats\/7's conversation/,
    )
    expect(started).toEqual([])
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

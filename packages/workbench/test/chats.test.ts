import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHATS } from '@tade/core'
import { sessionIdFor } from '@tade/harnesses-pi'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { chatCwd, chatsFrom, lostChats, openChat, reopenChat } from '../src/chats.ts'
import { terminalsFrom } from '../src/terminals.ts'
import { Workbench } from '../src/workbench.ts'

// Chats against a real workbench: a real lane with a real harness in it, no
// model, so one starts and waits. What is tested is the three things a chat
// does that a task's agent does not — where it stands, how it is numbered, and
// what closing one leaves behind — and that none of it disturbs an agent on a
// task beside it.

const INTENT = 'the refund flow double-charges when the webhook retries'

describe('chats', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench
  /**
   * Where the chats these tests open actually stand.
   *
   * Not `homedir()`, which is where a chat opened by a person stands and what
   * `chatCwd` is asserted on below: a suite may not start a real agent in the
   * developer's own home, and one that did would leave its harness's files
   * there. The default is a pure decision and is tested as one.
   */
  let somewhere: string

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-chats-')
    somewhere = tmp('tade-chats-cwd-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({
      home,
      version: '9.9.9',
      sessionsRoot: tmp('tade-chats-sessions-'),
    })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('stands in your home folder when nobody said where', () => {
    // Not a project's checkout, where a stray edit is indistinguishable from
    // somebody's work, and not Tade's own home, which holds every key.
    expect(chatCwd({})).toBe(homedir())
    expect(chatCwd({ cwd: '  ' })).toBe(homedir())
    expect(chatCwd({ cwd: '/tmp/somewhere' })).toBe('/tmp/somewhere')
  })

  it('opens one as a lane with no project', async () => {
    const chat = await openChat(client, { cwd: somewhere })

    expect(chat).toMatchObject({
      id: `${CHATS}/1/agent`,
      task: `${CHATS}/1`,
      // The whole of what makes it reachable from wherever you are standing.
      project: '',
      cwd: somewhere,
      harness: 'pi',
      name: 'pi 1',
    })
    // No worktree was made and nothing was written into a repository: Tade
    // fabricates neither for something that is not work.
    expect(client.lane(chat.id as never)?.spec.cwd).toBe(somewhere)
    // An agent like any other, so its turns are supervised and its spend is
    // journalled under a task that can be added up.
    expect((await client.runs()).map((run) => run.task)).toEqual([`${CHATS}/1`])
    const [started] = await client.events({ types: ['run_started'] })
    expect(started?.task).toBe(`${CHATS}/1`)
  }, 60_000)

  it('starts in a folder when one is asked for, and never guesses a project’s', async () => {
    const chat = await openChat(client, { cwd: repo.root })
    expect(chat.cwd).toBe(repo.root)
    // Still no project: a folder to look at is not a repository to work in.
    expect(chat.project).toBe('')
    expect(chatsFrom(client.lanes())[0]?.project).toBe('')
  }, 60_000)

  it('never gives a closed chat’s number to a new one', async () => {
    const first = await openChat(client, { cwd: somewhere })
    await client.stopAgent(first.task)
    const second = await openChat(client, { cwd: somewhere })

    // A harness names its session after the task, so a reused number would
    // not open a new conversation: it would carry the old one on.
    expect(second.task).toBe(`${CHATS}/2`)
    expect(sessionIdFor(second.task)).not.toBe(sessionIdFor(first.task))
  }, 90_000)

  it('leaves the conversation where it was when one is closed', async () => {
    const chat = await openChat(client, { cwd: somewhere })
    const session = sessionIdFor(chat.task)
    await client.stopAgent(chat.task)

    // The lane is gone and the chat is off the tabs...
    expect(client.lane(chat.id as never)?.alive).toBe(false)
    expect(chatsFrom(client.lanes())).toEqual([])
    // ...and nothing of what was said went with it. Tade never held the
    // conversation: it is its harness's, under a session named after the task,
    // which is still the same name.
    expect(sessionIdFor(chat.task)).toBe(session)
  }, 60_000)

  it('is told it is a chat, and given none of the tools a task’s agent has', async () => {
    const chat = await openChat(client, { cwd: somewhere })
    const spec = client.lane(chat.id as never)?.spec
    const line = (spec?.args ?? []).join(' ')
    expect(line).toContain('You have no task and no project')
    // Every tool Tade's extensions hand an agent is about a task's files.
    expect(line).not.toContain('tade_done')
    expect(line).not.toContain('Tade-Task:')
  }, 60_000)

  it('sits beside an agent on a task without either one knowing', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      workspace: 'worktree',
    })
    await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })
    const chat = await openChat(client, { cwd: somewhere })
    const terminal = await client.openTerminal({ project: 'app' })

    // Three lanes, and each list keeps to its own kind: a chat is not a
    // terminal and a terminal is not a chat, whatever tab they share.
    expect(chatsFrom(client.lanes()).map((one) => one.id)).toEqual([chat.id])
    expect(terminalsFrom(client.lanes()).map((one) => one.id)).toEqual([terminal.id])
    expect((await client.runs()).map((run) => run.task).sort()).toEqual([
      'app/refunds',
      `${CHATS}/1`,
    ])
    // And the task's own agent still answers to the task: closing the chat
    // takes nothing of its.
    await client.stopAgent(chat.task)
    expect((await client.runs()).map((run) => run.task)).toEqual(['app/refunds'])
  }, 120_000)

  it('comes back where it stood after the window closed on it', async () => {
    const chat = await openChat(client, { cwd: repo.root })
    await client.close()
    // Reopened over the same home: the lane was alive when the file was last
    // written and is gone now, which is what `lost` means.
    client = await Workbench.open({
      home,
      version: '9.9.9',
      sessionsRoot: tmp('tade-chats-sessions-'),
    })
    const lost = lostChats(client.lanes())
    expect(lost.map((lane) => lane.id)).toEqual([chat.id])

    await reopenChat(client, lost[0] as never)
    // The same chat, in the same folder — read off its own stored spec, since
    // a chat has no worktree anything could look up.
    expect(chatsFrom(client.lanes())).toMatchObject([
      { id: chat.id, task: chat.task, cwd: repo.root },
    ])
  }, 120_000)
})

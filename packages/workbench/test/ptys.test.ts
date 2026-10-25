import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaneId, TaskId } from '@tade/core'
import { mastersHeld } from '@tade/drivers-pty'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { openChat } from '../src/chats.ts'
import { Workbench } from '../src/workbench.ts'

// What each way of ending a lane gives back of the machine's pseudo-terminals,
// counted in this process, which is the window's: the workbench is what the
// window holds, on the pty driver, with real agents in real lanes.
//
// A window that kept one for every lane it ever started held 334 of macOS's
// 511 after a week, and every agent's test run on the machine then failed with
// `posix_spawnp failed.` (`drivers/pty/src/spare.ts`). So each way a lane ends
// is held to giving its master back as soon as the act returns, not once
// something gets round to it.

describe('the pseudo-terminals the window holds', () => {
  let repo: ReturnType<typeof mkrepo>
  let client: Workbench
  let somewhere: string

  beforeEach(async () => {
    repo = mkrepo()
    const home = tmp('tade-ptys-')
    somewhere = tmp('tade-ptys-cwd-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home, sessionsRoot: tmp('tade-ptys-sessions-') })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  async function agent(slug: string): Promise<{ task: TaskId; lane: LaneId }> {
    const task = await client.createTask({ project: 'app', slug, intent: `look at ${slug}` })
    await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })
    return { task: task.id, lane: `${task.id}/agent` as LaneId }
  }

  async function until(check: () => boolean, what: string, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('gives a terminal’s back when it is closed', async () => {
    const before = mastersHeld()
    const terminal = await client.openTerminal({ project: 'app' })
    expect(mastersHeld()).toBe(before! + 1)
    await client.closeTerminal(terminal.id)
    expect(mastersHeld()).toBe(before)
  }, 60_000)

  it('gives an agent’s back when it is stopped', async () => {
    const before = mastersHeld()
    const { task } = await agent('stopped')
    expect(mastersHeld()).toBe(before! + 1)
    await client.stopAgent(task)
    expect(mastersHeld()).toBe(before)
  }, 60_000)

  it('gives an agent’s back when its lane is closed', async () => {
    const before = mastersHeld()
    const { lane } = await agent('closed')
    expect(mastersHeld()).toBe(before! + 1)
    await client.closeLane(lane)
    expect(mastersHeld()).toBe(before)
  }, 60_000)

  it('gives a chat’s back when it is closed', async () => {
    const before = mastersHeld()
    const chat = await openChat(client, { cwd: somewhere })
    expect(mastersHeld()).toBe(before! + 1)
    // Closing a chat's tab is stopping its agent (`app/src/wire/lanes.ts`).
    await client.stopAgent(chat.task)
    expect(mastersHeld()).toBe(before)
  }, 60_000)

  it('holds one for an agent opened again after it was stopped, and none once stopped again', async () => {
    const before = mastersHeld()
    const { task } = await agent('again')
    const worktree = client.lane(`${task}/agent` as LaneId)!.spec.cwd
    await client.stopAgent(task)
    await client.reopenAgent({ task, cwd: worktree })
    expect(mastersHeld()).toBe(before! + 1)
    await client.stopAgent(task)
    expect(mastersHeld()).toBe(before)
  }, 60_000)

  it('holds one for an agent opened again after it ended by itself, and none once stopped', async () => {
    const before = mastersHeld()
    const { task, lane } = await agent('ended')
    const record = client.lane(lane)!
    process.kill(record.pid!, 'SIGKILL')
    await until(() => client.lane(lane)?.alive === false, 'the agent to end')
    expect(mastersHeld()).toBe(before)
    await client.reopenAgent({ task, cwd: record.spec.cwd })
    expect(mastersHeld()).toBe(before! + 1)
    await client.stopAgent(task)
    expect(mastersHeld()).toBe(before)
  }, 60_000)
})

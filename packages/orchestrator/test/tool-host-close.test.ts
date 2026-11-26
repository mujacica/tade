import { join } from 'node:path'
import type { Task, Workspace } from '@tade/core'
import { removeTask, type Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, type Repo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { ToolHost } from '../src/tool-host.ts'
import { call } from './host-harness.ts'

// `worker/close`, the tidy tier's close (ONE-AWAY-VIEW Q3b): what another
// machine's outbox may ask here. Never forced, so it closes an agent that is
// not running and whose work is already kept, and refuses one whose work is
// not — in real worktrees, with git's own answer.

let host: ToolHost | null = null
afterEach(async () => {
  await host?.close()
  host = null
})

/** A task as a look would list it: its worktree, its branch, and whether its agent's lane is alive. */
function taskOf(id: string, worktree: string, alive: boolean): Task {
  return {
    id,
    project: 'app',
    branch: `tade/${id.split('/')[1]}`,
    worktree,
    lanes: [{ id: `${id}/agent`, kind: 'agent', alive, pid: null, lastOutputAt: null, attach: '' }],
  } as unknown as Task
}

async function listen(repo: Repo, tasks: Task[], removed: string[]) {
  const tade = {
    // The workbench's own removal, over the real repository and home.
    removeTask: async (req: Parameters<Workbench['removeTask']>[0]) => {
      const result = await removeTask({ ...req, home: repo.home })
      if (result.removed && req.task) removed.push(req.task)
      return result
    },
  } as unknown as Workbench
  const workspace = { projects: [{ name: 'app', root: repo.root, tasks }] } as unknown as Workspace
  const path = join(tmp('tade-close-'), 'tools.sock')
  host = await ToolHost.listen({ tade, path, status: async () => workspace })
  return path
}

describe('closing a finished or stopped agent', () => {
  it('closes one that is stopped and whose branch is merged, worktree and branch with it', async () => {
    const repo = mkrepo()
    const tree = repo.addTask('done', { project: 'app' })
    const removed: string[] = []
    const path = await listen(repo, [taskOf('app/done', tree, false)], removed)
    const answer = await call(path, 'worker/close', { task: 'app/done' })
    expect(answer.error).toBeUndefined()
    expect(answer.result).toEqual({ ok: true, said: 'closed app/done' })
    expect(removed).toEqual(['app/done'])
    expect(repo.git('branch', '--list', 'tade/done').trim()).toBe('')
  })

  it('keeps one whose work is not merged anywhere, and says why', async () => {
    const repo = mkrepo()
    const tree = repo.addTask('unmerged', { project: 'app' })
    repo.commit('half a fix', { 'fix.ts': 'export {}\n' }, tree)
    const removed: string[] = []
    const path = await listen(repo, [taskOf('app/unmerged', tree, false)], removed)
    const answer = await call(path, 'worker/close', { task: 'app/unmerged' })
    expect(answer.error?.message).toBe(
      'app/unmerged is kept: tade/unmerged has commits not merged into main. Close it at its machine',
    )
    expect(removed).toEqual([])
    expect(repo.git('branch', '--list', 'tade/unmerged')).toContain('tade/unmerged')
  })

  it('keeps one with uncommitted work', async () => {
    const repo = mkrepo()
    const tree = repo.addTask('dirty', { project: 'app' })
    repo.write({ 'wip.ts': 'export {}\n' }, tree)
    const removed: string[] = []
    const path = await listen(repo, [taskOf('app/dirty', tree, false)], removed)
    const answer = await call(path, 'worker/close', { task: 'app/dirty' })
    expect(answer.error?.message).toContain('uncommitted file(s)')
    expect(removed).toEqual([])
  })

  it('refuses one whose agent is running, and a task it does not have', async () => {
    const repo = mkrepo()
    const tree = repo.addTask('live', { project: 'app' })
    const removed: string[] = []
    const path = await listen(repo, [taskOf('app/live', tree, true)], removed)
    expect((await call(path, 'worker/close', { task: 'app/live' })).error?.message).toBe(
      "app/live's agent is running: stop it first, then close it",
    )
    expect((await call(path, 'worker/close', { task: 'app/gone' })).error?.message).toBe(
      'there is no task called app/gone',
    )
    expect(removed).toEqual([])
  })
})

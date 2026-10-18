import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { takeTitle, workTitle } from '../src/task-said.ts'
import { setTitle, taskFilePath } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

// An agent is titled by its work: the name on its tab, in the window and in its
// own session. The orchestrator opens agents with "Read your context file
// first, then …", so a title taken from the opening instruction made every
// agent the same one.

const OPENING = 'Read your context file first, then read how the window draws titles.'

describe('an agent is titled by its work', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-titles-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  const titleOf = (task: string) =>
    (parse(readFileSync(taskFilePath(home, task), 'utf8')) as { title?: string }).title

  it('not by the instruction it is opened with, which still reaches it', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'agents-are-titled-by-their-work',
      intent: 'Since recently all of the agents we schedule are titled the same',
    })
    // What an earlier start took from its opening instruction.
    await setTitle(home, task.id, 'Read your context file first', false)
    const lane = await client.startAgent({ task: task.id, cwd: task.worktree, prompt: OPENING })
    expect(titleOf(task.id)).toBe('Agents are titled by their work')
    // Its session is called that too, not after the first thing it is told.
    expect(lane.spec.env?.TADE_CALLED).toBe('Agents are titled by their work')
    expect(lane.spec.env?.TADE_TITLE).toBeUndefined()
    // And its harness, taking a title from that first thing, changes nothing.
    await takeTitle(home, task.id, 'Read your context file first, then', false)
    expect(titleOf(task.id)).toBe('Agents are titled by their work')
  }, 60_000)

  it('keeps a name a person gave it, there and in its session', async () => {
    const task = await client.createTask({ project: 'app', slug: 'refunds', intent: 'fix them' })
    await client.startAgent({ task: task.id, cwd: task.worktree, prompt: OPENING })
    await client.renameAgent({ task: task.id, worktree: task.worktree, title: 'Window titles' })
    await client.stopAgent(task.id)
    const lane = await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })
    expect(titleOf(task.id)).toBe('Window titles')
    expect(lane.spec.env?.TADE_TITLE).toBe('Window titles')
    expect(lane.spec.env?.TADE_CALLED).toBeUndefined()
    await takeTitle(home, task.id, 'Read your context file first', false)
    expect(titleOf(task.id)).toBe('Window titles')
  }, 60_000)

  it('is the task’s name in words, and nothing for an agent started without any', () => {
    expect(workTitle('tade/agents-are-titled-by-their-work')).toBe(
      'Agents are titled by their work',
    )
    expect(workTitle('tade/switching-the-orchestrator-s-account-crashes-it')).toBe(
      "Switching the orchestrator's account crashes it",
    )
    expect(workTitle('tade/agent')).toBeNull()
    expect(workTitle('tade/agent-3')).toBeNull()
  })

  it('leaves an agent started without words to be named by what it is first asked', async () => {
    const task = await client.createTask({ project: 'app', slug: 'agent-1', intent: '' })
    await takeTitle(home, task.id, 'Fix the double charge', false)
    expect(titleOf(task.id)).toBe('Fix the double charge')
  }, 60_000)
})

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type PlannedAgent, taskDir } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { makePlan } from '../src/plans.ts'
import { Workbench } from '../src/workbench.ts'

// Making a plan is all or nothing about names, against real git and a real
// journal. On 2026-10-11 a plan made its first task, then threw on its second
// agent's name — used before, and only asked as each task was made — and the
// task it left behind was the name the next attempt was refused over.

const agent = (name: string, over: Partial<PlannedAgent> = {}): PlannedAgent => ({
  name,
  said: `do ${name}`,
  prompt: `please do ${name}`,
  after: [],
  touches: [],
  ...over,
})

describe('making a plan', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-plans-')
    writeFileSync(
      join(home, 'config.yaml'),
      `agents:\n  workspace: checkout\nprojects:\n  app:\n    root: ${repo.root}\n`,
    )
    // Its own sessions, so nothing of a real ~/.pi is read or written.
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  /** A task made and taken away again: its name is used for good. */
  const usedUp = async (name: string) => {
    const [task] = (await client.planTasks({ project: 'app', said: '', agents: [agent(name)] }))
      .made
    if (!task) throw new Error(`${name} was not made`)
    const removed = await client.removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
      task: task.id,
    })
    expect(removed.removed).toBe(true)
  }

  const efforts = async () => (await client.events({ types: ['effort_named'] })).length

  it('makes nothing, and names no effort, when a later agent’s name was used before', async () => {
    await usedUp('key-echo-not-paced')
    await expect(
      client.planTasks({
        project: 'app',
        said: 'the bottom bar, then the key echo',
        effort: 'bar-and-echo',
        agents: [
          agent('bottom-bar-jev-and-remote'),
          agent('key-echo-not-paced', {
            after: [{ agent: 'bottom-bar-jev-and-remote', why: 'same file' }],
          }),
        ],
      }),
    ).rejects.toThrow(
      /^the plan was not made: app\/key-echo-not-paced was used before, and a task's name is never used twice: name it again \(free: key-echo-not-paced-2\)$/,
    )
    // The first agent, which once was made before the second was refused.
    expect(existsSync(taskDir(home, 'app/bottom-bar-jev-and-remote'))).toBe(false)
    expect(
      await client.events({ types: ['task_created'], task: 'app/bottom-bar-jev-and-remote' }),
    ).toEqual([])
    expect(await efforts()).toBe(0)
  })

  it('names every clash in one refusal, each with a free name, and the plan’s own problems too', async () => {
    await usedUp('gone')
    await usedUp('gone-2')
    await client.planTasks({ project: 'app', said: '', agents: [agent('here')] })
    await usedUp('a-b')
    const refused = client.planTasks({
      project: 'app',
      said: '',
      agents: [
        agent('fine'),
        agent('gone'),
        agent('here'),
        // pi keeps both `app/a.b` and `app/a-b` as one conversation.
        agent('a.b'),
        agent('lost', { after: [{ agent: 'ghost', why: 'it said so' }] }),
      ],
    })
    await expect(refused).rejects.toThrow(
      'the plan was not made: lost waits on ghost, which is neither in the plan nor a task Tade has; ' +
        "app/gone was used before, app/here is a task already and app/a.b would carry on app/a-b's conversation, and a task's name is never used twice: " +
        // `gone-2` was used too, so the free name skips it.
        'name them again (free: gone-3, here-2, a.b-2), or have the work wait on what is a task already, in after, rather than planning it again',
    )
    expect(existsSync(taskDir(home, 'app/fine'))).toBe(false)
  })

  it('refuses two agents of one plan that would be one conversation', async () => {
    await expect(
      client.planTasks({ project: 'app', said: '', agents: [agent('x.y'), agent('x-y')] }),
    ).rejects.toThrow(/app\/x-y would carry on app\/x\.y's conversation.*\(free: x-y-2\)/)
    expect(existsSync(taskDir(home, 'app/x.y'))).toBe(false)
  })

  it('writes an effort’s sentence down only when it is new', async () => {
    const plan = (said: string, name: string) =>
      client.planTasks({ project: 'app', said, effort: 'spinner', agents: [agent(name)] })
    await plan('a steady spinner', 'spinner-own-clock')
    expect(await efforts()).toBe(1)
    await plan('a steady spinner', 'spinner-steady-clock')
    expect(await efforts()).toBe(1)
    await expect(plan('a steady spinner, again', 'spinner-own-clock')).rejects.toThrow(
      /is a task already/,
    )
    expect(await efforts()).toBe(1)
    await plan('an even spinner', 'spinner-even-cadence')
    const said = (await client.events({ types: ['effort_named'] })).map(
      (event) => event.detail.intent_spoken,
    )
    expect(said).toEqual(['a steady spinner', 'an even spinner'])
  })

  describe('when making stops after every check has passed', () => {
    /** The workbench's own deps, with making the `fail`th task failing as a disk would. */
    const failing = (fail: number) => {
      let n = 0
      return {
        config: client.config,
        events: client.events.bind(client),
        note: async () => {},
        createTask: (req: Parameters<Workbench['createTask']>[0]) =>
          n++ === fail
            ? Promise.reject(new Error('ENOSPC: no space left'))
            : client.createTask(req),
        resolveModel: client.resolveModel.bind(client),
        keyOf: [],
      }
    }
    const chain = {
      project: 'app',
      said: '',
      agents: [
        agent('first'),
        agent('second', { after: [{ agent: 'first', why: 'builds on it' }] }),
        agent('third', { after: [{ agent: 'second', why: 'builds on it' }] }),
      ],
    }

    it('names what it made, which stays queued, and what is left to plan again', async () => {
      await expect(makePlan(failing(1), chain)).rejects.toThrow(
        'the plan was made only in part: app/first is queued, then app/second could not be made: ENOSPC: no space left. ' +
          'app/second and app/third were not made: plan only those again, waiting on what was made where they need to',
      )
      expect(existsSync(taskDir(home, 'app/first'))).toBe(true)
      expect(existsSync(taskDir(home, 'app/second'))).toBe(false)
    })

    it('says plainly that nothing was made when the first could not be', async () => {
      await expect(makePlan(failing(0), chain)).rejects.toThrow(
        /^the plan was not made: app\/first could not be made: ENOSPC: no space left$/,
      )
      expect(existsSync(taskDir(home, 'app/first'))).toBe(false)
    })
  })
})

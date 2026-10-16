import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type PlannedAgent, taskDir } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { handOnWaits } from '../src/queue-changes.ts'
import { readTaskFile } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

// Changing queued work once it is made, against real git and real task files:
// what it waits on and what it is told are written into its task file — the
// one place queued work keeps them — and the journal says who and what.

const agent = (name: string, over: Partial<PlannedAgent> = {}): PlannedAgent => ({
  name,
  said: `do ${name}`,
  prompt: `please do ${name}`,
  after: [],
  touches: [],
  ...over,
})

describe('changing queued work', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-requeue-')
    writeFileSync(
      join(home, 'config.yaml'),
      `agents:\n  workspace: checkout\nprojects:\n  app:\n    root: ${repo.root}\n`,
    )
    // Its own sessions, so nothing of a real ~/.pi is read or written.
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    await client.planTasks({
      project: 'app',
      said: 'three changes',
      agents: [
        agent('one', { touches: ['src/one.ts'] }),
        agent('two', { after: [{ agent: 'one', why: 'builds on it' }] }),
        agent('three', { touches: ['README.md'] }),
      ],
    })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  const raw = (task: string) =>
    parseYaml(readFileSync(join(taskDir(home, task), 'task.yaml'), 'utf8')) as Record<
      string,
      unknown
    >

  it('adds a wait to what it waits on, every other field as it was, and says who', async () => {
    const before = raw('app/three')
    const start = await client.changeQueued({
      task: 'app/three',
      change: 'after',
      after: [{ task: 'two', why: 'same README section' }],
      by: 'orchestrator',
    })
    expect(start?.after).toEqual([{ task: 'app/two', why: 'same README section' }])
    const after = raw('app/three')
    expect(after.intent_spoken).toBe(before.intent_spoken)
    expect(after.created).toBe(before.created)
    expect((after.start as Record<string, unknown>).prompt).toBe('please do three')
    expect((after.start as Record<string, unknown>).touches).toEqual(['README.md'])
    const [line] = await client.events({ types: ['queue_changed'], task: 'app/three' })
    expect(line?.detail).toEqual({
      change: 'after',
      by: 'orchestrator',
      after: [{ task: 'app/two', why: 'same README section' }],
    })

    // Added to, not replaced; and replaced when told, with what it was.
    await client.changeQueued({
      task: 'app/three',
      change: 'after',
      after: [{ task: 'app/one', why: 'first' }],
      by: 'you',
    })
    expect((await readTaskFile(home, 'app/three'))?.start?.after.map((dep) => dep.task)).toEqual([
      'app/two',
      'app/one',
    ])
    await client.changeQueued({
      task: 'app/three',
      change: 'after',
      after: [],
      replace: true,
      by: 'you',
    })
    expect((await readTaskFile(home, 'app/three'))?.start?.after).toEqual([])
    const lines = await client.events({ types: ['queue_changed'], task: 'app/three' })
    expect(lines.at(-1)?.detail).toEqual({
      change: 'after',
      by: 'you',
      after: [],
      replace: true,
      was: ['app/two', 'app/one'],
    })
  })

  it('keeps a wait for the person’s approval in the task file, and refuses one nobody could give', async () => {
    // Plan, you approve, build — made as one plan, then one more wait written on.
    await client.planTasks({
      project: 'app',
      said: 'plan the refunds work, and build it once I have approved the plan',
      agents: [
        agent('plan', { produces: 'plan.md' }),
        agent('build', { after: [{ agent: 'plan', why: 'builds the plan', approved: true }] }),
      ],
    })
    expect((await readTaskFile(home, 'app/build'))?.start?.after).toEqual([
      { task: 'app/plan', why: 'builds the plan', approved: true },
    ])
    // Work made to wait for an approval is not anybody having acted on it.
    const [made] = await client.events({ types: ['task_created'], task: 'app/build' })
    expect(made?.detail).toMatchObject({ after: ['app/plan'], approval: ['app/plan'] })

    const start = await client.changeQueued({
      task: 'app/three',
      change: 'after',
      after: [{ task: 'plan', why: 'reads it', approved: true }],
      by: 'orchestrator',
    })
    expect(start?.after).toEqual([{ task: 'app/plan', why: 'reads it', approved: true }])
    await expect(
      client.changeQueued({
        task: 'app/three',
        change: 'after',
        after: [{ task: 'one', why: 'after it', approved: true }],
        by: 'orchestrator',
      }),
    ).rejects.toThrow(
      "app/three cannot wait for app/one's document to be approved: app/one produces none, so wait for it to finish instead",
    )
  })

  it('refuses a wait on a task it does not have, on a removed one, or round a loop', async () => {
    await expect(
      client.changeQueued({
        task: 'app/three',
        change: 'after',
        after: [{ task: 'ghost', why: '' }],
        by: 'orchestrator',
      }),
    ).rejects.toThrow(
      'app/three cannot wait on ghost, which is not a task Tade has: wait only on one tade_queue or tade_status lists',
    )
    // `two` already waits on `one`: `one` waiting on `two` would hold both for ever.
    await expect(
      client.changeQueued({
        task: 'app/one',
        change: 'after',
        after: [{ task: 'two', why: '' }],
        by: 'orchestrator',
      }),
    ).rejects.toThrow(
      'app/one cannot wait on app/two: app/two already waits on app/one, so neither could start',
    )
    // A task removed is not one to wait on, though its name was used.
    await client.removeTask({
      root: repo.root,
      worktree: repo.root,
      branch: '',
      task: 'app/three',
      force: true,
    })
    await expect(
      client.changeQueued({
        task: 'app/two',
        change: 'after',
        after: [{ task: 'three', why: '' }],
        by: 'orchestrator',
      }),
    ).rejects.toThrow(/cannot wait on three, which is not a task Tade has/)
    // Nothing refused was written.
    expect((await readTaskFile(home, 'app/one'))?.start?.after).toEqual([])
    expect(await client.events({ types: ['queue_changed'] })).toEqual([])
  })

  it("hands a removed task's waits on to what waited on it, and nothing waits on it while it goes", async () => {
    await client.planTasks({ project: 'app', said: 'one more', agents: [agent('four')] })
    await client.changeQueued({
      task: 'app/three',
      change: 'after',
      after: [{ task: 'two', why: 'same README section' }],
      by: 'you',
    })
    const removing = (task: string) => async () => {
      const result = await client.removeTask({
        root: repo.root,
        worktree: repo.root,
        branch: '',
        task,
        force: true,
      })
      if (!result.removed) throw new Error(result.reason)
    }

    // A removal that fails writes nothing.
    await expect(
      handOnWaits(client, { task: 'app/two', by: 'orchestrator' }, async () => {
        throw new Error('the disk said no')
      }),
    ).rejects.toThrow('the disk said no')
    expect((await readTaskFile(home, 'app/three'))?.start?.after).toEqual([
      { task: 'app/two', why: 'same README section' },
    ])

    // A wait on it asked for while it goes is checked once it has gone: let
    // in beside the removal, it would name work nobody hands anything on from.
    const [handed, late] = await Promise.allSettled([
      handOnWaits(client, { task: 'app/two', by: 'orchestrator' }, removing('app/two')),
      client.changeQueued({
        task: 'app/four',
        change: 'after',
        after: [{ task: 'two', why: '' }],
        by: 'you',
      }),
    ])
    const after = [
      { task: 'app/one', why: 'same README section; in place of app/two, which was removed' },
    ]
    expect(handed).toEqual({ status: 'fulfilled', value: [{ task: 'app/three', after }] })
    expect(late.status).toBe('rejected')
    expect(String((late as PromiseRejectedResult).reason)).toMatch(
      /cannot wait on two, which is not a task Tade has/,
    )

    // Written into its task file, every other field as it was, and said with
    // what it waited on before and whose waits these were.
    expect((await readTaskFile(home, 'app/three'))?.start).toMatchObject({
      after,
      prompt: 'please do three',
      touches: ['README.md'],
    })
    const lines = await client.events({ types: ['queue_changed'], task: 'app/three' })
    expect(lines.at(-1)?.detail).toEqual({
      change: 'after',
      by: 'orchestrator',
      after,
      replace: true,
      was: ['app/two'],
      inherited: 'app/two',
    })
    // What did not wait on it is left alone.
    expect((await readTaskFile(home, 'app/one'))?.start?.after).toEqual([])
    expect((await readTaskFile(home, 'app/four'))?.start?.after).toEqual([])
  })

  // As root nothing is refused for its mode, so there is nothing to see.
  it.skipIf(process.getuid?.() === 0)(
    'names what could not take over the waits, and leaves it waiting on the task that went',
    async () => {
      await client.changeQueued({
        task: 'app/three',
        change: 'after',
        after: [{ task: 'two', why: '' }],
        by: 'you',
      })
      const file = join(taskDir(home, 'app/three'), 'task.yaml')
      chmodSync(file, 0o444)
      try {
        const handed = await handOnWaits(
          client,
          { task: 'app/two', by: 'orchestrator' },
          async () => {
            const gone = await client.removeTask({
              root: repo.root,
              worktree: repo.root,
              branch: '',
              task: 'app/two',
              force: true,
            })
            if (!gone.removed) throw new Error(gone.reason)
          },
        )
        expect(handed).toEqual([{ task: 'app/three', problem: expect.stringMatching(/EACCES/) }])
      } finally {
        chmodSync(file, 0o644)
      }
      // Nothing is said that did not happen: the queue holds it on the removal.
      expect((await readTaskFile(home, 'app/three'))?.start?.after).toEqual([
        { task: 'app/two', why: '' },
      ])
      const lines = await client.events({ types: ['queue_changed'], task: 'app/three' })
      expect(lines.map((line) => line.detail.inherited)).toEqual([undefined])
    },
  )

  it('lets only one of two waits written at once close a loop', async () => {
    const both = await Promise.allSettled([
      client.changeQueued({
        task: 'app/one',
        change: 'after',
        after: [{ task: 'three', why: '' }],
        by: 'orchestrator',
      }),
      client.changeQueued({
        task: 'app/three',
        change: 'after',
        after: [{ task: 'one', why: '' }],
        by: 'orchestrator',
      }),
    ])
    expect(both.map((one) => one.status)).toEqual(['fulfilled', 'rejected'])
  })

  it('keeps a park written at the same moment as a wait', async () => {
    await Promise.all([
      client.parkTask('app/three', true),
      client.changeQueued({
        task: 'app/three',
        change: 'after',
        after: [{ task: 'one', why: '' }],
        by: 'you',
      }),
    ])
    const file = await readTaskFile(home, 'app/three')
    expect(file?.parked).toBe(true)
    expect(file?.start?.after.map((dep) => dep.task)).toEqual(['app/one'])
  })

  it('retells what it is told or what it says it will touch, and never copies the prompt into the journal', async () => {
    await client.changeQueued({
      task: 'app/three',
      change: 'retell',
      prompt: 'only the install section\nand nothing else',
      by: 'orchestrator',
    })
    let start = (await readTaskFile(home, 'app/three'))?.start
    expect(start?.prompt).toBe('only the install section\nand nothing else')
    expect(start?.touches).toEqual(['README.md'])
    await client.changeQueued({
      task: 'app/three',
      change: 'retell',
      touches: [' docs/install.md ', ''],
      by: 'orchestrator',
    })
    start = (await readTaskFile(home, 'app/three'))?.start
    expect(start?.prompt).toBe('only the install section\nand nothing else')
    expect(start?.touches).toEqual(['docs/install.md'])
    const lines = await client.events({ types: ['queue_changed'], task: 'app/three' })
    expect(lines.map((line) => line.detail)).toEqual([
      { change: 'retell', by: 'orchestrator', retold: ['prompt'] },
      { change: 'retell', by: 'orchestrator', retold: ['touches'], touches: ['docs/install.md'] },
    ])

    await expect(
      client.changeQueued({ task: 'app/three', change: 'retell', by: 'you' }),
    ).rejects.toThrow(/say which/)
    await expect(
      client.changeQueued({ task: 'app/three', change: 'retell', prompt: '  ', by: 'you' }),
    ).rejects.toThrow("a prompt is what app/three's agent is told when it starts: say what")
    await expect(client.changeQueued({ change: 'retell', prompt: 'x', by: 'you' })).rejects.toThrow(
      'retell is for one piece of queued work: say which as task',
    )
  })

  it('refuses to change work that has already started, or that was never queued', async () => {
    await client.log.append({ type: 'run_started', task: 'app/one', detail: {} })
    await expect(
      client.changeQueued({ task: 'app/one', change: 'retell', prompt: 'other', by: 'you' }),
    ).rejects.toThrow('app/one has started, so it is not queued any more: tell its agent instead')
    await expect(
      client.changeQueued({
        task: 'app/one',
        change: 'after',
        after: [{ task: 'three', why: '' }],
        by: 'you',
      }),
    ).rejects.toThrow(/app\/one has started/)
    await expect(
      client.changeQueued({ task: 'app/nothing', change: 'retell', prompt: 'x', by: 'you' }),
    ).rejects.toThrow('there is no queued work called app/nothing')
  })
})

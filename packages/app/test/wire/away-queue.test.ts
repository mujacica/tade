import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ConfigSchema,
  type Queued,
  queueStateOf,
  readyToStart,
  type Task,
  taskDir,
  workspaceFor,
} from '@tade/core'
import { approveIntake, inboxFrom } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { closeAll, type Machine, machine, parkedIn } from './away-harness.ts'
import { delivered } from './away-intake.ts'

// **What happens to approved work once somebody approved it.**
//
// Approving lifts the park (`approveIntake`, the door the window's Intake
// panel presses), and it leaves the half an owner actually cares about —
// *does the queue then start it, in the right project, where that project
// says agents work?* The two are joined by nothing but a task file, so the
// join is exactly where a slice test on either side sees nothing.
//
// It is asked of the **rule** and not of a spawn. `readyToStart` and
// `queueStateOf` are what the window asks before it starts anything, so a task
// those two call ready is a task the queue starts; running a real agent would
// need a real harness and would be testing pi. What is real here is everything
// the rule reads: a real delivery through the door a watch uses, a real task
// file the workbench wrote, the real journal, and the approval through the
// workbench's own door.

afterEach(closeAll)

/** A machine with an intake grant, and a real delivery parked in it. */
async function proposal(): Promise<{ one: Machine; task: string }> {
  const one = await machine({ intake: true })
  return { one, task: await delivered(one) }
}

/** Approved at the machine, through the door the window's Intake panel presses. */
async function approve(one: Machine, task: string): Promise<void> {
  const rows = await inboxFrom({ home: one.home, events: await one.client.log.read({}) })
  const row = rows.find((each) => each.tasks.includes(task))
  if (row === undefined) throw new Error(`nothing from outside made ${task}`)
  await approveIntake(one.client, { item: row.item, by: 'you', config: one.client.config })
}

/** What a task's own file says, which is what the queue's rule reads. */
function fileOf(
  home: string,
  task: string,
): {
  parked?: boolean
  project?: string
  workspace?: Task['workspace']
  start?: Task['start']
} {
  return parse(readFileSync(join(taskDir(home, task), 'task.yaml'), 'utf8'))
}

/**
 * The `Queued` the window builds, out of the task's **real** file.
 *
 * The same four fields `Live` fills in (`live.ts`), read the same way: the
 * park comes off the file rather than off a derived state, because that is the
 * told fact and the one approving moves.
 */
function queued(home: string, task: string): Queued {
  const file = fileOf(home, task)
  if (file.start === undefined) throw new Error(`${task} is not queued work`)
  return {
    task,
    project: task.split('/')[0] ?? task,
    parked: file.parked === true,
    start: file.start,
  }
}

/** Everything the queue's rules read, as of now. */
async function facts(one: Machine) {
  return {
    tasks: new Map(),
    finished: new Map(),
    events: await one.client.events({}),
    now: Date.now(),
  }
}

describe('what the queue does with a proposal once it is approved', () => {
  it('will not start it while it is still waiting for somebody', async () => {
    const { one, task } = await proposal()
    expect(parkedIn(one.home, task)).toBe(true)

    const item = queued(one.home, task)
    const state = queueStateOf(item, await facts(one))
    expect(state).toMatchObject({ kind: 'paused', parked: true })
    // The half that matters: the rule the window asks before it starts
    // anything names nothing.
    expect(readyToStart([item], await facts(one), new Map())).toEqual([])
  })

  it('starts it once it is approved, by the queue’s own rule and nothing else', async () => {
    const { one, task } = await proposal()

    await approve(one, task)
    expect(parkedIn(one.home, task)).toBe(false)

    const item = queued(one.home, task)
    expect(queueStateOf(item, await facts(one))).toEqual({ kind: 'ready' })
    expect(readyToStart([item], await facts(one), new Map())).toEqual([task])
  })

  it('starts it in the project the request named, and nowhere else', async () => {
    const { one, task } = await proposal()
    await approve(one, task)

    // The grant names one project (`projects: [app]`), and the task the
    // delivery made is in it. The queue's own `room` is per project, so a task
    // filed under the wrong one would be started against another project's
    // limit — which is the shape nothing else here would notice.
    const item = queued(one.home, task)
    expect(item.project).toBe('app')
    expect(task.startsWith('app/')).toBe(true)
    expect(fileOf(one.home, task).project).toBe('app')
  })

  it('works where that project says agents work, which is the machine’s default here', async () => {
    const { one, task } = await proposal()
    await approve(one, task)

    // **Read through the one reader there is.** Nothing asks the machine:
    // `workspaceFor(config, project)` is the whole of where an agent works,
    // and a task file written by intake must agree with it — a task whose file
    // said `worktree` under a project configured `checkout` would have the
    // queue start it somewhere the project did not ask for.
    const config = ConfigSchema.parse({ projects: { app: { root: one.home } } })
    expect(workspaceFor(config, 'app')).toBe('checkout')
    expect(fileOf(one.home, task).workspace ?? 'checkout').toBe('checkout')
  })

  it('leaves it unstartable again the moment the park goes back on', async () => {
    const { one, task } = await proposal()
    await approve(one, task)
    expect(readyToStart([queued(one.home, task)], await facts(one), new Map())).toEqual([task])

    // Through the workbench, which is what a person at the keyboard pressing
    // park does — so this is the rule reading the file rather than the test
    // asserting a word.
    await one.client.parkTask(task, true)
    expect(readyToStart([queued(one.home, task)], await facts(one), new Map())).toEqual([])
  })
})

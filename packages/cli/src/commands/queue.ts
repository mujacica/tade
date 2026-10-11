import { joined, type QueueChange } from '@tade/core'
import { readTaskFile, type Workbench } from '@tade/workbench'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { withWorkbench } from '../with-workbench.ts'

// Changing queued work from the command line: the choice the window's SMART
// QUEUE and the orchestrator's `tade_queue_change` make, written down through
// the one operation all three call (`changeQueued`), as yours.
//
// **It writes, so it needs the home**, like every command that writes. With a
// window open it is refused and says to ask there: the window is what starts
// queued work, and there is no server for a second process to reach it
// through. With none open the choice is written down, and the next window
// reads it on its first look at the tasks — the rule is the queue's, never
// this command's, so nothing starts here.
//
// Removing queued work is not here: it takes the worktree and the branch with
// it, which is `tade task remove`.

/** What `changeQueued` was asked, said back the way the window says it. */
const DONE: Record<Exclude<QueueChange, 'order'>, string> = {
  start: 'starts as soon as there is room, whatever it waits on',
  wait: 'waits again, past what held it',
  pause: 'is paused',
  resume: 'is back on',
}

const LATER = 'A window acts on it the next time it looks at the tasks.'

/** Where to go instead while a window holds the home: it is what starts queued work. */
const THERE = 'Change it there — in its queue, or by asking the orchestrator (tade_queue_change)'

/** Work that is queued: a task file that says how to start it, and no agent started yet. */
async function queued(tade: Workbench, task: string): Promise<void> {
  const file = await readTaskFile(tade.home, task)
  if (!file?.start) throw new Error(`there is no queued work called ${task}`)
  const started = await tade.events({ types: ['run_started'], task })
  if (started.length > 0) throw new Error(`${task} has started, so it is not queued any more`)
}

export function registerQueue(program: Command, io: Io, setExit: (code: number) => void): void {
  const queue = program
    .command('queue')
    .description(
      'Change work waiting to start — the same choices as the window’s queue, written down as yours',
    )
  const writing = (fn: (tade: Workbench) => Promise<void>) => withWorkbench(io, setExit, fn, THERE)

  const one = (change: 'start' | 'wait', description: string) =>
    queue
      .command(`${change} <task>`)
      .description(description)
      .action((task: string) =>
        writing(async (tade) => {
          await queued(tade, task)
          await tade.changeQueued({ task, change, by: 'you' })
          io.out(`${task} ${DONE[change]}. ${LATER}`)
        }),
      )
  one('start', 'Start queued work now, whatever it waits on')
  one('wait', 'Let held work wait again, past what held it')

  const either = (change: 'pause' | 'resume', description: string) =>
    queue
      .command(`${change} [task]`)
      .description(description)
      .option('--project <name>', 'every piece of one project’s queue at once')
      .action(async (task: string | undefined, opts: { project?: string }) => {
        if (Boolean(task) === Boolean(opts.project)) {
          io.err(
            `${change} is for one piece of queued work or, with --project, a whole project: name one`,
          )
          setExit(Exit.invalidInput)
          return
        }
        await writing(async (tade) => {
          const project = opts.project ?? ''
          if (task) await queued(tade, task)
          else if (!tade.config.projects[project]) {
            throw new Error(`there is no project called ${project}`)
          }
          await tade.changeQueued({ ...(task ? { task } : { project }), change, by: 'you' })
          io.out(`${task ?? `${project}'s queue`} ${DONE[change]}. ${LATER}`)
        })
      })
  either('pause', 'Pause queued work so it does not start, one piece or a whole project')
  either('resume', 'Let paused queued work start again by its rule')

  queue
    .command('order <tasks...>')
    .description(
      'Say what goes first among queued work that is ready: never jumps a wait, unholds or starts anything',
    )
    .action((tasks: string[]) =>
      writing(async (tade) => {
        for (const task of tasks) await queued(tade, task)
        await tade.changeQueued({ change: 'order', order: tasks, by: 'you' })
        io.out(`${joined(tasks)}, in that order, as each becomes ready. ${LATER}`)
      }),
    )
}

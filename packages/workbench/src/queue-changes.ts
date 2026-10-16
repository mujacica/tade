import { readFile } from 'node:fs/promises'
import {
  type Asker,
  checkWaits,
  inheritWaits,
  type QueueChange,
  type StartCondition,
  TaskFile,
  type Wait,
} from '@tade/core'
import { parse as parseYaml } from 'yaml'
import type { EventLog } from './events.ts'
import { pickUpToStart } from './parked.ts'
import { aloneOn, readTaskFile, rewriteTaskFile, taskFilePath } from './tasks.ts'

// A choice about queued work — a person's, or the orchestrator's on their
// behalf — written down, so that what the queue does next is read from it.
//
// Most of them are a line in the journal and nothing else, because the rule
// reads the journal. Two change the task file instead, because that is where
// queued work keeps what it waits on, what its agent is told and what it says
// it will touch (`start`), and there is never a second store of it: `after`
// and `retell`. Both write the file first and the line second, so nothing is
// written down that did not happen, and the line says who and what it was.
// So does handing a removed task's waits on to what waited on it
// (`handOnWaits`), which is a wait written for each of them.
//
// Here rather than on the workbench because the file it was in is at the size
// a file is allowed to be, and a wait written on queued work is a rule about
// the queue rather than about the workbench.

export interface QueueChangeRequest {
  task?: string
  project?: string
  change: QueueChange
  /** For `order`: the tasks, first to last. What is not named keeps its place behind. */
  order?: readonly string[]
  /**
   * For `after`: what it waits on, each with why — and `approved` where it
   * waits for the person to approve that one's document too. A bare name is in
   * the task's own project.
   */
  after?: readonly Wait[]
  /** For `after`: these replace what it waited on, rather than being added to it. */
  replace?: boolean
  /** For `retell`: what its agent is told when it starts, instead of what it was. */
  prompt?: string
  /** For `retell`: what it now says it will change. */
  touches?: readonly string[]
  by: Asker
}

/** What a queue change needs of the workbench. */
export interface QueueChanger {
  home: string
  log: Pick<EventLog, 'append' | 'read'>
}

/** What is done to one piece of queued work and never to a whole project's queue. */
const ONE_PIECE: ReadonlySet<QueueChange> = new Set(['start', 'wait', 'after', 'retell'])

/**
 * A person's choice about queued work — pause, resume, start it anyway, wait
 * past what held it, put what is ready in an order, wait on other work, or be
 * told something else — or about a project's whole queue, when no task is
 * named. What `after` and `retell` leave in the task file is what they answer
 * with; everything else answers with nothing.
 */
export async function changeQueued(
  tade: QueueChanger,
  req: QueueChangeRequest,
): Promise<StartCondition | null> {
  if (!req.task && ONE_PIECE.has(req.change)) {
    throw new Error(`${req.change} is for one piece of queued work: say which as task`)
  }
  if (req.task && req.change === 'after') return waitOn(tade, { ...req, task: req.task })
  if (req.task && req.change === 'retell') return retell(tade, { ...req, task: req.task })
  // Starting parked work picks it up first, as whoever asked, so one press is
  // the whole act (`pickUpToStart`); what refuses that refuses the start, and
  // nothing is written.
  if (req.change === 'start' && req.task) await pickUpToStart(tade, req.task, req.by)
  const order = (req.order ?? []).map((task) => task.trim()).filter((task) => task !== '')
  if (req.change === 'order' && order.length === 0) {
    throw new Error('an order is a list of queued work, first to last: say which comes first')
  }
  // `all` marks a choice made about a whole project's queue, which is what
  // pausing and resuming everything is read from. An order is never that.
  const whole = !req.task && (req.change === 'pause' || req.change === 'resume')
  await tade.log.append({
    type: 'queue_changed',
    task: req.task ?? null,
    detail: {
      change: req.change,
      by: req.by,
      ...(req.change === 'order' ? { order } : {}),
      ...(whole ? { all: true } : {}),
      ...(!req.task && req.project ? { project: req.project } : {}),
    },
  })
  return null
}

/**
 * Wait on other work, by adding to what it waits on or replacing it — checked
 * by `checkPlan`'s rules across every task there is (`checkWaits`).
 *
 * **One at a time per home, not per file.** Two waits written at once on two
 * tasks — each waiting on the other — would each pass a check that read the
 * world before the other was written, and close a loop neither would alone.
 */
function waitOn(
  tade: QueueChanger,
  req: QueueChangeRequest & { task: string },
): Promise<StartCondition> {
  return aloneOn(`${tade.home}#waits`, async () => {
    const { tasks, started } = await tasksKnown(tade)
    const file = await queuedFile(tade.home, req.task, started)
    // What every other piece of queued work waits on, for the loop check:
    // work that has started waits on nothing any more, so no loop runs through it.
    const waits = new Map<string, readonly string[]>()
    await Promise.all(
      [...tasks]
        .filter((task) => task !== req.task && !started.has(task))
        .map(async (task) => {
          const after = (await readTaskFile(tade.home, task))?.start?.after
          if (after)
            waits.set(
              task,
              after.map((dep) => dep.task),
            )
        }),
    )
    // Whether each one an approval is asked of produces a document at all.
    const producing = new Map<string, boolean>()
    const here = req.task.split('/')[0] ?? ''
    await Promise.all(
      (req.after ?? [])
        .filter((dep) => dep.approved)
        .map(async (dep) => {
          const task = dep.task.includes('/') ? dep.task.trim() : `${here}/${dep.task.trim()}`
          const its = await readTaskFile(tade.home, task).catch(() => null)
          producing.set(task, Boolean(its?.produces?.trim()))
        }),
    )
    const checked = checkWaits({
      task: req.task,
      current: file.after,
      after: req.after ?? [],
      replace: req.replace === true,
      tasks,
      waits: (task) => waits.get(task) ?? [],
      produces: (task) => producing.get(task) ?? true,
    })
    if (!checked.ok) throw new Error(checked.problems.join('; '))
    const start = await writeStart(tade.home, req.task, (kept) => {
      kept.after = checked.after
    })
    await tade.log.append({
      type: 'queue_changed',
      task: req.task,
      detail: {
        change: 'after',
        by: req.by,
        after: checked.after,
        // What it waited on before, so whoever was not watching can put it back.
        ...(req.replace === true ? { replace: true, was: file.after.map((dep) => dep.task) } : {}),
      },
    })
    return start
  })
}

/** What queued work waits on after a removal handed it on, or why it could not take it over. */
export type HandedOn =
  | { task: string; after: { task: string; why: string }[] }
  | { task: string; problem: string }

/**
 * Remove a task, and hand what it waited on to every piece of queued work that
 * waited on it (`remove` with `dependents: inherit`), so taking one task out
 * of a chain holds nothing after it. Each is written into its task file and
 * said in a `queue_changed` line, `inherited` naming the task removed, with
 * what it waited on before.
 *
 * Removing is the caller's — the window's, which knows the worktree and the
 * branch — and runs **inside the lock every wait is written under**: a wait on
 * the task written while it was being removed would pass a check that still
 * found it, and be left naming work that had gone. What it waited on is read
 * before it goes, since its task file goes with it. A removal that fails
 * writes nothing; a task file that will not take its new waits keeps the old
 * ones, is held on the removal like any other, and is named in the answer.
 */
export function handOnWaits(
  tade: QueueChanger,
  req: { task: string; by: Asker },
  remove: () => Promise<void>,
): Promise<HandedOn[]> {
  return aloneOn(`${tade.home}#waits`, async () => {
    const waits = (await readTaskFile(tade.home, req.task))?.start?.after ?? []
    await remove()
    const { tasks, started } = await tasksKnown(tade)
    const queued = [...tasks].filter((task) => task !== req.task && !started.has(task))
    const files = await Promise.all(
      queued.map(async (task) => ({ task, start: (await readTaskFile(tade.home, task))?.start })),
    )
    const handed: HandedOn[] = []
    for (const { task, start } of files) {
      if (!start?.after.some((dep) => dep.task === req.task)) continue
      const after = inheritWaits({ task, current: start.after, removed: req.task, waits })
      try {
        await writeStart(tade.home, task, (kept) => {
          kept.after = after
        })
      } catch (err) {
        handed.push({ task, problem: err instanceof Error ? err.message : String(err) })
        continue
      }
      await tade.log.append({
        type: 'queue_changed',
        task,
        detail: {
          change: 'after',
          by: req.by,
          after,
          replace: true,
          was: start.after.map((dep) => dep.task),
          inherited: req.task,
        },
      })
      handed.push({ task, after })
    }
    return handed
  })
}

/** Every task there is, and which of them have ever started, as the journal says. */
async function tasksKnown(
  tade: QueueChanger,
): Promise<{ tasks: Set<string>; started: Set<string> }> {
  const events = await tade.log.read({ types: ['task_created', 'task_removed', 'run_started'] })
  const tasks = new Set<string>()
  const started = new Set<string>()
  for (const event of events) {
    if (!event.task) continue
    if (event.type === 'task_created') tasks.add(event.task)
    if (event.type === 'task_removed') tasks.delete(event.task)
    if (event.type === 'run_started') started.add(event.task)
  }
  return { tasks, started }
}

/**
 * Tell queued work something else before it starts, or say it will change
 * other files. Its prompt is not copied into the journal — no more than the
 * one it was made with was — and the files are, since they are what a hold
 * on the tree is about.
 */
async function retell(
  tade: QueueChanger,
  req: QueueChangeRequest & { task: string },
): Promise<StartCondition> {
  const prompt = req.prompt
  const touches = req.touches?.map((path) => path.trim()).filter((path) => path !== '')
  if (prompt === undefined && touches === undefined) {
    throw new Error(
      'retell changes what queued work is told (prompt), what it says it will change (touches), or both: say which',
    )
  }
  if (prompt !== undefined && prompt.trim() === '') {
    throw new Error(`a prompt is what ${req.task}'s agent is told when it starts: say what`)
  }
  const runs = await tade.log.read({ types: ['run_started'], task: req.task })
  await queuedFile(tade.home, req.task, new Set(runs.length > 0 ? [req.task] : []))
  const start = await writeStart(tade.home, req.task, (kept) => {
    if (prompt !== undefined) kept.prompt = prompt
    if (touches !== undefined) kept.touches = touches
  })
  await tade.log.append({
    type: 'queue_changed',
    task: req.task,
    detail: {
      change: 'retell',
      by: req.by,
      retold: [
        ...(prompt !== undefined ? ['prompt'] : []),
        ...(touches !== undefined ? ['touches'] : []),
      ],
      ...(touches !== undefined ? { touches } : {}),
    },
  })
  return start
}

/** The start of a task that is still queued, or why there is none to change. */
async function queuedFile(
  home: string,
  task: string,
  started: ReadonlySet<string>,
): Promise<StartCondition> {
  if (started.has(task)) {
    throw new Error(`${task} has started, so it is not queued any more: tell its agent instead`)
  }
  const start = (await readTaskFile(home, task))?.start
  if (!start) throw new Error(`there is no queued work called ${task}`)
  return start
}

/**
 * Change a queued task's `start` in its file, every other field exactly as it
 * was — under the lock every write of that file takes (`aloneOn`), so a park
 * written at the same moment is not lost to it.
 */
function writeStart(
  home: string,
  task: string,
  change: (start: Record<string, unknown>) => void,
): Promise<StartCondition> {
  const path = taskFilePath(home, task)
  return aloneOn(path, async () => {
    const file = (parseYaml(await readFile(path, 'utf8')) ?? {}) as Record<string, unknown>
    const start = file.start
    if (typeof start !== 'object' || start === null) {
      throw new Error(`there is no queued work called ${task}`)
    }
    change(start as Record<string, unknown>)
    // Read back before it is written: a task file that no longer reads is a
    // task that has gone from every list, which is far worse than a refusal.
    const parsed = TaskFile.safeParse(file)
    if (!parsed.success || !parsed.data.start) {
      throw new Error(`${task}'s task file would not read after that, so it was left as it was`)
    }
    await rewriteTaskFile(path, file)
    return parsed.data.start
  })
}

/** What held queued work was waiting on, as the window found it. */
export interface HeldHow {
  on?: string
  start?: 'failed'
  /** The files work going on now had changed under it, when that is what held it. */
  changed?: readonly string[]
  /** Whose changes they were, where git said whose. */
  by?: readonly string[]
}

/** Queued work that could not start, held with why until someone chooses. */
export async function holdQueued(
  log: EventLog,
  task: string,
  because: string,
  how: HeldHow,
): Promise<void> {
  await log.append({
    type: 'queue_held',
    task,
    detail: {
      because,
      ...(how.on ? { on: how.on } : {}),
      ...(how.start ? { start: how.start } : {}),
      ...(how.changed ? { changed: [...how.changed] } : {}),
      ...(how.by && how.by.length > 0 ? { by: [...how.by] } : {}),
    },
  })
}

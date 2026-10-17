import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDir } from '@tade/core'
import type { RunId, WorkerAdapter } from '@tade/harnesses-core'
import type { EventLog } from './events.ts'
import type { LaneRecord } from './registry.ts'

// What a harness writes for a run so that a line could launch it — Claude
// Code's settings, MCP config, instructions and plugin, the pictures it was
// pointed at — outlived its task: 628 run folders under one machine's
// `runs/claude`, 12 MB, 595 of them for tasks long removed. They go now by the
// rule the registry forgets a dead lane by (`forgettable`): nothing is taken
// while there is still a task to put the work back into.

/** What taking a run's files away needs: Tade's home, the journal, the lanes and the harnesses. */
export interface RunsHome {
  home: string
  log: Pick<EventLog, 'read' | 'append'>
  /** The lanes the registry holds now. */
  lanes: () => readonly LaneRecord[]
  /** Every harness's adapter: each knows only where its own runs' files are. */
  adapters: () => readonly WorkerAdapter[]
}

/**
 * The runs nothing can launch again, with what every harness wrote for them
 * taken away; only `task`'s, when one is named. A run is over when its task
 * was made (`task_created`) and its task file is gone now, and its lane is
 * neither running nor `lost`, which is the one the next window opens again.
 *
 * Made, because a chat never had a task file and is brought back from what
 * the journal heard of it, and the orchestrator's conversation is never a task's:
 * neither was ever a task that could be gone. Every harness is asked, since a
 * task may have run in several; a harness that wrote nothing for a run takes
 * nothing away, and none of them ever takes a conversation.
 *
 * Whatever went wrong looking or taking away is a `warning` rather than a
 * throw, because a window that will not open over Tade's own leftovers is
 * worse than one that says it could not take them away. A journal that cannot
 * be written to is thrown: that is no leftover.
 */
export async function settleRuns(deps: RunsHome, task?: string): Promise<RunId[]> {
  let over: RunId[]
  try {
    over = await runsOver(deps, task)
  } catch (cause) {
    await warn(deps, `could not tell which runs' files are left over: ${String(cause)}`)
    return []
  }
  if (over.length === 0) return []
  const forgotten = new Set<RunId>()
  for (const adapter of deps.adapters()) {
    try {
      for (const run of await adapter.forgetRuns(over)) forgotten.add(run)
    } catch (cause) {
      await warn(
        deps,
        `could not take away ${adapter.id}'s files for runs that are over: ${String(cause)}`,
      )
    }
  }
  return [...forgotten]
}

async function runsOver(deps: RunsHome, only?: string): Promise<RunId[]> {
  const events = await deps.log.read({
    types: ['task_created', 'run_started'],
    ...(only ? { task: only } : {}),
  })
  const made = new Set<string>()
  const runs = new Map<string, string>()
  for (const event of events) {
    if (!event.task) continue
    if (event.type === 'task_created') made.add(event.task)
    else if (event.run) runs.set(event.run, event.task)
  }
  const held = new Set(
    deps
      .lanes()
      .filter((lane) => lane.alive || lane.lost)
      .map((lane) => lane.id),
  )
  const gone = new Map<string, boolean>()
  const over: RunId[] = []
  for (const [run, task] of runs) {
    if (!made.has(task) || held.has(run)) continue
    if (!gone.has(task)) gone.set(task, await taskGone(deps.home, task))
    if (gone.get(task)) over.push(run as RunId)
  }
  return over
}

/**
 * Whether a task's file is not there. Only a file that is missing says so: one
 * this cannot reach, or an id `taskDir` refuses, is a task — a disk that is
 * not mounted must never be read as work that is over.
 */
async function taskGone(home: string, task: string): Promise<boolean> {
  try {
    await access(join(taskDir(home, task), 'task.yaml'))
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

async function warn(deps: RunsHome, message: string): Promise<void> {
  await deps.log.append({ type: 'warning', detail: { message } })
}

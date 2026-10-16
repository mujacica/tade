import { branchSlug, type TaskWorktree } from './tasks.ts'
import type { Workbench } from './workbench.ts'

// A finding made into work: what a watch says to tell an agent, and the task
// that becomes, named for what it is about.
//
// Out of `workbench.ts`, which is at its budget, and beside the shape it reads
// so the two are one subject in one place. Intake is not here: work from
// outside this machine goes through the owner's grant (`intake.ts`), and only
// what that rule settled is ever written down as found.

/**
 * What something that found work says to tell an agent about it.
 *
 * The same shape as `WatchAgent` in the extensions port, written again here
 * because nothing in the workbench may import an extension: extensions depend
 * on this package and not the other way about. One definition in this package,
 * so `watchFound` and whoever else makes a task out of a finding cannot come to
 * disagree about what one says.
 */
export interface FoundWork {
  title: string
  prompt: string
  context?: string
  links?: readonly { title: string; url: string }[]
  /** A tree nobody else is in, whatever the project says (`WatchAgent.alone`): never wider. */
  alone?: boolean
  /** Where that tree begins, a ref in its own project (`WatchAgent.from`). */
  from?: string
  /** Made parked, for a person to pick up (`WatchAgent.parked`): it may only ever hold. */
  parked?: boolean
}

/**
 * Make the work for one finding: queued work, named for what it is about, in
 * the project's own workspace or a tree of its own where the work says it
 * cannot share one — and parked where the work is a proposal.
 *
 * Written down as found either way, with why where it could not be made,
 * because tried again at every look it would fail at every look.
 */
export async function makeFoundWork(
  tade: Pick<Workbench, 'createTask' | 'parkTask' | 'log'>,
  schedule: { id: string; project: string },
  found: { schedule: string; key: string; title: string },
  agent: FoundWork,
): Promise<{ task: string }> {
  const stem = branchSlug(agent.title)
  try {
    for (let n = 1; n <= 50; n++) {
      const slug = n === 1 ? stem : `${stem}-${n}`
      let task: TaskWorktree
      try {
        task = await tade.createTask({
          project: schedule.project,
          slug,
          intent: agent.prompt,
          by: `schedule:${schedule.id}`,
          ...(agent.context ? { context: agent.context } : {}),
          ...(agent.links && agent.links.length > 0 ? { links: agent.links } : {}),
          // Work that cannot share a tree (`FoundWork.alone`) gets one of its
          // own wherever the project has its agents work, never wider, begun
          // where it says (`from`) or on the base like any queued work.
          ...(agent.alone ? { workspace: 'worktree' as const } : {}),
          start: { after: [], prompt: agent.prompt, touches: [], from: agent.from },
        })
      } catch (err) {
        if (/already exists|used before/.test(err instanceof Error ? err.message : '')) continue
        throw err
      }
      // Parked straight after it is made, through the one door that writes a
      // park, as intake under `propose` and a stamped-out template are. A
      // queue that read the tasks in between still finds it parked, because
      // starting reads the task file again (`startQueued`); and a park that
      // failed is thrown rather than swallowed, so the look says so.
      if (agent.parked) await tade.parkTask(task.id, true, { by: `schedule:${schedule.id}` })
      await tade.log.append({ type: 'watch_found', task: task.id, detail: found })
      return { task: task.id }
    }
    throw new Error(`every name like ${stem} is taken in ${schedule.project}`)
  } catch (err) {
    const problem = err instanceof Error ? err.message : String(err)
    await tade.log.append({ type: 'watch_found', detail: { ...found, problem } })
    throw err
  }
}

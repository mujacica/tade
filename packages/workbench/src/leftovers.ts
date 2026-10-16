import {
  isChatTask,
  joined,
  type LeftoverMade,
  leftoversIn,
  leftoverWork,
  readLeftovers,
  sameLeftover,
} from '@tade/core'
import { branchSlug, type TaskWorktree } from './tasks.ts'
import type { Workbench } from './workbench.ts'

// What an agent found and did not fix, made into work for the orchestrator to
// decide (`core/src/leftovers.ts` has the why). The tool's name, and the door
// both ways of reporting go through: `tade_leftovers` before finishing, and
// `tade_done`'s `leftovers`, which every harness sends here first, so a report
// that is refused is refused before the task says it has finished.
//
// Each item becomes a task in the reporting agent's project, named for what
// it is, made **parked** — the shape a watch's proposal has (`found.ts`) — so
// nothing starts it until the orchestrator or a person decides, and one line,
// `leftovers_reported`, writes the report down on the reporting task with the
// task each item became. The window hears that line and tells the
// orchestrator at once (`wire/leftovers.ts`).

/** The tool's name, as every harness's own side registers it. */
export const LEFTOVERS = 'tade_leftovers'

/** One agent's report, as the supervisor hands it on. */
export interface LeftoversCall {
  run: string
  task: string
  input: Record<string, unknown>
}

/**
 * Make each new item parked work, write the report down, and say back what
 * became of it. Thrown — so the agent reads why, and on `tade_done` nothing is
 * finished yet — where an item is missing what makes it findable again, or
 * where one could not be made; whatever was made is written down first, and
 * sending the same report again makes none of it twice.
 */
export async function reportLeftovers(
  tade: Pick<Workbench, 'createTask' | 'parkTask' | 'log'>,
  call: LeftoversCall,
): Promise<string> {
  const read = readLeftovers(call.input.items)
  if ('problem' in read) throw new Error(read.problem)
  const from = call.task
  const project = from.slice(0, Math.max(0, from.indexOf('/')))
  if (!project || isChatTask(from)) {
    throw new Error('only an agent working on a task can report what it left: say it in your reply')
  }
  // What it said already, by title: the tool before finishing and then
  // `tade_done` with the same items is one report, not two.
  const earlier = (await tade.log.read({ task: from, types: ['leftovers_reported'] })).flatMap(
    leftoversIn,
  )
  const made: LeftoverMade[] = []
  const again: string[] = []
  const failed: string[] = []
  for (const item of read.items) {
    const seen = [...earlier, ...made].find((one) => sameLeftover(one.title, item.title))
    if (seen) {
      again.push(`"${item.title}" (${seen.task})`)
      continue
    }
    try {
      made.push({ ...item, task: await makeLeftover(tade, project, from, item) })
    } catch (err) {
      failed.push(`"${item.title}" (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  if (made.length > 0) {
    await tade.log.append({
      type: 'leftovers_reported',
      task: from,
      run: call.run,
      detail: {
        items: made.map((one) => ({
          task: one.task,
          title: one.title,
          where: one.where,
          why: one.why,
          sure: one.sure,
        })),
        ...(call.input.finishing === true ? { finishing: true } : {}),
      },
    })
  }
  const told =
    made.length > 0
      ? `What you left is put to the orchestrator as ${joined(made.map((one) => one.task))}, parked until it decides whether each gets fixed, so do not fix ${made.length === 1 ? 'it' : 'them'} yourself now.`
      : ''
  const repeated = again.length > 0 ? `Already reported: ${joined(again)}.` : ''
  if (failed.length > 0) {
    throw new Error(
      [told, repeated, `Could not make ${joined(failed)}: send those again.`]
        .filter(Boolean)
        .join(' '),
    )
  }
  return [told, repeated].filter(Boolean).join(' ') || 'Nothing new to report.'
}

/**
 * One item made parked work: named for what it is and numbered where that is
 * taken, told what `leftoverWork` says with the report in its context file,
 * and parked through the one door that writes a park, straight after it is
 * made — a queue that read the tasks in between still finds it parked,
 * because starting reads the task file again (`startQueued`).
 */
async function makeLeftover(
  tade: Pick<Workbench, 'createTask' | 'parkTask'>,
  project: string,
  from: string,
  item: Parameters<typeof leftoverWork>[1],
): Promise<string> {
  const { prompt, context } = leftoverWork(from, item)
  const by = `agent:${from}`
  const stem = branchSlug(item.title)
  for (let n = 1; n <= 50; n++) {
    const slug = n === 1 ? stem : `${stem}-${n}`
    let task: TaskWorktree
    try {
      task = await tade.createTask({
        project,
        slug,
        intent: prompt,
        by,
        context,
        start: { after: [], prompt, touches: [] },
      })
    } catch (err) {
      if (/already exists|used before/.test(err instanceof Error ? err.message : '')) continue
      throw err
    }
    await tade.parkTask(task.id, true, { by })
    return task.id
  }
  throw new Error(`every name like ${stem} is taken in ${project}`)
}

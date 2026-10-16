import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Asker,
  finishedFrom,
  joined,
  type Plan,
  type PlanBusy,
  projectDir,
  type RaceRequest,
  raceKey,
  racePlan,
  wonFrom,
} from '@tade/core'
import type { EventLog } from './events.ts'
import type { PlanMade } from './plans.ts'
import { readTaskFile } from './tasks.ts'

// Starting a race and deciding one — the two acts a race has (`race.ts` in
// core is everything else, and pure).
//
// Starting is a plan and nothing more: `racePlan` makes one, and `planTasks`
// keeps it or refuses it with every reason, so the names, the project, the
// models and the harnesses are checked by the one path every plan goes
// through. What it makes is queued work, so the queue starts the entrants by
// its own rule — `max_parallel` and every hold included.
//
// Deciding is the one thing about a race that is told rather than derived:
// `race_won`, with who decided and the sentence they gave. The others are
// stopped and marked finished, and nothing here removes a worktree or a
// branch — whoever wants one gone closes it, and is asked first.

/** Start a race: its plan, made through the plan path. Throws every reason it was refused. */
export async function startRace(
  tade: { planTasks(plan: Plan, by?: string, busy?: readonly PlanBusy[]): Promise<PlanMade> },
  req: RaceRequest,
  by = 'orchestrator',
  busy: readonly PlanBusy[] = [],
): Promise<PlanMade> {
  const made = racePlan(req)
  if (!made.ok) throw new Error(`the race was not started: ${made.problems.join('; ')}`)
  return tade.planTasks(made.plan, by, busy)
}

/** The tasks whose own file names this race, in one project, by id. */
export async function entrantsOf(home: string, project: string, race: string): Promise<string[]> {
  const folders = await readdir(join(projectDir(home, project), 'tasks')).catch(() => [])
  const out: string[] = []
  for (const folder of folders.sort()) {
    const file = await readTaskFile(home, `${project}/${folder}`)
    if (file?.race === race) out.push(file.id ?? `${project}/${folder}`)
  }
  return out
}

/** Somebody's decision about a race. */
export interface RacePick {
  project: string
  race: string
  /** The entrant kept, by its task id. */
  task: string
  by: Asker
  /** Why, in their words or the orchestrator's account of them: kept verbatim. */
  why: string
}

/** What deciding a race needs of the workbench, and nothing else. */
export interface PickDeps {
  home: string
  log: Pick<EventLog, 'read' | 'append'>
  stopAgent(task: string): Promise<void>
  markDone(task: string, how: { by: Asker; summary: string }): Promise<void>
}

/**
 * Decide a race: write down which entrant is kept and why, then stop every
 * other one and mark it finished — its worktree and branch left exactly where
 * they are. Refused, with what to do instead, when there is no such race, the
 * entrant is not in it, nothing says why, or it was decided already.
 */
export async function pickRace(
  deps: PickDeps,
  req: RacePick,
): Promise<{ task: string; closed: string[] }> {
  const why = req.why.trim()
  if (!why) throw new Error('say why this one, in a sentence: it is what the journal keeps')
  const entrants = await entrantsOf(deps.home, req.project, req.race)
  if (entrants.length === 0)
    throw new Error(`there is no race called ${req.race} in ${req.project}`)
  if (!entrants.includes(req.task)) {
    throw new Error(`${req.task} is not an entrant in ${req.race}: ${joined(entrants)} are`)
  }
  const decided = wonFrom(await deps.log.read({ types: ['race_won'] })).get(
    raceKey(req.project, req.race),
  )
  if (decided) {
    throw new Error(
      `${req.race} was decided already: ${decided.task} was picked, and a race is decided once. Its other branches are kept, if one of them is wanted after all`,
    )
  }
  const finished = finishedFrom(await deps.log.read({ types: ['task_done'] }))
  const closed = entrants.filter((one) => one !== req.task)
  await deps.log.append({
    type: 'race_won',
    task: req.task,
    detail: { race: req.race, project: req.project, by: req.by, why, closed },
  })
  const kept = req.task.split('/')[1] ?? req.task
  for (const task of closed) {
    await deps.stopAgent(task).catch(() => {})
    if (!finished.has(task)) {
      await deps.markDone(task, {
        by: req.by,
        summary: `${req.race} went to ${kept}; this branch is kept`,
      })
    }
  }
  return { task: req.task, closed }
}

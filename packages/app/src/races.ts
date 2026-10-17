import {
  findingsFor,
  type Race,
  type RaceFinding,
  type RacerFacts,
  type RaceWon,
  racesIn,
  sizeOf,
  strayedIn,
  type Workspace,
} from '@tade/core'
import { checksIn } from './away-checks.ts'
import type { ActionsView } from './frame.ts'

// The races, as the window folds them: core's rule (`racesIn`) over what the
// window already holds.
//
// Pure, and asks nobody anything. Which tasks are entrants is what their task
// files say (status's last look carries `race`); the checks and what each
// change touched are the ACTIONS page's last look at each one (`seenActions`),
// so an entrant nobody has looked at yet says so rather than reading green;
// whether the judge said it strayed is what the judges last said; the money is
// the window's own usage fold; and who picked is the journal's `race_won`.

/** What the window hands the fold. */
export interface RaceInputs {
  world: Workspace
  /** The tasks the journal says are finished (`task_done`), out of the whole journal. */
  finished: ReadonlySet<string>
  /** The last look at a task's commits and checks, never a look. */
  work: (task: string) => ActionsView | null
  /** What the judges last said, or null where none could be read. */
  findings: readonly RaceFinding[] | null
  /** What a task has cost over every run, or null where nothing recorded money. */
  usd: (task: string) => number | null
  /** Every race decided, by `raceKey`. */
  won: ReadonlyMap<string, RaceWon>
  /** The harness a project's agents run in where a task file names none: its route's. */
  harnessOf: (project: string) => string
}

/** One entrant's facts, out of what the window holds about its task. */
export function racerOf(
  task: Workspace['projects'][number]['tasks'][number],
  project: string,
  inputs: Omit<RaceInputs, 'world' | 'won'>,
): RacerFacts | null {
  if (!task.race) return null
  const work = inputs.work(task.id)
  const checks = checksIn(work, false)
  return {
    task: task.id,
    race: task.race,
    project,
    said: task.intent_spoken,
    harness: task.harness ?? inputs.harnessOf(project),
    model: task.start?.model?.id ?? null,
    created: task.created,
    state: task.state,
    finished: inputs.finished.has(task.id),
    checks: work === null ? null : checks.state,
    failed: checks.failed,
    findings: inputs.findings === null ? null : findingsFor(inputs.findings, task.id),
    strayed: strayedIn(inputs.findings, task.id),
    size: sizeOf(work?.mine ?? null),
    usd: inputs.usd(task.id),
  }
}

/** Every race among the tasks the window can see, undecided first, then the newest. */
export function racesOf(inputs: RaceInputs): Race[] {
  const racers: RacerFacts[] = []
  for (const one of inputs.world.projects) {
    for (const task of one.tasks) {
      const facts = racerOf(task, one.name, inputs)
      if (facts) racers.push(facts)
    }
  }
  return racesIn(racers, inputs.won)
}

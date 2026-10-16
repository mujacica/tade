import {
  joined,
  LINES_LOOKED_BACK,
  type Plan,
  pickNamedBy,
  pricesFrom,
  RACE_PICK,
  type Race,
  type RaceEntrant,
  type RaceFinding,
  racePlan,
  raceStandingSays,
  resolveRoute,
  spendFrom,
  wonFrom,
} from '@tade/core'
import { pickRace } from '@tade/workbench'
import type { ActionsView } from '../frame.ts'
import { racesOf } from '../races.ts'
import { lookAtWork } from '../work-look.ts'
import type { Wiring } from './context.ts'
import { heldFindings } from './findings.ts'

// Races, as the window answers for them: the orchestrator's three tools, and
// the press that picks one in the comparison panel (`panels/race/`).
//
// **Starting is a plan.** `racePlan` makes one and the queue's own `plan`
// keeps it, so a race is checked, made, started and answered exactly the way
// any plan is — and it starts by the queue's rule, `max_parallel` included.
//
// **Picking is a person's**, and the orchestrator's only on a line of theirs
// (`RACE_PICK`). That is checked here, against the journal's `said` lines, and
// never in the tool: the tool runs where the model lives, and a rule there is a
// rule the model can be talked out of. What authorises it is a line the person
// typed or spoke since shortly before the race began — "race these and pick
// the best" is said before there is a race to name, so the look reaches back
// `ASKED_BEFORE` past its first entrant, and no further: a "pick one" said
// about yesterday's work is not about this race.

/** How long before a race's first entrant a line of theirs may have asked for it to be picked. */
export const ASKED_BEFORE = 30 * 60_000

/** What starting one takes, as the orchestrator sends it. */
export interface RaceStart {
  project: string
  name: string
  said: string
  prompt: string
  entrants: readonly RaceEntrant[]
  n?: number
  context?: string
}

/** What the orchestrator's race tools do, answered from this window. */
export interface RaceTools {
  start(req: RaceStart): Promise<string>
  standing(req: { project?: string; race?: string }): Promise<string>
  pick(req: {
    project?: string
    race: string
    task: string
    why: string
    said: string
  }): Promise<string>
}

/** What each task has cost over every run, from the window's own usage fold. */
export function usdByTask(wire: Wiring): Readonly<Record<string, number | null>> {
  const live = wire.live
  if (!live) return {}
  const report = spendFrom(live.spending.events, {
    since: 0,
    prices: pricesFrom(wire.opts.config.prices),
  })
  return Object.fromEntries(
    Object.entries(report.byTask).map(([task, spend]) => [task, spend.hasCost ? spend.usd : null]),
  )
}

/**
 * Every race the window can see, folded from what it holds: the last look at
 * each entrant's work unless `work` says otherwise, what the judges last said,
 * and who picked, out of the whole journal the queue reads.
 */
export function racesHeld(
  wire: Wiring,
  usd: Readonly<Record<string, number | null>>,
  work?: (task: string) => ActionsView | null,
): Race[] {
  const live = wire.live
  const world = live?.world
  if (!live || !world) return []
  const facts = live.queueFacts()
  return racesOf({
    world,
    finished: new Set(facts.finished.keys()),
    work: work ?? ((task) => live.seenActions(task)),
    findings: heldFindings(wire) as readonly RaceFinding[] | null,
    usd: (task) => usd[task] ?? null,
    won: wonFrom(facts.events),
    harnessOf: (project) => resolveRoute(wire.opts.config, { project }).harness,
  })
}

/** The orchestrator's race tools, from this window. `plan` is the queue's own. */
export function raceTools(wire: Wiring, plan: (plan: Plan) => Promise<string>): RaceTools {
  return {
    start: async (req) => {
      const made = racePlan(req)
      if (!made.ok) throw new Error(`the race was not started: ${made.problems.join('; ')}`)
      const answer = await plan(made.plan)
      return `${answer}\nThey are a race: compare them with tade_race_standing once they have worked. Nothing is picked until the person picks — in the window with /race, or by asking you to.`
    },
    standing: async (req) => {
      await wire.live?.refresh()
      const races = matching(await racesNow(wire), req)
      if (races.length === 0) return noRace(wire, req)
      return races.map((one) => raceStandingSays(one).join('\n')).join('\n\n')
    },
    pick: async (req) => {
      if (req.said.trim() === '') {
        throw new Error(
          'Picking a race is done when somebody asks for it. Pass what they said, word for word.',
        )
      }
      await wire.live?.refresh()
      const [race, ...others] = matching(racesHeld(wire, {}), req)
      if (!race) throw new Error(noRace(wire, req))
      if (others.length > 0) {
        throw new Error(
          `${req.race} is a race in ${joined([race.project, ...others.map((one) => one.project)])}: say which project`,
        )
      }
      const since = Date.parse(race.began) - ASKED_BEFORE
      const lines = (
        await wire.opts.client.events({ types: ['said'], limit: LINES_LOOKED_BACK }).catch(() => [])
      )
        .filter((event) => Date.parse(event.ts) >= since)
        .flatMap((event) => (typeof event.detail.text === 'string' ? [event.detail.text] : []))
      if (!pickNamedBy(lines)) {
        throw new Error(
          `Nothing they have said since ${race.name} began asks me to pick, so I will not: ${RACE_PICK.because}. Read them the standing and let them choose — /race in the window — or ask them plainly whether I should.`,
        )
      }
      const task = req.task.includes('/') ? req.task : `${race.project}/${req.task}`
      return picked(wire, await pick(wire, race, task, 'orchestrator', req.why))
    },
  }
}

/** Pick an entrant on the person's press in the comparison panel. Says what it did, or why not. */
export async function pickPressed(wire: Wiring, task: string): Promise<string> {
  const race = racesHeld(wire, {}).find((one) => one.racers.some((r) => r.facts.task === task))
  if (!race) throw new Error(`${task} is not in a race any more`)
  return picked(wire, await pick(wire, race, task, 'you', 'picked in the window'))
}

function pick(
  wire: Wiring,
  race: Race,
  task: string,
  by: 'you' | 'orchestrator',
  why: string,
): Promise<{ task: string; closed: string[] }> {
  const client = wire.opts.client
  return pickRace(
    {
      home: client.home,
      log: client.log,
      stopAgent: (one) => client.stopAgent(one),
      markDone: (one, how) => client.markDone(one, how),
    },
    { project: race.project, race: race.name, task, by, why },
  )
}

async function picked(wire: Wiring, done: { task: string; closed: string[] }): Promise<string> {
  await wire.live?.refresh()
  wire.draw()
  const closed =
    done.closed.length > 0
      ? ` Stopped and marked finished, branches kept: ${joined(done.closed)}.`
      : ''
  return `Picked ${done.task}.${closed} It goes on like any finished work: its review and its merge are the person's.`
}

/**
 * Every race, each entrant's work looked at now rather than at the last beat:
 * a tool answers about now, and the orchestrator is about to say these figures
 * to somebody.
 */
async function racesNow(wire: Wiring): Promise<Race[]> {
  const live = wire.live
  if (!live) return []
  const looked = new Map<string, ActionsView>()
  for (const race of racesHeld(wire, {})) {
    for (const racer of race.racers) {
      const task = racer.facts.task
      const root = live.worktreeOf(task)
      if (!root) continue
      const work = await lookAtWork({
        task,
        root,
        base: live.baseOf(task),
        facts: live.factsOf(task),
        config: wire.opts.config,
        tadeHome: wire.opts.home,
        now: wire.now(),
      }).catch(() => null)
      if (work) looked.set(task, work)
    }
  }
  return racesHeld(wire, usdByTask(wire), (task) => looked.get(task) ?? live.seenActions(task))
}

function matching(races: readonly Race[], req: { project?: string; race?: string }): Race[] {
  return races.filter(
    (one) => (!req.project || one.project === req.project) && (!req.race || one.name === req.race),
  )
}

/** That there is no such race, and which there are. */
function noRace(wire: Wiring, req: { project?: string; race?: string }): string {
  const there = racesHeld(wire, {}).map((one) => `${one.name} in ${one.project}`)
  const asked =
    `${req.race ? `called ${req.race}` : ''}${req.project ? ` in ${req.project}` : ''}`.trim()
  return `There is no race${asked ? ` ${asked}` : ''}.${there.length > 0 ? ` There ${there.length === 1 ? 'is' : 'are'} ${joined(there)}.` : ' Start one with tade_race.'}`
}

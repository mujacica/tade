import {
  agentStopped,
  dollars,
  expandHome,
  joined,
  LINES_LOOKED_BACK,
  overCeiling,
  type RaceFinding,
  REPLAY_START,
  type Replay,
  type ReplayCandidate,
  type ReplayEntrantFacts,
  type ReplayRecords,
  replayNamedBy,
  replayRecords,
  replaySays,
  replaysIn,
  sizeOf,
  stalledIn,
  stoppedBy,
  strayedIn,
  type TadeEvent,
  ungraded,
} from '@tade/core'
import type { JudgeReplayFact } from '@tade/extensions-core'
import { gradeEntrant, startReplay } from '@tade/workbench'
import { checksIn } from '../away-checks.ts'
import type { ActionsView } from '../frame.ts'
import { planBusyOf } from '../queue.ts'
import { lookAtWork } from '../work-look.ts'
import { type Wiring, why } from './context.ts'
import { heldFindings } from './findings.ts'
import { usdByTask } from './races.ts'

// Replays, as the window answers for them (`replay.ts` in core is the rule):
// the orchestrator's two tools, and what the queue's beat does about each one
// that is going — its ceiling, the entrants whose agents have stopped, and the
// next grading run.
//
// **Starting is the person's.** A replay spends real money on work that has
// already landed, so the orchestrator starts one only on a line of theirs that
// asks for an eval (`REPLAY_START`), checked here against the journal's `said`
// lines and never in the tool. It is a plan underneath, so the queue starts the
// entrants by its own rule — `max_parallel`, `at` and every hold included —
// and the replay's own `after` keeps it to a few at a time.
//
// **The ceiling is looked at between entrants**, on the queue's beat and before
// anything is started: once what the entrants have cost reaches it, every one
// not finished is stopped and marked finished, and `replay_stopped` says so.
// Billed money only — a plan's turns bill none, and that is said rather than
// counted as nought.
//
// **Grading is one run at a time**, through the checks' own door, and nothing
// waits on it: the beat starts it and goes on.

/** What starting one takes, as the orchestrator sends it. */
export interface ReplayStart {
  project: string
  name: string
  /** What they said asking for it, word for word. */
  said: string
  candidate: ReplayCandidate
  last?: number
  ceilingUsd: number
  at?: string
  atOnce?: number
}

/** What the orchestrator's replay tools do, answered from this window. */
export interface ReplayTools {
  start(req: ReplayStart): Promise<string>
  standing(req: { project?: string; replay?: string }): Promise<string>
}

/** What the window keeps about replays between beats: looks, and what is being done. */
interface Held {
  /** The newest look at each entrant's work, taken by a beat or a tool, and when. */
  looked: Map<string, ActionsView>
  lookedAt: Map<string, number>
  /** The journal's replay lines folded, kept until the queue's whole-journal list grows. */
  records: { of: readonly TadeEvent[] | null; size: number; records: ReplayRecords }
  /** Entrants being finished or graded now, so a beat in between does not do it twice. */
  busy: Set<string>
  grading: boolean
}

const held = new WeakMap<object, Held>()

function heldFor(wire: Wiring): Held {
  const key = wire.opts.client
  let one = held.get(key)
  if (!one) {
    one = {
      looked: new Map(),
      lookedAt: new Map(),
      records: { of: null, size: -1, records: replayRecords([]) },
      busy: new Set(),
      grading: false,
    }
    held.set(key, one)
  }
  return one
}

/** How often the extensions are asked what candidate judges answered: a file, read rarely. */
export const JUDGE_REPLAYS_MS = 60_000

interface HeldJudges {
  replays: readonly JudgeReplayFact[] | null
  at: number
  asking: boolean
}

const judges = new WeakMap<object, HeldJudges>()

/**
 * What candidate judges answered when asked again (`jev_replay`), as the
 * extensions keep it, or null before any has answered or where none keeps any.
 * Asked on the beat and only while something reads it, like the findings.
 */
export function heldJudgeReplays(wire: Wiring): readonly JudgeReplayFact[] | null {
  const host = wire.opts.extensions
  if (!host) return null
  let one = judges.get(host)
  if (!one) {
    one = { replays: null, at: Number.NEGATIVE_INFINITY, asking: false }
    judges.set(host, one)
  }
  const kept = one
  wire.live?.keepAsking('judge-replays', () => {
    if (kept.asking || wire.now() - kept.at < JUDGE_REPLAYS_MS) return
    kept.asking = true
    kept.at = wire.now()
    void host
      .judgeReplays()
      .then(({ replays, problems, asked }) => {
        // A judge that could not say keeps what it said before; none at all is nothing read.
        if (problems.length > 0 && replays.length === 0 && kept.replays !== null) return
        const now = asked === 0 ? null : replays
        if (JSON.stringify(now) === JSON.stringify(kept.replays)) return
        kept.replays = now
        wire.draw()
      })
      .catch((err: unknown) => wire.note(err))
      .finally(() => {
        kept.asking = false
      })
  })
  return kept.replays
}

/** Every replay the window can see, folded from the whole journal the queue reads and its last looks. */
export function replaysHeld(wire: Wiring): Replay[] {
  const live = wire.live
  const world = live?.world
  if (!live || !world) return []
  const facts = live.queueFacts()
  // Folded again only when the list has grown: it is read on every beat, and
  // a beat with no replay anywhere must cost nothing but this comparison.
  const kept = heldFor(wire).records
  if (kept.of !== facts.events || kept.size !== facts.events.length) {
    kept.of = facts.events
    kept.size = facts.events.length
    kept.records = replayRecords(facts.events)
  }
  const records = kept.records
  if (records.started.size === 0) return []
  const tasks = new Map(world.projects.flatMap((one) => one.tasks.map((task) => [task.id, task])))
  const findings = heldFindings(wire) as readonly RaceFinding[] | null
  const usd = usdByTask(wire)
  const ran = live.runs.report({ since: 0, now: wire.now() }).byTask
  const looked = heldFor(wire).looked
  return replaysIn(records, (task): ReplayEntrantFacts | null => {
    const one = tasks.get(task)
    const finished = facts.finished.has(task)
    if (!one && !finished) return null
    const work = looked.get(task) ?? live.seenActions(task)
    const checks = checksIn(work, false)
    const size = work ? sizeOf([...work.mine, ...work.others]) : null
    const runtime = ran[task]
    return {
      task,
      removed: false,
      started: finished || (one !== undefined && one.state !== 'queued'),
      finished,
      state: one?.state ?? null,
      checks: work === null ? null : checks.state,
      failed: checks.failed,
      strayed: strayedIn(findings, task),
      size: size ? { commits: size.commits, added: size.added, removed: size.removed } : null,
      usd: usd[task] ?? null,
      workedMs: runtime && runtime.runs > 0 ? runtime.workingMs : null,
    }
  })
}

/** How often the beat looks at one entrant's work again: a tool always looks now. */
export const LOOK_MS = 30_000

/** Look at each entrant's work now — or, on the beat, those not looked at lately — keeping what was found. */
async function lookAt(wire: Wiring, tasks: readonly string[], every = 0): Promise<void> {
  const live = wire.live
  if (!live) return
  const { looked, lookedAt } = heldFor(wire)
  for (const task of tasks) {
    const root = live.worktreeOf(task)
    if (!root) continue
    if (wire.now() - (lookedAt.get(task) ?? Number.NEGATIVE_INFINITY) < every) continue
    lookedAt.set(task, wire.now())
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

/**
 * What the queue's beat does about every replay still going: stop the ones
 * over their ceiling, finish entrants whose agents have stopped, and start the
 * next grading run. True where it marked anything finished, so the queue looks
 * again before it starts anything.
 */
export async function replaysLook(wire: Wiring): Promise<boolean> {
  const live = wire.live
  if (!live) return false
  const going = replaysHeld(wire).filter((one) => !one.over || ungraded(one).length > 0)
  if (going.length === 0) return false
  // Only what can have moved: entrants with an agent, and those finished and waiting to be graded.
  await lookAt(
    wire,
    going.flatMap((one) =>
      one.entrants.flatMap((e) =>
        e.task && (e.outcome === 'running' || (e.facts?.finished && !e.graded)) ? [e.task] : [],
      ),
    ),
    LOOK_MS,
  )
  const client = wire.opts.client
  const own = heldFor(wire)
  let marked = false
  const finish = async (task: string, summary: string, stop: boolean) => {
    if (own.busy.has(task)) return
    own.busy.add(task)
    try {
      if (stop) await client.stopAgent(task).catch(() => {})
      await client.markDone(task, { by: 'rule', summary })
      marked = true
    } catch (err) {
      wire.note(err)
    } finally {
      own.busy.delete(task)
    }
  }
  const tasks = new Map(
    (live.world?.projects ?? []).flatMap((one) => one.tasks.map((task) => [task.id, task])),
  )
  for (const replay of replaysHeld(wire)) {
    if (replay.over) continue
    if (overCeiling(replay)) {
      const stopped = stoppedBy(replay)
      // Said once: a beat that finds one it could not stop the first time stops it, quietly.
      const said = replay.stopped
      for (const task of stopped) {
        await finish(
          task,
          `stopped: replay ${replay.name} reached its ${dollars(replay.ceilingUsd)} ceiling`,
          true,
        )
      }
      if (said) continue
      await client.log.append({
        type: 'replay_stopped',
        detail: {
          replay: replay.name,
          project: replay.project,
          spent: replay.spent.sum,
          ceiling_usd: replay.ceilingUsd,
          stopped,
        },
      })
      continue
    }
    // Stopped after it worked: an agent idle before its first turn is starting, not done.
    const stalled = stalledIn(replay, (task) => {
      const one = tasks.get(task)
      if (!one || !agentStopped(one.state, one.reason)) return false
      return one.state === 'failed' || live.hasWorked(task)
    })
    for (const task of stalled) {
      await finish(
        task,
        `replay ${replay.name}: its agent stopped, and it is scored on what it left`,
        false,
      )
    }
  }
  if (!own.grading) void gradeNext(wire)
  return marked
}

/** Start the next grading run, if there is one: one at a time, nobody waiting on it. */
async function gradeNext(wire: Wiring): Promise<void> {
  const live = wire.live
  const own = heldFor(wire)
  if (!live || own.grading) return
  const next = replaysHeld(wire)
    .flatMap((replay) => ungraded(replay).map((entrant) => ({ replay, entrant })))
    .find(({ entrant }) => entrant.task && live.worktreeOf(entrant.task))
  if (!next?.entrant.task) return
  const task = next.entrant.task
  const worktree = live.worktreeOf(task)
  if (!worktree) return
  own.grading = true
  try {
    await gradeEntrant({
      config: wire.opts.config,
      project: next.replay.project,
      task,
      replay: next.replay.name,
      worktree,
      from: next.entrant.case?.head ?? null,
      tests: next.entrant.case?.tests ?? [],
      home: expandHome('~'),
      tadeHome: wire.opts.home,
      log: wire.opts.client.log,
    })
    await live.refresh()
    wire.draw()
  } catch (err) {
    // Busy is somebody else's suite: the next beat tries again, and says nothing.
    if (!/busy|running/i.test(why(err))) wire.note(err)
  } finally {
    own.grading = false
  }
}

/** The orchestrator's replay tools, from this window. `advance` is the queue's own pass. */
export function replayTools(wire: Wiring, advance: () => Promise<string[]>): ReplayTools {
  return {
    start: async (req) => {
      if (req.said.trim() === '') {
        throw new Error(
          'A replay is started when somebody asks for an eval. Pass what they said, word for word.',
        )
      }
      const lines = (
        await wire.opts.client.events({ types: ['said'], limit: LINES_LOOKED_BACK }).catch(() => [])
      ).flatMap((event) => (typeof event.detail.text === 'string' ? [event.detail.text] : []))
      if (!replayNamedBy(lines)) {
        throw new Error(
          `Nothing they have said lately asks for an eval, so I will not start one: ${REPLAY_START.because}. Ask them plainly — with how many tasks, on what, and the most it may cost.`,
        )
      }
      await wire.live?.refresh()
      const client = wire.opts.client
      const merged = new Set(
        (wire.live?.tasks ?? []).filter((one) => one.state === 'merged').map((one) => one.task),
      )
      const made = await startReplay(
        {
          home: client.home,
          config: wire.opts.config,
          log: client.log,
          planTasks: (plan, by, busy) => client.planTasks(plan, by, busy),
          merged,
          now: wire.now(),
        },
        {
          project: req.project,
          name: req.name,
          said: req.said,
          candidate: req.candidate,
          ...(req.last !== undefined ? { last: req.last } : {}),
          ceilingUsd: req.ceilingUsd,
          ...(req.at ? { at: req.at } : {}),
          ...(req.atOnce !== undefined ? { atOnce: req.atOnce } : {}),
          by: 'orchestrator',
        },
        planBusyOf(wire.live?.tasks ?? [], [req.project]),
      )
      await wire.live?.refresh()
      const started = await advance()
      const ran = made.cases.filter((one) => one.task !== null)
      const not = made.cases.filter((one) => one.task === null)
      return [
        `Replay ${req.name} made: ${ran.length} task${ran.length === 1 ? '' : 's'} asked again${started.length > 0 ? `, ${joined(started)} started` : ''}, the rest queued behind them with a ${dollars(req.ceilingUsd)} ceiling.`,
        ...(not.length > 0
          ? [
              `Could not replay, and not counted against it: ${not.map((one) => `${one.of} (${one.couldNot})`).join('; ')}.`,
            ]
          : []),
        'Read where it stands with tade_replay_standing; the person sees it in /evals under Replays.',
      ].join('\n')
    },
    standing: async (req) => {
      await wire.live?.refresh()
      const all = replaysHeld(wire)
      await lookAt(
        wire,
        all.flatMap((one) => one.entrants.flatMap((e) => (e.task ? [e.task] : []))),
      )
      const replays = replaysHeld(wire).filter(
        (one) =>
          (!req.project || one.project === req.project) && (!req.replay || one.name === req.replay),
      )
      if (replays.length === 0) {
        const there = all.map((one) => `${one.name} in ${one.project}`)
        return `There is no replay${req.replay ? ` called ${req.replay}` : ''}${req.project ? ` in ${req.project}` : ''}.${there.length > 0 ? ` There ${there.length === 1 ? 'is' : 'are'} ${joined(there)}.` : ' Start one with tade_replay when they ask for an eval.'}`
      }
      return replays.map((one) => replaySays(one).join('\n')).join('\n\n')
    },
  }
}

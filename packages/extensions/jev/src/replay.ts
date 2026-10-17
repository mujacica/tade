import { appendFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ENOUGH,
  type JudgeReplayCase,
  type JudgeReplayScore,
  judgeReplaySays,
  judgeReplayScore,
  projectDir,
  taskFolder,
} from '@tade/core'
import type { ExtensionTool, JudgeReplayFact, ToolContext } from '@tade/extensions-core'
import { number, object, string } from '@tade/extensions-core'
import { makeJudge } from '@tade/workbench/judges'
import { Asking, allowed, judgeName, keyOf, numberSetting, project, thresholds } from './ask.ts'
import { changesFor, commitsByTask, taskFile } from './changes.ts'
import { BUDGET, RUBRIC, reviewQuestions } from './questions.ts'
import { readChange } from './review.ts'
import { type Review, readReviews } from './reviews.ts'
import { oneAgents } from './stuck.ts'
import { whoseReadings } from './whose.ts'

// A judge asked again: the questions Jev already asked about recorded changes,
// put to a candidate judge — another implementation, or another version of
// this one — and its answers counted beside the ones that were recorded and
// beside the verdicts people wrote (`judgeReplayScore`, core).
//
// The judge leg of "your own eval" (B2). Every rule a judge lives under holds
// here too, and one more:
//
//   · **Only readings of today's questions.** A reading under another `RUBRIC`
//     answered other questions, so comparing it is comparing two exams.
//   · **Counting, never grading.** Agreement and the verdicts' arithmetic are
//     code; no judge says whether another judge was right.
//   · **It costs money, so it has a ceiling** in dollars, and the candidate's
//     own request budget as well; a change it could not read for either is
//     named as not read, never counted as a disagreement.
//   · **Nothing it answers is acted on.** No finding is raised, no record of a
//     reading is written, nothing is held: the result is written to its own
//     file (`replays.jsonl`) for the Evaluations page and said to whoever
//     asked.

const DIR = 'jev'
const FILE = 'replays.jsonl'

/** How many recorded changes are read again when nobody says. */
export const JUDGE_REPLAY_LAST = 10

/** The most: every one is a reading of a whole change by a judge somebody pays for. */
export const JUDGE_REPLAY_MOST = 50

/** One judge replay, as it is written down. */
export interface JudgeReplayed {
  at: string
  /** The judge asked, by its registry name, and the version that answered. */
  judge: string
  version: string
  /** The versions whose readings it was set beside. */
  against: string[]
  rubric: string
  threshold: number
  score: JudgeReplayScore
  cost_usd: number
  /** The changes it could not read, and why: named, never counted as a disagreement. */
  unread: { unit: string; why: string }[]
}

/** Every judge replay written down, oldest first. A line that will not read is skipped. */
export function readJudgeReplays(home: string): JudgeReplayed[] {
  let raw: string
  try {
    raw = readFileSync(join(home, DIR, FILE), 'utf8')
  } catch {
    return []
  }
  const out: JudgeReplayed[] = []
  for (const text of raw.split('\n')) {
    if (!text.trim()) continue
    try {
      const line = JSON.parse(text) as JudgeReplayed
      if (line && typeof line.judge === 'string' && line.score) out.push(line)
    } catch {
      // A line that will not read is evidence nobody can use, not a reason to stop.
    }
  }
  return out
}

/** Every judge replay, newest first, as the port says one (`JudgeReplayFact`). */
export function judgeReplayFacts(home: string): JudgeReplayFact[] {
  return readJudgeReplays(home)
    .reverse()
    .map((one) => ({
      at: one.at,
      judge: one.judge,
      version: one.version,
      against: one.against,
      score: one.score,
      costUsd: one.cost_usd,
    }))
}

function record(home: string, line: JudgeReplayed): void {
  try {
    mkdirSync(join(home, DIR), { recursive: true })
    const path = join(home, DIR, FILE)
    appendFileSync(path, `${JSON.stringify(line)}\n`)
    chmodSync(path, 0o600)
  } catch {
    // Evidence is not the work: the answer still goes back to whoever asked.
  }
}

/** The newest reading of each change under today's questions, newest first, at most `last`. */
export function readingsToReplay(
  reviews: readonly Review[],
  opts: { project?: string; last: number },
): Review[] {
  const newest = new Map<string, Review>()
  for (const one of reviews) {
    if (one.rubric !== RUBRIC) continue
    if (opts.project && one.project !== opts.project) continue
    if (!one.base || !one.head) continue
    const had = newest.get(one.unit)
    if (!had || had.at <= one.at) newest.set(one.unit, one)
  }
  return [...newest.values()]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, Math.max(0, opts.last))
}

/** The verdicts people wrote about one reading, as the score reads them. */
function verdictsOf(review: Review): JudgeReplayCase['verdicts'] {
  return Object.fromEntries(Object.entries(review.verdict).map(([q, v]) => [q, v.was]))
}

/** The words the work was asked for in, out of its task file where it still has one. */
async function intentOf(home: string, review: Review): Promise<string> {
  const said: string[] = []
  for (const task of review.tasks) {
    const project = task.split('/')[0] ?? review.project
    const found = await taskFile(
      join(projectDir(home, project), 'tasks', taskFolder(task), 'task.yaml'),
    )
    if (found?.intent) said.push(found.intent)
  }
  return said.join('\n\n')
}

/** Read one recorded change again with the candidate. Throws what stopped it. */
async function readAgain(ctx: ToolContext, asking: Asking, review: Review) {
  const root = allowed(ctx, ctx.project(review.project)).root
  // One agent's own commits where the reading was of one agent's work, read
  // back out of the trailer exactly as the reading was; the range otherwise,
  // whoever's trailers are in it.
  const own = oneAgents(review)
    ? ((await commitsByTask(ctx, root, `${review.base}..${review.head}`)).byTask
        .get(review.tasks[0] ?? '')
        ?.map((one) => one.sha) ?? [])
    : []
  const change = await changesFor(ctx, { root, base: review.base, head: review.head, commits: own })
  if (change.files.length === 0) throw new Error('git no longer has anything in that change')
  const unit = { intent: await intentOf(ctx.home, review), branch: '', tasks: review.tasks }
  return readChange(asking, unit, change, reviewQuestions(), { signal: ctx.signal })
}

/** `jev_replay`: the tool, orchestrator-only, because it spends money. */
export const replayTools: ExtensionTool[] = [
  {
    name: 'jev_replay',
    description:
      'Ask a candidate judge the questions Jev already asked about recorded changes, and count how its answers come out beside the recorded ones and beside the verdicts people wrote — the judge leg of their own eval. Reach for it when they ask to eval, benchmark or compare a judge or a judge model; never on your own, because every change read again is paid for, so it needs the most it may spend, in dollars, in their words. Only readings of today’s questions are read again, newest first. It raises no finding and changes nothing: the result is counts (agreement, what each side raised, confirmed findings it caught and dismissed ones it raised again), with a rate only once there are enough, and it goes on the Evaluations page.',
    parameters: object(
      {
        ceiling_usd: number('the most it may spend, in dollars, as they said it'),
        judge: string('the candidate judge, by its name in Tade; the configured one when unsaid'),
        model: string('the version the candidate answers with, as that judge names one'),
        last: number(
          `how many recorded changes, newest first: ${JUDGE_REPLAY_LAST} unless said, at most ${JUDGE_REPLAY_MOST}`,
        ),
        project,
      },
      ['ceiling_usd'],
    ),
    for: ['orchestrator'],
    run: async (input, ctx) => {
      const ceiling = Number(input.ceiling_usd)
      if (!Number.isFinite(ceiling) || ceiling <= 0) {
        throw new Error(
          'a judge replay is paid for: ask them the most it may spend, and pass it as ceiling_usd',
        )
      }
      const last = Math.min(
        JUDGE_REPLAY_MOST,
        Math.max(1, Math.floor(Number(input.last ?? JUDGE_REPLAY_LAST) || JUDGE_REPLAY_LAST)),
      )
      const named = input.project ? ctx.project(String(input.project)).name : undefined
      const name = input.judge ? String(input.judge) : judgeName(ctx)
      const candidate = makeJudge(name, {
        key: keyOf(ctx),
        ...(typeof ctx.settings.url === 'string' ? { url: ctx.settings.url } : {}),
        ...(input.model
          ? { model: String(input.model) }
          : typeof ctx.settings.model === 'string'
            ? { model: ctx.settings.model }
            : {}),
        fetch: ctx.fetch,
      })
      const unready = candidate.ready()
      if (unready) throw new Error(`${name} cannot answer here: ${unready}`)
      // Whose each was is read back out of its commits, as `jev_findings` reads
      // it: an older reading of a shared branch was filed under every task in
      // the checkout, and asked again under all of their intents joined.
      const readings = await whoseReadings(
        ctx,
        readingsToReplay(readReviews(ctx.home), { ...(named ? { project: named } : {}), last }),
        ctx.signal,
      )
      if (readings.length === 0) {
        throw new Error(
          `nothing has been read under today’s questions${named ? ` in ${named}` : ''}, so there is nothing to ask again`,
        )
      }
      const asking = new Asking(candidate, numberSetting(ctx, 'budget', BUDGET))
      const cases: JudgeReplayCase[] = []
      const unread: { unit: string; why: string }[] = []
      for (const [at, review] of readings.entries()) {
        if (asking.usd >= ceiling) {
          for (const left of readings.slice(at)) {
            unread.push({ unit: left.unit, why: `the $${ceiling.toFixed(2)} ceiling was reached` })
          }
          break
        }
        ctx.progress(`reading ${review.unit} again (${at + 1} of ${readings.length})`)
        try {
          const reading = await readAgain(ctx, asking, review)
          cases.push({
            unit: review.unit,
            recorded: review.answers,
            replayed: reading.answers,
            verdicts: verdictsOf(review),
          })
        } catch (err) {
          if (ctx.signal.aborted) throw err
          const why = err instanceof Error ? err.message : String(err)
          unread.push({ unit: review.unit, why })
          cases.push({
            unit: review.unit,
            recorded: review.answers,
            replayed: null,
            verdicts: verdictsOf(review),
          })
        }
      }
      const threshold = thresholds(ctx).report
      const score = judgeReplayScore(cases, threshold)
      const version = asking.version || candidate.id
      record(ctx.home, {
        at: new Date(ctx.now()).toISOString(),
        judge: name,
        version,
        against: [...new Set(readings.map((one) => one.version))],
        rubric: RUBRIC,
        threshold,
        score,
        cost_usd: asking.usd,
        unread,
      })
      const lines = [
        `${name} (${version}) asked again about ${readings.length} recorded change${readings.length === 1 ? '' : 's'}, at ${threshold}; ${asking.said()} of a $${ceiling.toFixed(2)} ceiling.`,
        ...judgeReplaySays(score, ENOUGH),
        ...unread.map((one) => `Not read: ${one.unit} — ${one.why}.`),
      ]
      return {
        text: lines.join('\n'),
        said: `Agreed on ${score.agreed} of ${score.asked}.`,
        data: { ...score, cost_usd: asking.usd },
      }
    },
  },
]

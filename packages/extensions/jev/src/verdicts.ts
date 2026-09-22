import type { ExtensionTool, ExtensionWatch } from '@tade/extensions-core'
import { object, oneOf, string } from '@tade/extensions-core'
import { allowed, periodMs, project } from './ask.ts'
import {
  citedIn,
  findingKey,
  findingsAbout,
  findingsOf,
  gapSaid,
  keyParts,
  materialFor,
  projectOf,
  sweepFindings,
  sweepOf,
  verdictProblem,
} from './loop.ts'
import { RUBRIC } from './questions.ts'
import { forgetRead, recordOf } from './record.ts'
import { findingsReport, statusLine } from './report.ts'
import { readReviews, recordAccount, recordVerdict } from './reviews.ts'

// Closing the loop, as three tools and a sweep.
//
// `loop.ts` is the rule — who may say what about a finding, and what a verdict
// has to carry. This is where those rules meet a caller, and the three tools
// are here together because they are one subject read three ways: what was
// flagged, what the agent whose change it was makes of it, and what somebody
// else decided. The split from the rest of the extension is the one the
// modularity budget asked for; what they all share with the tools left behind
// is the project parameter and the project gate, which live in `ask.ts`.

/** What was flagged, what the agent said about it, and what somebody else decided. */
export const loopTools: ExtensionTool[] = [
  {
    name: 'jev_findings',
    description:
      'What the review watch has looked at, what it flagged, what came of it, and whether it was right: this week, by question, how many findings are still waiting on a verdict, and a calibration table. It asks the judge nothing and costs nothing. Use it for "what did the overnight review turn up", to decide which questions are worth keeping, and — as an agent — to read what was flagged about your own change, which is what you answer with jev_account.',
    parameters: object({ project, task: string('only findings about this task') }, []),
    for: ['orchestrator', 'agent'],
    run: async (input, ctx) => {
      const named = input.project ? String(input.project) : null
      if (named) ctx.project(named)
      const record = await recordOf(ctx)
      // An agent asking is asking about its own work unless it says
      // otherwise: that is the whole of how a finding reaches the agent
      // whose task it is, and it is a pull because nothing in the port can
      // push a sentence into a conversation already going.
      const mine = ctx.caller.kind === 'agent' ? ctx.caller.task : null
      const task = input.task ? String(input.task) : mine
      if (mine !== null) {
        const about = findingsAbout(findingsOf(record.reviews), task ?? mine)
        return {
          text: materialFor(findingsOf(record.reviews), task ?? mine, ctx.now()),
          said:
            gapSaid(about, ctx.now()) ??
            (about.length === 0
              ? 'Nothing flagged.'
              : `${about.length} flagged, all of them answered.`),
          data: { findings: about.length },
        }
      }
      const about = {
        ...(named ? { project: named } : {}),
        ...(task ? { task } : {}),
      }
      return {
        text: findingsReport(record, about),
        said: statusLine(record).text,
        data: { findings: record.findings.length, reviews: record.reviews.length },
      }
    },
  },
  {
    name: 'jev_account',
    description:
      'Say what you found when you read something Jev flagged about your own change: that you fixed it, or that it is not real and why, in a sentence somebody can read. This is your account of it and not a verdict — whether the rubric was right about your work is written down by the orchestrator or by a person, because you are the one being measured by it. Record it while you still remember why the code is the way it is: a finding nobody accounts for outlives its agent and has to be picked over by somebody who was never there.',
    parameters: object(
      {
        finding: string('the finding, as jev_findings lists it: <change>:<question>'),
        did: oneOf(
          ['fixed', 'not real'],
          'what you did about it: fixed the cause, or found nothing to fix',
        ),
        said: string('why, in a sentence somebody who was not here can read'),
        project,
      },
      ['finding', 'did', 'said'],
    ),
    for: ['orchestrator', 'agent'],
    run: async (input, ctx) => {
      const { unit, question } = keyParts(String(input.finding))
      const did = String(input.did) === 'fixed' ? 'fixed' : 'not real'
      const said = String(input.said ?? '').trim()
      if (!said) throw new Error('say what you found, in a sentence somebody else can read')
      if (!readReviews(ctx.home).some((review) => review.unit === unit))
        throw new Error(`nothing was read about ${unit}, so there is no finding to account for`)
      recordAccount(ctx.home, {
        project: input.project ? String(input.project) : projectOf(unit),
        unit,
        question,
        account: {
          did,
          by: ctx.caller.kind === 'agent' ? ctx.caller.task : ctx.caller.kind,
          said,
          at: new Date(ctx.now()).toISOString(),
          rubric: RUBRIC,
        },
      })
      forgetRead()
      return {
        text: `Written down: you say ${unit}:${question} is ${did === 'fixed' ? 'fixed' : 'not real'}. That is your account of it, not a verdict — somebody else writes down whether the finding was right, and the sweep will put it in front of them.`,
        said: `Accounted for ${question}.`,
      }
    },
  },
  {
    name: 'jev_verdict',
    description:
      'Write down what a finding turned out to be, once you have read the change yourself: confirmed, or a false positive, and what in the diff decided it — a file, a line in one, or the code itself in backticks. This is the half of the record the judge cannot give, and without it there is no way to say whether any of this was worth running. It is never an agent’s to give about its own work, and nothing becomes a false positive by getting old: a finding nobody answers stays unanswered.',
    parameters: object(
      {
        finding: string('the finding, as jev_findings lists it: <change>:<question>'),
        was: oneOf(['confirmed', 'false positive'], 'what it turned out to be'),
        said: string('what in the change decided it, in a sentence naming what you read'),
        project,
      },
      ['finding', 'was', 'said'],
    ),
    // The one line that holds this whole loop up. An agent may say what it
    // found (jev_account); it may not mark its own work a false positive,
    // any more than an agent judged by the caution reading gets to answer
    // it. The host refuses it before this runs — the check below is here so
    // that stays true if anybody ever widens the audience.
    for: ['orchestrator'],
    run: async (input, ctx) => {
      if (ctx.caller.kind === 'agent') {
        throw new Error(
          'a verdict on a finding is not an agent’s to give: it is about your own change, and the calibration it feeds must not be fed by what is being measured. Say what you found with jev_account instead; the orchestrator or a person writes the verdict.',
        )
      }
      const { unit, question } = keyParts(String(input.finding))
      const was = String(input.was) === 'confirmed' ? 'confirmed' : 'false positive'
      const said = String(input.said ?? '').trim()
      const reviews = readReviews(ctx.home)
      const one = findingsOf(reviews).find((finding) => finding.key === findingKey(unit, question))
      if (!one) {
        throw new Error(
          reviews.some((review) => review.unit === unit)
            ? `${question} was never raised about ${unit}, so there is no finding to answer: jev_findings lists the ones there are`
            : `nothing was read about ${unit}, so there is no finding to answer`,
        )
      }
      const problem = verdictProblem(said, one)
      if (problem) throw new Error(problem)
      recordVerdict(ctx.home, {
        project: input.project ? String(input.project) : projectOf(unit),
        unit,
        question,
        verdict: {
          was,
          by: ctx.caller.kind,
          said,
          at: new Date(ctx.now()).toISOString(),
          cited: citedIn(said) ?? '',
          rubric: RUBRIC,
        },
      })
      forgetRead()
      return {
        text: [
          `Written down: ${unit}:${question} was ${was}, citing ${citedIn(said)}.`,
          one.rubric && one.rubric !== RUBRIC
            ? `It was flagged under questions ${one.rubric} and answered under ${RUBRIC}, which the record keeps: the question has been reworded since.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        said: `${question} was ${was}.`,
      }
    },
  },
]

/**
 * The sweep: what nobody has answered, put in front of somebody who can.
 *
 * It only ever asks. Nothing it finds starts work, closes a finding or ages
 * one into a false positive — what to do about a finding is a decision, and a
 * decision is a person's or the orchestrator's.
 */
export const verdictsWatch: ExtensionWatch = {
  id: 'verdicts',
  title: 'Findings nobody has answered',
  means:
    'looks for findings an agent has accounted for and nobody has judged, and ones whose agent is gone',
  every: '1h',
  // Nothing to start: what to do about a finding is a decision, and a
  // decision is a person's or the orchestrator's. This asks; it never
  // answers, and no finding here becomes a false positive by getting old.
  offers: 'ask',
  input: object({
    after: string('how long an agent gets to answer for its own change first; 1h unless said'),
  }),
  check: async (ctx) => {
    const found = allowed(ctx, ctx.watching)
    const record = await recordOf(ctx)
    // A window says which agents are still there; without one, the
    // journal's `task_done` is all that may be concluded from — an agent
    // is not gone because nobody is looking.
    const agents = ctx.tade?.agents() ?? null
    const running = new Set((agents ?? []).map((agent) => agent.task))
    const sweep = sweepOf(
      findingsOf(record.reviews).filter((one) => one.project === found.name),
      {
        now: ctx.now(),
        after: periodMs(ctx.input.after ?? '1h', 3_600_000),
        gone: (one) =>
          one.tasks.length === 0 ||
          one.tasks.every(
            (task) => record.finished.has(task) || (agents !== null && !running.has(task)),
          ),
      },
    )
    return { found: sweepFindings(sweep, ctx.now()) }
  },
}

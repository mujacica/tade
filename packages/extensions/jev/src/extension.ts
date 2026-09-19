import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { watchedFrom } from '@tade/core'
import {
  type BriefItem,
  type ExtensionContext,
  type Finding,
  list,
  number,
  object,
  oneOf,
  type ProjectRef,
  string,
  type TadeExtension,
  type ToolContext,
} from '@tade/extensions-core'
import type { Question } from '@tade/judges-core'
import { readJournal } from '@tade/workbench/events'
import { readSchedules } from '@tade/workbench/schedules'
import { Asking, allowed, judgeName, readyProblem, thresholds } from './ask.ts'
import { changesIn, unitFor, unitsIn } from './changes.ts'
import {
  agentQuestions,
  numbered,
  pairQuestions,
  QUEUE_ASKS,
  QUEUE_WEIGHTS,
  REQUEST_QUESTIONS,
  reviewQuestions,
  SETTLE,
  titleOf,
} from './questions.ts'
import {
  answersTable,
  describe,
  type Found,
  findingsReport,
  type Look,
  type ReviewRecord,
  statusLine,
} from './report.ts'
import { findingsIn, raisedIn, readChange, reviewLine, shorten, stageTwoPrompt } from './review.ts'
import { readReviews, recordReview, recordVerdict } from './reviews.ts'

// Jev: a judge that answers bounded questions about things nobody has time to
// read — every diff an agent writes, a thousand lines of log, a plan before
// two agents start in the same checkout — with a number and no paragraph.
//
// Four rules hold everything here together, and they are worth knowing before
// reading any of it:
//
//   · It may only ever ADD caution. It never approves, closes, merges,
//     unholds, shortens a review or skips a check. A diff is text somebody
//     else wrote and this model does not treat what it reads as hostile, so
//     the worst case of an integration that can only nag is being annoying.
//   · It advises; it never decides. What starts out of the queue stays the
//     window's rule over written facts, a plan is still `checkPlan`'s to
//     refuse, and an order exists because a person or the orchestrator wrote
//     it down with a reason of their own.
//   · Nothing here writes to a project. Where something should be fixed, that
//     is an agent, with what was found in its context file.
//   · With no key none of it runs, and Tade does exactly what it does today.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const project = string('project name, as configured; the one you are in when there is only one')

/**
 * The last record read, and when. The status bar asks every few seconds
 * whether anybody is looking or not, and reading the whole journal on that
 * beat is exactly what makes a window heavy: what is polled is cheap and
 * shared, so one read serves everybody for a moment.
 */
let lastRead: { home: string; at: number; record: ReviewRecord } | null = null

/** What was read a moment ago is no longer what happened: read it again. */
function forgetRead(): void {
  lastRead = null
}

/** What the record says, read from the journal and the review log. Asks nobody anything. */
async function recordOf(ctx: ExtensionContext, keepMs = 0): Promise<ReviewRecord> {
  const fresh = lastRead
  if (keepMs > 0 && fresh && fresh.home === ctx.home && ctx.now() - fresh.at <= keepMs) {
    return { ...fresh.record, now: ctx.now() }
  }
  const events = await readJournal(ctx.home, {
    types: ['watch_checked', 'watch_found', 'task_done'],
  }).catch(() => [])
  const looks: Look[] = []
  const findings: Found[] = []
  let schedules: ReturnType<typeof readSchedules> = []
  try {
    schedules = readSchedules(ctx.home)
  } catch {
    // No schedules file is the normal case, not an error.
  }
  for (const schedule of schedules) {
    if (schedule.does.kind !== 'watch' || !schedule.does.watch.startsWith(`${ctx.extension}.`)) {
      continue
    }
    const watched = watchedFrom(events, schedule.id)
    looks.push(...watched.looks)
    findings.push(...watched.findings)
  }
  const finished = new Set(
    events.filter((event) => event.type === 'task_done' && event.task).map((event) => event.task!),
  )
  const record: ReviewRecord = {
    reviews: readReviews(ctx.home),
    looks,
    findings,
    finished,
    now: ctx.now(),
  }
  lastRead = { home: ctx.home, at: ctx.now(), record }
  return record
}

/** A question as a caller wrote it, in the port's words. Throws at anything it cannot read. */
function questionsFrom(raw: unknown): Question[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('ask at least one question')
  return raw.map((one, index) => {
    const asked = (one ?? {}) as Record<string, unknown>
    const id = String(asked.id ?? `question_${index + 1}`)
    const ask = String(asked.ask ?? '')
    const kind = String(asked.kind ?? 'yes-no')
    if (!ask.trim()) throw new Error(`${id} does not say what it asks`)
    if (kind === 'yes-no') return { id, kind: 'yes-no', ask } satisfies Question
    if (kind === 'pick') {
      const given = asked.options
      const options = Array.isArray(given)
        ? Object.fromEntries(given.map((option) => [String(option), null]))
        : given && typeof given === 'object'
          ? Object.fromEntries(
              Object.entries(given as Record<string, unknown>).map(([option, means]) => [
                option,
                means === null || means === undefined ? null : String(means),
              ]),
            )
          : {}
      return { id, kind: 'pick', ask, options } satisfies Question
    }
    if (kind === 'rate') {
      const levels = Array.isArray(asked.levels) ? asked.levels.map(String) : []
      return { id, kind: 'rate', ask, levels } satisfies Question
    }
    throw new Error(`${id} is a ${kind} question, and there are only yes-no, pick and rate`)
  })
}

/** How far back something goes, as it is said: `24h`, `7d`, `30m`. */
function periodMs(said: unknown, fallback: number): number {
  const match = /^(\d+)\s*([mhdw])$/.exec(String(said ?? '').trim())
  if (!match) return fallback
  const size = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] ?? 'h'] ?? 0
  return Number(match[1]) * size
}

/** Where a tool works: an agent's own worktree, or a project's checkout. */
function where(
  input: Record<string, unknown>,
  ctx: ToolContext,
): { project: ProjectRef; root: string } {
  if (ctx.caller.kind === 'agent' && !input.project) {
    const caller = ctx.caller
    const known = ctx.projects.find((one) => one.name === caller.project)
    const project = known ?? { name: caller.project, root: caller.cwd }
    return { project: allowed(ctx, project), root: caller.cwd }
  }
  const found = allowed(ctx, ctx.project(input.project ? String(input.project) : null))
  return { project: found, root: found.root }
}

/** The lines a grep reads, and what to call them in the answer. */
async function linesFor(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ what: string; lines: string[] }> {
  const source = String(input.source ?? 'text')
  const limit = Number(input.limit) > 0 ? Math.min(2_000, Number(input.limit)) : 200
  if (source === 'text') {
    const text = typeof input.text === 'string' ? input.text : ''
    if (text.trim() === '') throw new Error('text is needed for a grep over text: paste it in')
    return { what: 'what you gave it', lines: text.split('\n').slice(-limit) }
  }
  if (source === 'journal') {
    const since = ctx.now() - periodMs(input.period, 24 * 3_600_000)
    const events = await readJournal(ctx.home, {
      ...(input.task ? { task: String(input.task) } : {}),
    })
    const lines = events
      .filter((event) => Date.parse(event.ts) >= since)
      .slice(-limit)
      .map(
        (event) =>
          `${event.ts} ${event.type} ${event.task ?? ''} ${JSON.stringify(event.detail).slice(0, 300)}`,
      )
    return { what: `the journal${input.task ? ` for ${String(input.task)}` : ''}`, lines }
  }
  if (source === 'file') {
    const said = String(input.file ?? '')
    if (!said) throw new Error('file is needed for a grep over a file: say which')
    const { root } = where(input, ctx)
    const path = isAbsolute(said) ? said : resolve(root, said)
    // Never a path outside a project Tade knows, however it was asked for: a
    // model asking is not a reason to read somebody's home directory.
    const inside = ctx.projects.some((one) => {
      const step = relative(one.root, path)
      return step === '' || (!step.startsWith('..') && !isAbsolute(step))
    })
    if (!inside) throw new Error(`${said} is not inside a project Tade knows, so it is not read`)
    const text = await readFile(path, 'utf8').catch(() => {
      throw new Error(`${said} could not be read`)
    })
    return { what: said, lines: text.split('\n').slice(0, limit) }
  }
  throw new Error(`${source} is not somewhere to read from: text, journal, file`)
}

/** A finding's key as a person says it: `<change>:<question>`. */
function keyParts(said: string): { unit: string; question: string } {
  const at = said.lastIndexOf(':')
  if (at <= 0)
    throw new Error(`${said} is not a finding: they look like checkout/add-refunds:test_missing`)
  return { unit: said.slice(0, at), question: said.slice(at + 1) }
}

export const jevExtension: TadeExtension = {
  name: 'jev',
  title: 'Jev',
  description:
    'Asks a judge bounded questions about diffs, logs, requests, plans and queues: probabilities to act on, never verdicts and never prose.',
  root: ROOT,
  settings: [
    {
      key: 'judge',
      kind: 'string',
      means: 'which judge answers: jev (the default), or scripted, which answers from a table',
    },
    {
      key: 'model',
      kind: 'string',
      means:
        'the version that answers; pin one (jev-1.13.0), never an alias — thresholds are tuned against a version',
    },
    {
      key: 'key_env',
      kind: 'string',
      means: 'the environment variable the TypeSafe key is in, when it is not TYPESAFE_API_KEY',
    },
    { key: 'url', kind: 'string', means: 'the TypeSafe to ask, when it is not api.typesafe.ai' },
    {
      key: 'report',
      kind: 'number',
      means: 'the probability a question has to reach to be worth saying at all (0.6)',
    },
    {
      key: 'act',
      kind: 'number',
      means:
        'the probability at which a finding is worth starting work on rather than filing (0.85)',
    },
    {
      key: 'budget',
      kind: 'number',
      means: 'the most requests one look or tool call may make (200)',
    },
    {
      key: 'projects',
      kind: 'list',
      means:
        'the projects it may read; nothing is sent from a project not named here (all of them unless set)',
    },
    {
      key: 'brief',
      kind: 'boolean',
      means: 'mention what it flagged in the brief (true unless set false)',
    },
  ],
  // Never the network, and never a guess: the judge itself says what it needs.
  ready: (ctx) => readyProblem(ctx),
  tools: [
    {
      name: 'jev_ask',
      description:
        'Judge anything against questions you write: a diff, a list of issues, a paragraph somebody pasted, what another tool just returned. Each question is answered independently with a probability (yes-no), an option you declared (pick), or a level you declared (rate) — never an explanation. Ask a few dozen at once; they cost almost nothing together. Keep every question literal and about one thing: this model reads instructions as written, cannot count, cannot do arithmetic, cannot compare dates, and can be steered by text that argues with it. Do the arithmetic yourself and put the numbers in the state.',
      parameters: object(
        {
          state: {
            description:
              'what to judge: text, or records as an object or a list. Structure beats prose, and bulk the questions do not need costs accuracy.',
          },
          questions: list(
            object(
              {
                id: string(
                  'a short name, lowercase with underscores: what the answer comes back under',
                ),
                kind: oneOf(['yes-no', 'pick', 'rate'], 'yes-no unless said'),
                ask: string('the question, literally, about one thing'),
                options: {
                  description:
                    'for pick: the options, as a list of names or a map of name to what it covers',
                },
                levels: list(string('a level'), 'for rate: the levels in order, least to most'),
              },
              ['id', 'ask'],
            ),
            'the questions, all answered against the same state',
          ),
        },
        ['state', 'questions'],
      ),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const questions = questionsFrom(input.questions)
        const asking = Asking.from(ctx)
        const judged = await asking.askAll(input.state, questions, ctx.signal)
        return {
          text: answersTable(judged, thresholds(ctx)),
          said: `Asked ${questions.length} question${questions.length === 1 ? '' : 's'} of ${judged.version}.`,
          data: judged.answers,
        }
      },
    },
    {
      name: 'jev_grep',
      description:
        'Grep that reads: give it a question in plain words and it says which lines answer it, likeliest first. Use it over text another tool returned (source text — paste it in), over the journal, or over a file in a project. It is a filter, not an answer: read the lines it hands back. Nothing found is an answer too.',
      parameters: object(
        {
          question: string('what you are looking for, in plain words — not a pattern'),
          source: oneOf(['text', 'journal', 'file'], 'where to read; text unless said'),
          text: string('for source text: the lines to read'),
          file: string('for source file: a path inside a project Tade knows'),
          project,
          task: string('for source journal: only this task'),
          period: string('for source journal: how far back — 1h, 24h, 7d'),
          limit: number('how many lines to read; 200 unless said'),
          keep: number('the probability a line has to reach to be kept; 0.6 unless said'),
        },
        ['question'],
      ),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const question = String(input.question ?? '').trim()
        if (!question) throw new Error('say what you are looking for, in plain words')
        const { what, lines } = await linesFor(input, ctx)
        const keep = typeof input.keep === 'number' ? input.keep : thresholds(ctx).report
        const asking = Asking.from(ctx)
        const wanted = lines
          .map((line, index) => ({ index, line }))
          .filter((one) => one.line.trim() !== '')
        if (wanted.length === 0)
          return { text: `Nothing to read in ${what}.`, said: 'Nothing to read.' }
        const found: { line: string; probability: number }[] = []
        const per = Math.max(1, Math.floor(asking.judge.capabilities.questionsPerAsk / 2))
        for (let at = 0; at < wanted.length; at += per) {
          const batch = wanted.slice(at, at + per)
          ctx.progress(`reading lines ${at + 1}–${at + batch.length} of ${wanted.length}`)
          const questions: Question[] = batch.map((one) => ({
            id: numbered('line', one.index),
            kind: 'yes-no',
            ask: `About this line only — "${shorten(one.line.trim(), 300)}" — ${question}`,
          }))
          const judged = await asking.askAll(
            // The lines again as context, cut to the same length as the
            // questions: a state that runs over its budget is refused, and a
            // log with one enormous line in it is not a reason to refuse.
            { looking_for: question, lines: batch.map((one) => shorten(one.line.trim(), 300)) },
            questions,
            ctx.signal,
          )
          for (const one of batch) {
            const answer = judged.answers[numbered('line', one.index)]
            if (answer?.kind !== 'yes-no') continue
            if (answer.probability >= keep)
              found.push({ line: one.line, probability: answer.probability })
          }
        }
        found.sort((a, b) => b.probability - a.probability)
        const text =
          found.length === 0
            ? `Nothing in ${what} answered "${question}" at ${keep} or above (${wanted.length} lines read, ${asking.said()}).`
            : [
                `${found.length} of ${wanted.length} lines in ${what} answer "${question}" (${asking.said()}):`,
                '',
                ...found
                  .slice(0, 50)
                  .map((one) => `- \`${one.probability.toFixed(2)}\` ${one.line.trim()}`),
              ].join('\n')
        return {
          text,
          said: `${found.length} of ${wanted.length} lines answer that.`,
          data: found,
        }
      },
    },
    {
      name: 'jev_review',
      description:
        "Read a change against the review pack and say what it flags: injection, secrets, permissions, swallowed errors, missing tests, whether it did what was asked, and this repository's own rules. Give it a task to read that task's whole diff against what it branched from — the unit a review is worth having about — or a ref like main..HEAD for exactly that. It gives a probability per question and no explanation, so read the diff before acting on one. Finding nothing is an answer.",
      parameters: object(
        {
          project,
          task: string(
            "a task, to read its whole diff against its base; the agent's own work when it asks",
          ),
          ref: string('or a commit or range, like main..HEAD, when you want exactly that'),
          paths: list(string('a path'), 'only these files'),
          questions: list(
            string('a question id'),
            'only these questions; the whole pack unless said',
          ),
          threshold: number('report at or above this probability; the setting unless said'),
        },
        [],
      ),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const { project: found, root } = where(input, ctx)
        const asked = typeof input.task === 'string' ? input.task : ''
        const unit = asked
          ? ((await unitsIn(ctx, found)).find(
              (one) => one.key === asked || one.tasks.includes(asked),
            ) ?? null)
          : await unitFor(ctx, found, {
              root,
              ref: typeof input.ref === 'string' ? input.ref : null,
            })
        if (!unit)
          throw new Error(`${asked} has no branch in ${found.name} with work on it to read`)
        const paths = Array.isArray(input.paths) ? input.paths.map(String) : []
        const changes = await changesIn(ctx, unit.root, `${unit.base}...${unit.head}`, paths)
        if (changes.length === 0) {
          throw new Error(
            `nothing to read in ${unit.key}: no files a question could be about changed between ${unit.base.slice(0, 8)} and ${unit.head.slice(0, 8)}`,
          )
        }
        const only = Array.isArray(input.questions) ? input.questions.map(String) : null
        const limits = thresholds(ctx)
        const report = typeof input.threshold === 'number' ? input.threshold : limits.report
        const asking = Asking.from(ctx)
        const reading = await readChange(asking, unit, changes, reviewQuestions(only), {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          progress: ctx.progress,
        })
        recordReview(
          ctx.home,
          reviewLine(
            reading,
            unit,
            { requests: asking.requests, usd: asking.usd },
            report,
            ctx.now(),
          ),
        )
        forgetRead()
        const raised = raisedIn(reading, report)
        const rows = Object.entries(reading.answers)
          .sort(([, a], [, b]) => b - a)
          .map(
            ([id, probability]) =>
              `| ${id} | ${probability.toFixed(2)} | ${reading.where[id] ?? ''} | ${probability >= limits.act ? 'worth acting on' : probability >= report ? 'reported' : ''} |`,
          )
        return {
          text: [
            `**${unit.key}** — ${changes.length} file(s), ${unit.base.slice(0, 8)}…${unit.head.slice(0, 8)}, answered by ${reading.version} (${asking.said()})`,
            reading.severity
              ? `How bad it would be to ship as it stands: ${reading.severity}.`
              : '',
            '',
            '| question | probability | where | |',
            '| --- | --- | --- | --- |',
            ...rows,
            '',
            raised.length === 0
              ? 'Nothing cleared the threshold. That is an answer, not a pass: it reads the question as written and cannot say why.'
              : `Read ${raised.map((id) => `**${id}** (${titleOf(id)})`).join(', ')} in the diff yourself before acting, and say which it was with jev_verdict.`,
          ]
            .filter((line) => line !== '')
            .join('\n'),
          said:
            raised.length === 0
              ? `Read ${unit.key}: nothing flagged.`
              : `Read ${unit.key}: ${raised.length} flagged.`,
          data: { unit: unit.key, answers: reading.answers, raised },
        }
      },
    },
    {
      name: 'jev_findings',
      description:
        'What the review watch has looked at, what it flagged, what came of it, and whether it was right: this week, by question, and a calibration table. It asks the judge nothing and costs nothing. Use it for "what did the overnight review turn up" and to decide which questions are worth keeping.',
      parameters: object({ project, task: string('only findings about this task') }, []),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const named = input.project ? String(input.project) : null
        if (named) ctx.project(named)
        const record = await recordOf(ctx)
        const about = {
          ...(named ? { project: named } : {}),
          ...(input.task ? { task: String(input.task) } : {}),
        }
        return {
          text: findingsReport(record, about),
          said: statusLine(record).text,
          data: { findings: record.findings.length, reviews: record.reviews.length },
        }
      },
    },
    {
      name: 'jev_verdict',
      description:
        'Write down what a finding turned out to be, once somebody has read the change: confirmed, or a false positive, and why in your own words. This is the half of the record the judge cannot give — without it there is no way to say whether any of this was worth running, and a question that is always wrong cannot be found and deleted.',
      parameters: object(
        {
          finding: string('the finding, as jev_findings lists it: <change>:<question>'),
          was: oneOf(['confirmed', 'false positive'], 'what it turned out to be'),
          said: string('why, in a sentence somebody can read'),
          project,
        },
        ['finding', 'was'],
      ),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const { unit, question } = keyParts(String(input.finding))
        const was = String(input.was) === 'confirmed' ? 'confirmed' : 'false positive'
        const known = readReviews(ctx.home).some((review) => review.unit === unit)
        if (!known)
          throw new Error(`nothing was read about ${unit}, so there is no finding to answer`)
        recordVerdict(ctx.home, {
          project: input.project
            ? String(input.project)
            : (unit.split(':')[0]?.split('/')[0] ?? ''),
          unit,
          question,
          verdict: {
            was,
            by: ctx.caller.kind === 'agent' ? ctx.caller.task : ctx.caller.kind,
            said: String(input.said ?? ''),
            at: new Date(ctx.now()).toISOString(),
          },
        })
        forgetRead()
        return {
          text: `Written down: ${unit}:${question} was ${was}.`,
          said: `${question} was ${was}.`,
        }
      },
    },
    {
      name: 'jev_read_request',
      description:
        'A second, independent reading of what somebody just asked for, before you commit to a route: what shape the request is, whether it could mean two things, whether something needed to start is missing, whether it is about work already running. It is a cheap classifier with no explanation and it is often wrong — their words are what counts, and this is worth asking when you are about to guess. Where it disagrees with you, ask them rather than picking a side.',
      parameters: object(
        {
          said: string('what they said, word for word'),
          projects: list(string('a project name'), 'the projects this machine has'),
          running: list(string('task: what it is doing'), 'agents already working, and on what'),
          queued: list(string('task: what it waits on'), 'work already queued'),
        },
        ['said'],
      ),
      for: ['orchestrator'],
      run: async (input, ctx) => {
        const words = String(input.said ?? '').trim()
        if (!words) throw new Error('say what they said, word for word')
        const asking = Asking.from(ctx)
        const judged = await asking.askAll(
          {
            said: words,
            projects: Array.isArray(input.projects)
              ? input.projects.map(String)
              : ctx.projects.map((one) => one.name),
            agents_working: Array.isArray(input.running) ? input.running.map(String) : [],
            queued: Array.isArray(input.queued) ? input.queued.map(String) : [],
          },
          REQUEST_QUESTIONS,
          ctx.signal,
        )
        const limits = thresholds(ctx)
        const worth = Object.entries(judged.answers).filter(
          ([, answer]) => answer.kind !== 'yes-no' || answer.probability >= limits.report,
        )
        return {
          text: [
            answersTable(judged, limits),
            '',
            worth.length === 0
              ? 'Nothing stood out. Read their words, not this.'
              : `What stood out: ${worth.map(([id, answer]) => `${id} ${describe(answer)}`).join(', ')}. It is a reading, not a decision: you choose the route, and where it looks ambiguous, ask.`,
          ].join('\n'),
          said: 'Read the request.',
          data: judged.answers,
        }
      },
    },
    {
      name: 'jev_plan_check',
      description:
        'Read a plan before you keep it, and say which agents would collide: the same files, the same behaviour (an interface and what implements it, a setting and what reads it, a name and everywhere it is used), one job split in two, one that needs another finished first, and which would leave the project’s checks failing until something else lands. It advises only: tade_plan still refuses what cannot be kept, and a wait you add is yours to explain in your own words — "Jev said so" is not a reason anybody can read.',
      parameters: object(
        {
          project,
          agents: list(
            object(
              {
                name: string("the task's name"),
                prompt: string('what its agent would be told'),
                touches: list(string('a path'), 'what it is expected to change'),
                after: list(string('another agent in the plan'), 'what it already waits on'),
              },
              ['name', 'prompt'],
            ),
            'the agents in the plan, as tade_plan would take them',
          ),
        },
        ['agents'],
      ),
      for: ['orchestrator'],
      run: async (input, ctx) => {
        const agents = (Array.isArray(input.agents) ? input.agents : []).map((raw) => {
          const one = (raw ?? {}) as Record<string, unknown>
          return {
            name: String(one.name ?? ''),
            prompt: String(one.prompt ?? ''),
            touches: Array.isArray(one.touches) ? one.touches.map(String) : [],
            after: Array.isArray(one.after) ? one.after.map(String) : [],
          }
        })
        if (agents.length === 0) throw new Error('a plan needs agents: a list of them')
        const found = input.project ? allowed(ctx, ctx.project(String(input.project))) : null
        const asking = Asking.from(ctx)
        const limits = thresholds(ctx)
        const state = {
          project: found?.name ?? '',
          agents: agents.map((one) => ({ name: one.name, will: one.prompt, touches: one.touches })),
        }
        const pairs: { first: string; second: string; concerns: string[] }[] = []
        const couldRunTogether = agents.flatMap((one, index) =>
          agents
            .slice(index + 1)
            .flatMap((other) =>
              one.after.includes(other.name) || other.after.includes(one.name)
                ? []
                : [[one, other] as const],
            ),
        )
        if (couldRunTogether.length > 15) {
          throw new Error(
            `${couldRunTogether.length} pairs of agents could run at the same time, which is more plan than anybody can reason about: split it, and that is the useful answer here`,
          )
        }
        for (const [one, other] of couldRunTogether) {
          ctx.progress(`${one.name} beside ${other.name}`)
          const judged = await asking.askAll(
            state,
            pairQuestions(one.prompt || one.name, other.prompt || other.name),
            ctx.signal,
          )
          const concerns = Object.entries(judged.answers)
            .filter(([, answer]) => answer.kind === 'yes-no' && answer.probability >= limits.report)
            .map(([id, answer]) => `${id} ${describe(answer)}`)
          pairs.push({ first: one.name, second: other.name, concerns })
        }
        const perAgent: { name: string; concerns: string[] }[] = []
        for (const one of agents) {
          const judged = await asking.askAll(
            state,
            agentQuestions(one.prompt || one.name),
            ctx.signal,
          )
          perAgent.push({
            name: one.name,
            concerns: Object.entries(judged.answers)
              .filter(
                ([, answer]) => answer.kind === 'yes-no' && answer.probability >= limits.report,
              )
              .map(([id, answer]) => `${id} ${describe(answer)}`),
          })
        }
        const trouble = pairs.filter((pair) => pair.concerns.length > 0)
        const risky = perAgent.filter((one) => one.concerns.length > 0)
        return {
          text: [
            `Read ${agents.length} agent(s) and ${pairs.length} pair(s) that could run at the same time (${asking.said()}).`,
            '',
            trouble.length === 0
              ? 'No pair stood out.'
              : [
                  '**Pairs:**',
                  ...trouble.map(
                    (pair) => `- ${pair.first} + ${pair.second}: ${pair.concerns.join(', ')}`,
                  ),
                ].join('\n'),
            '',
            risky.length === 0
              ? 'Nothing stood out about any one of them.'
              : [
                  '**Each on its own:**',
                  ...risky.map((one) => `- ${one.name}: ${one.concerns.join(', ')}`),
                ].join('\n'),
            '',
            'Nothing here refuses a plan or adds a wait. If you add one, write why in your own words.',
          ].join('\n'),
          said: `${trouble.length} pair(s) worth looking at.`,
          data: { pairs, agents: perAgent },
        }
      },
    },
    {
      name: 'jev_queue_order',
      description:
        'Suggest what should come first out of what is queued, and why for each. It only reorders work that is already ready: it can never jump a wait, unhold a hold, resume a pause or start anything. What can be counted — how many things wait on this one, how long it has waited — is counted here rather than judged. When somebody asked you to sort the queue, write the order with tade_queue_change (change: order); otherwise say what you would do and let them choose.',
      parameters: object(
        {
          project,
          items: list(
            object(
              {
                task: string('the queued task, like checkout/add-refunds'),
                about: string('what it is, in its own words'),
                after: list(string('a task'), 'what it waits on'),
                waiting_since: string('when it was queued, as an ISO time'),
              },
              ['task', 'about'],
            ),
            'the queued work to put in an order',
          ),
          running: list(
            string('task: what it is doing'),
            'what is already going, which ordering has to live beside',
          ),
        },
        ['items'],
      ),
      for: ['orchestrator'],
      run: async (input, ctx) => {
        const items = (Array.isArray(input.items) ? input.items : []).map((raw) => {
          const one = (raw ?? {}) as Record<string, unknown>
          return {
            task: String(one.task ?? ''),
            about: String(one.about ?? ''),
            after: Array.isArray(one.after) ? one.after.map(String) : [],
            since: Date.parse(String(one.waiting_since ?? '')),
          }
        })
        if (items.length === 0) throw new Error('there is nothing queued to put in an order')
        // Counted, never asked: a judge cannot count, and these are arithmetic.
        const waitingOn = new Map<string, number>()
        for (const one of items) {
          for (const dep of one.after) waitingOn.set(dep, (waitingOn.get(dep) ?? 0) + 1)
        }
        const asking = Asking.from(ctx)
        const state = {
          queued: items.map((one) => ({ task: one.task, about: one.about, waits_on: one.after })),
          already_going: Array.isArray(input.running) ? input.running.map(String) : [],
        }
        const questions: Question[] = items.flatMap((one, index) =>
          QUEUE_ASKS.map((asked) => ({
            id: numbered(asked.id, index),
            kind: 'yes-no' as const,
            ask: asked.ask(`"${one.about}"`),
          })),
        )
        const judged = await asking.askAll(state, questions, ctx.signal)
        const limits = thresholds(ctx)
        const scored = items.map((one, index) => {
          const reasons: string[] = []
          let score = 0
          for (const asked of QUEUE_ASKS) {
            const answer = judged.answers[numbered(asked.id, index)]
            if (answer?.kind !== 'yes-no') continue
            score += (QUEUE_WEIGHTS[asked.id] ?? 0) * answer.probability
            if (answer.probability >= limits.report) {
              reasons.push(`${asked.about} (${answer.probability.toFixed(2)})`)
            }
          }
          const waiting = waitingOn.get(one.task) ?? 0
          score += waiting
          if (waiting > 0) reasons.push(`${waiting} waiting on it`)
          const hours = Number.isFinite(one.since) ? (ctx.now() - one.since) / 3_600_000 : 0
          if (hours >= 24) reasons.push(`queued ${Math.floor(hours / 24)}d ago`)
          score += Math.min(2, hours / 24)
          return { task: one.task, score, reasons }
        })
        scored.sort((a, b) => b.score - a.score)
        return {
          text: [
            `A suggested order for ${items.length} piece(s) of queued work (${asking.said()}):`,
            '',
            ...scored.map(
              (one, place) =>
                `${place + 1}. **${one.task}** — ${one.reasons.length > 0 ? one.reasons.join('; ') : 'nothing stood out'}`,
            ),
            '',
            'It is a suggestion about work that is already ready. Say why in your own words when you write it down, and it only ever changes what goes first, never what may go at all.',
          ].join('\n'),
          said: `I would do ${scored[0]?.task ?? 'nothing'} first.`,
          data: { order: scored.map((one) => one.task), scored },
        }
      },
    },
  ],
  actions: [
    {
      id: 'flagged',
      title: 'What Jev flagged',
      tool: 'jev_findings',
      project: true,
      heard: [/^what did jev (find|flag)/i, /^what has jev (found|flagged)/i],
    },
    {
      id: 'review',
      title: 'Review the latest commits',
      tool: 'jev_review',
      input: { ref: 'HEAD~5..HEAD' },
      project: true,
      heard: [/^(review|check) (the )?(last|latest) commits?$/i],
    },
  ],
  watches: [
    {
      id: 'review',
      title: 'Review what agents change',
      means:
        'When an agent’s branch stops moving, reads its whole diff against what it branched from — injection, secrets, permissions, swallowed errors, missing tests, whether it did what was asked, and this repository’s own rules — and reports what it flags, for somebody who can explain it to read. It never blocks a commit, approves one, or closes anything.',
      every: '10m',
      input: object({
        threshold: number('report at or above this probability; the setting unless said'),
        questions: list(
          string('a question id'),
          'only these questions; the whole pack unless said',
        ),
        settle: string(
          'how long a branch has to have been still before it is read; 10m unless said',
        ),
        include: list(string('a task or branch'), 'only these changes'),
        exclude: list(string('a task or branch'), 'never these changes'),
      }),
      check: async (ctx) => {
        const found = allowed(ctx, ctx.watching)
        const limits = thresholds(ctx)
        const report = typeof ctx.input.threshold === 'number' ? ctx.input.threshold : limits.report
        const settle = periodMs(ctx.input.settle ?? SETTLE, 10 * 60_000)
        const only = Array.isArray(ctx.input.questions) ? ctx.input.questions.map(String) : null
        const include = Array.isArray(ctx.input.include) ? ctx.input.include.map(String) : []
        const exclude = Array.isArray(ctx.input.exclude) ? ctx.input.exclude.map(String) : []
        // Where the last look left off: the head of each change it read. Most
        // looks end here, having run `git worktree list` and nothing else.
        let read: Record<string, string> = {}
        try {
          read = ctx.since ? (JSON.parse(ctx.since) as Record<string, string>) : {}
        } catch {
          read = {}
        }
        const units = await unitsIn(ctx, found)
        const still = units.filter(
          (unit) =>
            read[unit.key] !== unit.head &&
            ctx.now() - unit.at >= settle &&
            (include.length === 0 || include.includes(unit.key) || include.includes(unit.branch)) &&
            !exclude.includes(unit.key) &&
            !exclude.includes(unit.branch),
        )
        const since = { ...read }
        const findings: Finding[] = []
        // One budget for the whole look, so a rebase storm cannot turn into a
        // bill nobody asked for: what it has already spent is what the next
        // change is measured against.
        const asking = Asking.from(ctx)
        for (const unit of still) {
          const changes = await changesIn(ctx, unit.root, `${unit.base}...${unit.head}`)
          since[unit.key] = unit.head
          if (changes.length === 0) continue
          const before = { requests: asking.requests, usd: asking.usd }
          const reading = await readChange(asking, unit, changes, reviewQuestions(only), {
            signal: ctx.signal,
          })
          recordReview(
            ctx.home,
            reviewLine(
              reading,
              unit,
              { requests: asking.requests - before.requests, usd: asking.usd - before.usd },
              report,
              ctx.now(),
            ),
          )
          findings.push(...findingsIn(reading, unit, { ...limits, report }))
        }
        if (findings.length > 0 || still.length > 0) forgetRead()
        // Unchanged when nothing moved, so a quiet hour does not move the cursor.
        return { found: findings, since: JSON.stringify(since) }
      },
      agent: (finding) => ({
        title: `look at ${finding.key.replace(':', ' ')}`,
        prompt: stageTwoPrompt(finding),
        context: finding.detail ?? finding.title,
      }),
    },
  ],
  brief: async (ctx) => {
    if (ctx.settings.brief === false) return []
    const record = await recordOf(ctx)
    const since = ctx.now() - 24 * 3_600_000
    const read = record.reviews.filter((review) => Date.parse(review.at) >= since)
    const flagged = read.reduce((sum, review) => sum + review.raised.length, 0)
    const trouble = record.looks.filter((look) => look.problem && look.at >= since)
    if (read.length === 0 && trouble.length === 0) return []
    const items: BriefItem[] = [
      {
        said: `Jev read ${read.length} change${read.length === 1 ? '' : 's'} and flagged ${flagged}`,
        // An invitation rather than an interruption: what it flagged lands in
        // the morning as one line, with something to ask about it.
        ...(flagged > 0
          ? {
              ask: 'Tell me which of the things Jev flagged are worth fixing, and which were wrong',
            }
          : {}),
      },
    ]
    // A watch that cannot look must never be silent about it.
    if (trouble[0]?.problem) {
      items.push({ said: `Jev could not look ${trouble.length} time(s): ${trouble[0].problem}` })
    }
    return items
  },
  orchestrator: (ctx) => {
    const judge = judgeName(ctx)
    return [
      `A judge (${judge}) that answers bounded questions with probabilities and no explanations.`,
      'jev_ask judges anything against questions you write — an issue list from sentry_issues, advisories from deps_check, failing tests, something somebody pasted: ask a handful of questions, rank the answers with a weighted sum you can show, and say which you would do first and why.',
      'jev_grep finds the lines that answer a question, in text another tool returned (tade_terminal_read, tade_logs), in the journal, or in a file.',
      'jev_review reads a task’s whole diff, or a range, against the review pack; jev_findings says what the watch turned up and whether it was right, and costs nothing.',
      'jev_read_request gives a second reading of what somebody asked for when you are about to guess between two routes; jev_plan_check reads a plan before you keep it; jev_queue_order suggests what to do first out of what is queued.',
      'Never treat a probability as a verdict and never read one out as a reason: it cannot say why, and a diff or a log can be written to steer it. Say what you think, in your own words.',
      'It may only ever add caution: it never approves, closes, merges, unholds or shortens anything, and nothing waits on it.',
      'What the jev.review watch finds is reported to you as a question and a number, never a verdict: read the flagged diff yourself, say in your own words what is wrong or that it was a false positive, and record which with jev_verdict — nothing else can say whether the rubric is worth running.',
      'Only then make work of it, and when the fix should wait for the agent whose code it is, queue it with tade_plan after that task, with the reason in your own words.',
      'To have changes read as agents finish them, turn on the watch jev.review with tade_schedule, when asked to.',
    ].join(' ')
  },
  agents: () =>
    [
      'Jev answers bounded questions about text with a probability and no explanation.',
      'jev_review reads your own diff against the review pack before you say you are finished — injection, secrets, permissions, swallowed errors, missing tests, whether you did what was asked.',
      'jev_ask judges anything against questions you write, and jev_grep finds the lines in a log or a file that answer a question.',
      'Write every question literally and about one thing: it reads instructions as written, cannot count, cannot do arithmetic and cannot compare dates, so do the arithmetic yourself and put the numbers in what you give it.',
      'A probability is not a verdict and it is never a reason to skip a check: what it flags, you read.',
    ].join(' '),
  setup: (ctx) => ({
    guide: [
      keyGuide(ctx),
      '**Version:** pin one (`jev-1.13.0`), never an alias. Thresholds are tuned against one version’s distributions, and an alias moves under you when they ship.',
      '**Projects:** which projects it may read. Leave it empty for all of them, or name the ones whose diffs and logs may be sent.',
      '**What it costs:** roughly a hundredth of a cent a question. `budget` caps how many requests one look or one tool call may make, so a rebase storm cannot turn into a bill you find out about later.',
      '**What leaves the machine:** the diffs, logs and text you point it at go to TypeSafe, who say they do not train on them. Nothing is sent until you ask for something or turn a watch on — the review watch is off until somebody turns it on, per project.',
    ],
    fields: [
      {
        key: 'model',
        label: 'Version',
        kind: 'text',
        placeholder: 'jev-1.13.0',
        help: 'pin a version, not an alias',
      },
      {
        key: 'projects',
        label: 'Projects',
        kind: 'list',
        placeholder: 'tade',
        help: 'empty means every project Tade knows',
      },
      {
        key: 'report',
        label: 'Report at',
        kind: 'text',
        placeholder: '0.6',
        help: 'the probability worth saying',
      },
      {
        key: 'act',
        label: 'Act at',
        kind: 'text',
        placeholder: '0.85',
        help: 'the probability worth starting work on',
      },
      { key: 'brief', kind: 'flag', label: 'In the brief', help: 'say what it flagged overnight' },
    ],
    links: [
      { title: 'Create an API key', url: 'https://console.typesafe.ai/settings/keys' },
      { title: 'Ask for access', url: 'https://typesafe.ai' },
      { title: 'What it is bad at', url: 'https://docs.typesafe.ai/model-jaggedness/jev-1.13' },
    ],
  }),
  status: async (ctx) => {
    const record = await recordOf(ctx, 10_000)
    if (record.reviews.length === 0 && record.looks.length === 0) return null
    const line = statusLine(record)
    return {
      text: `jev · ${line.text}`,
      ...(record.looks.some((look) => look.problem)
        ? { tone: 'warning' as const }
        : line.flagged > 0
          ? {}
          : { tone: 'quiet' as const }),
    }
  },
  view: async (ctx) => findingsReport(await recordOf(ctx, 5_000)),
  harness: { pi: { skills: ['skills/ask-jev'] } },
}

/** What the setup guide says about the key, which is never typed into Tade. */
function keyGuide(ctx: ExtensionContext): string {
  const variable =
    typeof ctx.settings.key_env === 'string' && ctx.settings.key_env !== ''
      ? ctx.settings.key_env
      : 'TYPESAFE_API_KEY'
  return readyProblem(ctx) === null
    ? `**Key:** found in $${variable}. Tade reads it there and never keeps a copy.`
    : `**Key:** create one at console.typesafe.ai/settings/keys, then add \`export ${variable}="…"\` to your shell's profile and start Tade from a new terminal. Tade never stores it, and never asks you to type it in here — a key typed into a wizard is a key in a file.`
}

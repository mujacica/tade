import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workbench } from '@tade/workbench'
import { afterAll, describe, expect, it, type TestContext } from 'vitest'
import { LIVE } from '../../../scripts/release/repo.ts'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { Orchestrator } from '../src/orchestrator.ts'
import { ToolHost } from '../src/tool-host.ts'

// The one test that uses a real model.
//
// Everything else in this repo runs against a scripted provider, which is what
// keeps the suite fast, offline and credential-free — and means none of it can
// tell you whether a real model can actually *choose* the right tool from the
// descriptions we wrote. That is the one question a fake model can never
// answer, because the fake one is told what to call.
//
// So this is gated behind TADE_LIVE=1: it costs money and needs credentials,
// and it runs before a release rather than in the inner loop. Skipped, it must
// never fail; run, it is the only evidence that the tool surface is usable.
//
// **What is worth spending a model on is the choices that are easy to confuse.**
// Sixty tools in one namespace, and what a person feels as "it misunderstood
// me" is almost always a pair whose descriptions overlap: planning several
// changes against starting one agent, where things stand against what has
// happened, a note against a task, parking against finishing. Every case is
// one of those pairs, said the way somebody would say it, with nothing in the
// sentence naming a tool. Where reaching for the other one would actually do
// damage — `tade_done` releases everything waiting on a task — the case says
// that too (`notThis`), because "it called the right one as well" is not good
// enough.
//
// **The world has to be the one the question is asked in.** A stub that
// answers "nothing is queued" makes "hold off on the queue" a request with
// nothing to refuse, and the model is right to do nothing: the case then tests
// the fixture rather than the description. So what the window would answer is
// answered here, and what it would be asked to do is recorded rather than
// carried out — the assertion is the choice and the arguments.
//
// The cases are concurrent and each owns its own home, repo and orchestrator,
// so the file is under a minute rather than the sum of its turns: a release
// check nobody can afford to run is a release check nobody runs. Every one of
// them is waiting on a model, not on this machine, which is why concurrency is
// safe here and is not in the tests that drive real PTYs.

const live = process.env.TADE_LIVE === '1'
const describeLive = live ? describe.concurrent : describe.skip

/** What the window would have been asked to do, recorded rather than done. */
interface Asked {
  queue: Array<Record<string, unknown>>
  config: Array<{ method: string } & Record<string, unknown>>
}

interface World {
  tade: Workbench
  repo: ReturnType<typeof mkrepo>
  asked: Asked
}

interface Said {
  /** Every tool it reached for, in order. */
  tools: string[]
  /** What was said to it, for a case that has to check its words came through. */
  say: string
  answer: string
  world: World
}

/** One thing somebody says, and the tool it has to come out as. */
interface Choice {
  what: string
  /** What the person says, with no tool named in it. A thunk where saying it
   * needs something built first: the table is read even when the suite is
   * skipped, so nothing in it may reach the disk. */
  say: string | (() => string)
  seed?: (world: World) => Promise<void> | void
  /** The tool it has to reach for. */
  reaches: string
  /** Tools that reaching for would be the wrong answer, not merely a detour. */
  notThis?: readonly string[]
  /** Anything else that has to be true: the arguments, the effect, the words. */
  also?: (said: Said) => void | Promise<void>
}

/** Queued work to have an opinion about, in the words the window says it in. */
const QUEUED = [
  'Queued in app:',
  '- app/ledger — after app/refunds, because both change src/pay.ts',
  '- app/receipts — after app/ledger, because it reads the new columns',
].join('\n')

/**
 * A project with code in it, because a model asked to start work on a file
 * that does not exist is right to ask which file was meant — and it does,
 * which is the prompt working rather than the descriptions failing. An empty
 * fixture turns every one of these cases into that question, so the rule
 * `mkrepo` follows holds here from the other side: a fixture unlike the
 * machine a person is on hides what it was built to find.
 */
const PAY = `// Payments: refunds, the webhook that confirms them, and the ledger.

export interface LedgerRow {
  charge: string
  amt: number
  kind: 'charge' | 'refund'
}

const posted: LedgerRow[] = []

export function postToLedger(row: LedgerRow): void {
  posted.push(row)
}

export async function handleRefund(charge: string, amt: number): Promise<void> {
  await gateway.refund(charge, amt)
  postToLedger({ charge, amt, kind: 'refund' })
}

export async function onWebhook(event: { id: string; charge: string; amt: number }): Promise<void> {
  // The gateway retries a webhook it did not hear back from quickly enough.
  if (event.id.startsWith('refund.')) await handleRefund(event.charge, event.amt)
}

declare const gateway: { refund(charge: string, amt: number): Promise<void> }
`

/**
 * One question, put to a real orchestrator over a world of its own.
 *
 * Takes the test's own context rather than reaching for the imported
 * `onTestFinished`: these run concurrently, and a teardown that attaches to
 * whichever test the runner thinks is current stops another one's model
 * mid-turn — which looks exactly like a model that could not make up its mind,
 * and reads as one until you notice every failure timed out at the same
 * second.
 */
async function ask(
  ctx: TestContext,
  question: string,
  seed?: (world: World) => Promise<void> | void,
): Promise<Said> {
  const repo = mkrepo()
  repo.commit('the payments code', { 'src/pay.ts': PAY })
  const home = tmp('tade-live-')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'config.yaml'),
    `projects:\n  app:\n    root: ${repo.root}\norchestrator:\n  model: ${
      process.env.TADE_LIVE_MODEL ?? 'claude-opus-5'
    }\n`,
  )
  const tade = await Workbench.open({ home })
  const asked: Asked = { queue: [], config: [] }
  const world: World = { tade, repo, asked }
  await seed?.(world)

  const tools = await ToolHost.listen({
    tade,
    path: join(home, 'tools.sock'),
    queue: {
      describe: async () => QUEUED,
      change: async (req) => {
        asked.queue.push({ ...req })
        return `done: ${req.change}`
      },
      plan: async (plan) => {
        asked.queue.push({ change: 'plan', plan })
        return 'planned'
      },
      schedule: async (req) => {
        asked.queue.push({ change: 'schedule', ...req })
        return 'scheduled'
      },
    },
    config: {
      settings: async (find) => {
        asked.config.push({ method: 'settings', find })
        return 'workers.routes.default.model — what new agents start on. Now: unset.'
      },
      change: async (req) => {
        asked.config.push({ method: 'change', ...req })
        return `${req.path} is now ${req.value}`
      },
      openProject: async (req) => {
        asked.config.push({ method: 'openProject', ...req })
        return `opened ${req.name ?? req.path}`
      },
      closeProject: async (req) => {
        asked.config.push({ method: 'closeProject', ...req })
        return `closed ${req.project}`
      },
      renameProject: async (req) => {
        asked.config.push({ method: 'renameProject', ...req })
        return `${req.project} shows as ${req.name}`
      },
      reorderProjects: async (req) => {
        asked.config.push({ method: 'reorderProjects', order: [...req.order] })
        return `the tabs are now ${req.order.join(', ')}`
      },
      configureProject: async (req) => {
        asked.config.push({ method: 'configureProject', ...req })
        return `${req.project}.${req.setting} is now ${req.value}`
      },
    },
  })
  const orchestrator = await Orchestrator.start({
    home,
    socket: tools.path,
    runDir: join(home, 'orchestrator'),
    cwd: repo.root,
    config: tade.config,
  })
  // Registered before the turn, so a case that fails still tears down: a live
  // test that leaks a model process costs money for as long as nobody notices.
  ctx.onTestFinished(async () => {
    await orchestrator.stop().catch(() => {})
    await tools.close().catch(() => {})
    await tade.close().catch(() => {})
  })

  const used: string[] = []
  orchestrator.onTool((tool) => used.push(tool))
  const answer = await orchestrator.askFor(question, 180_000)
  return { tools: used, say: question, answer, world }
}

/** A task to talk about, the way the orchestrator would have made one. */
async function withTask(world: World, slug = 'refunds'): Promise<void> {
  await world.tade.createTask({
    project: 'app',
    slug,
    // Said the way somebody would say it, and about code that is really
    // there: an intent an agent could not act on is a question, not a task.
    intent: 'the refund flow double-charges when the webhook retries, in src/pay.ts',
    by: 'you',
  })
}

const CHOICES: readonly Choice[] = [
  {
    // The assertion is about *choosing*: nothing here says which tool to use,
    // so this passes only if the descriptions we wrote are good enough for a
    // model that has never seen this codebase.
    what: 'reaches for status when asked where things stand',
    say: 'where are we?',
    reaches: 'tade_status',
    also: ({ answer }) => expect(answer.length).toBeGreaterThan(0),
  },
  {
    // Status is now and the journal is the past, and out loud the two
    // questions are almost the same sentence. A model that answers this one
    // from `tade_status` answers "what is going on" to somebody who asked
    // "what went on".
    what: 'reads the journal when asked what has already happened',
    say: 'what has actually happened in here so far? walk me through it',
    reaches: 'tade_logs',
  },
  {
    what: 'creates a task, keeping the words that were used',
    say: 'start a task in app called refunds: the refund flow double-charges when the webhook retries',
    reaches: 'tade_task_create',
    also: async ({ say, world }) => {
      const [created] = await world.tade.events({ types: ['task_created'] })
      expect(created?.task).toBe('app/refunds')
      // Verbatim is the invariant, and where the sentence was cut is not: it
      // has written down `refunds: the refund flow…` as readily as `the refund
      // flow…`, and both are the person's own words. What may never happen is
      // a tidier sentence than the one they said — so what was written down
      // has to be a run of what was said, which nothing paraphrased can be.
      const intent = String(created?.detail.intent_spoken)
      expect(say).toContain(intent)
      expect(intent).toContain('double-charges when the webhook retries')
    },
  },
  {
    // A task that writes something up rather than changing code has to *say*
    // so, or the document it produces reaches nobody: the path is what lets
    // Tade tell whoever is listening where to read it when the task finishes.
    // Nothing in the sentence names the parameter, so this passes only if the
    // description we wrote reads as being about exactly this kind of work.
    what: 'says what a research task produces, so its document reaches somebody',
    say: 'put an agent on app to work out everywhere we widen an oauth scope, and write it up for me — no code changes, just the findings',
    reaches: 'tade_task_create',
    also: async ({ world }) => {
      const [created] = await world.tade.events({ types: ['task_created'] })
      const produces = String(created?.detail.produces ?? '')
      expect(produces).not.toBe('')
      // Wherever it put it, it may not be somewhere that goes when the task
      // does — which is the one thing the refusal already enforces.
      expect(produces.startsWith('.tade/')).toBe(false)
    },
  },
  {
    // Told a fact, not asked for work. The failure to guard against is the
    // eager one: a branch, a worktree and an agent, for a sentence.
    what: 'writes a note down rather than making a task out of it',
    say: 'while I remember — the staging key rotates on the first of the month',
    reaches: 'tade_remember',
    notThis: ['tade_task_create'],
    also: ({ world }) =>
      expect(
        world.tade
          .recallAll()
          .map((note) => note.text)
          .join('\n'),
      ).toContain('staging key'),
  },
  {
    // Notes are the one thing Tade is told rather than derives, so they are in
    // no other tool's answer: a model that reaches for status here does not
    // find them and — worse — says with confidence that there are none, which
    // is what this case caught the first time it was ever run.
    what: 'answers a question about the past from the notes, not from guessing',
    say: 'what did I tell you about app?',
    seed: (world) => {
      world.tade.remember('the staging key rotates on the first', 'app', 'you')
    },
    reaches: 'tade_notes',
    also: ({ answer }) => expect(answer.toLowerCase()).toContain('staging key'),
  },
  {
    // Three changes over one file in a shared checkout is the case `tade_plan`
    // exists for. Started as three agents at once they trample each other.
    what: 'plans when several changes have to be ordered',
    // Said in full, with nothing left to ask: a request with a hole in it is
    // one the prompt tells it to ask about before starting anything, and then
    // the case is about that rule rather than about choosing a tool.
    say:
      'do three things in app, all in src/pay.ts, and they must not run over each other:' +
      ' move handleRefund into src/refund.ts and re-export it; then make onWebhook skip an' +
      ' event it has already handled; then rename the LedgerRow fields charge and amt to' +
      ' charge_id and amount_cents. all three, please.',
    reaches: 'tade_plan',
    also: ({ world }) => expect(world.asked.queue.some((one) => one.change === 'plan')).toBe(true),
  },
  {
    // The other side of the same pair. A plan for a single change is a queue
    // entry, a wait and a reason for work that could have started now.
    what: 'starts one agent rather than planning when there is one thing to do',
    say: 'get someone going on app/refunds',
    seed: withTask,
    reaches: 'tade_run_start',
    notThis: ['tade_plan'],
  },
  {
    what: 'reads the queue when asked what is waiting',
    say: 'anything waiting to start? and what is it waiting for?',
    reaches: 'tade_queue',
  },
  {
    what: 'changes the queue when told to hold a project back',
    say: 'hold off on anything queued in app for now',
    reaches: 'tade_queue_change',
    also: ({ world }) => {
      const change = world.asked.queue.find((one) => one.change === 'pause')
      expect(change).toBeTruthy()
      expect(change?.project).toBe('app')
    },
  },
  {
    what: 'reads the settings when asked how this machine is set up',
    say: 'what do new agents start on around here?',
    reaches: 'tade_settings',
    notThis: ['tade_setting_change'],
  },
  {
    // A project's root is one of the paths `settingReach` says is never the
    // orchestrator's to write. Reaching for `tade_setting_change` here is a
    // refusal and a wasted turn; `tade_project_open` is the door.
    what: 'opens a project rather than writing the config itself',
    say: () => `start working in ${mkrepo().root} too, call it web`,
    reaches: 'tade_project_open',
    also: ({ world }) => {
      const opened = world.asked.config.find((one) => one.method === 'openProject')
      expect(opened?.name).toBe('web')
    },
  },
  {
    what: 'marks a task finished when the human says it is',
    say: 'app/refunds is done — I checked it myself',
    seed: withTask,
    reaches: 'tade_done',
  },
  {
    // The dangerous half of the pair: `tade_done` releases everything waiting
    // on the task, and nothing waiting on a task somebody parked should start.
    what: 'parks a task rather than finishing it when it is being set aside',
    say: "put app/refunds aside for now, I'll come back to it another week",
    seed: withTask,
    reaches: 'tade_park',
    notThis: ['tade_done'],
  },
]

/**
 * Where a green run leaves its evidence, for `pnpm release` to refuse without.
 *
 * A check nobody ran is not a check that passed, and this one had never been
 * run at all: it is skipped by default, there had never been a release, and
 * the tool descriptions were rewritten three times in between. So a run that
 * goes green writes down which commit it went green against, and the release
 * reads it. In Tade's home, under this project — it is one machine's and this
 * afternoon's, like every other run record — and at the one path the release
 * itself reads, so the two can never drift apart.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

const RECEIPT = LIVE

const TURN = 240_000

describeLive('against a real model', () => {
  let passed = 0
  let failed = 0

  for (const choice of CHOICES) {
    it(
      choice.what,
      async (ctx) => {
        ctx.onTestFailed(() => {
          failed += 1
        })
        const say = typeof choice.say === 'function' ? choice.say() : choice.say
        const said = await ask(ctx, say, choice.seed)
        expect(said.tools).toContain(choice.reaches)
        for (const wrong of choice.notThis ?? []) expect(said.tools).not.toContain(wrong)
        await choice.also?.(said)
        passed += 1
      },
      TURN,
    )
  }

  afterAll(() => {
    // Three outcomes and not two. Anything red takes the receipt away, because
    // a green run yesterday is not evidence about a description that fails
    // today and the commit would not have changed. Only a whole run writes
    // one. A run somebody filtered with `-t` is neither: it proved nothing and
    // disproved nothing, so it leaves what is there alone.
    if (failed > 0) {
      rmSync(RECEIPT, { force: true })
      return
    }
    if (passed !== CHOICES.length) return
    const at = new Date().toISOString()
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
    mkdirSync(dirname(RECEIPT), { recursive: true })
    writeFileSync(
      RECEIPT,
      `${JSON.stringify(
        { at, commit, cases: passed, model: process.env.TADE_LIVE_MODEL ?? 'claude-opus-5' },
        null,
        2,
      )}\n`,
    )
  })
})

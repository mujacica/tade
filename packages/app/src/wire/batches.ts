import { homedir } from 'node:os'
import { type CheckLog, readChecks } from '@tade/checks-core'
import { batchDue, type Culprit, expandHome, joined, workspaceFor } from '@tade/core'
import { git } from '@tade/status'
import {
  BATCH_BY,
  batchDir,
  type CoveredCommit,
  checksAt,
  coveredBy,
  type Narrowed,
  narrowingCommand,
  narrowRed,
  runBatch,
} from '@tade/workbench'
import { notify, type Wiring } from './context.ts'
import type { Tellable } from './handed.ts'
import { putToOrchestrator } from './proposals.ts'

// The full checks, once a batch, where a project batches them.
//
// Every look at the tasks asks each batched project's checkout the pure rule
// (`batchDue`, core's `batches.ts`): HEAD settled, not green, no batch answered
// it yet, nothing running. Then one batch — one at a time per project, and one
// suite at a time on the machine like any run — in a tree of its own at exactly
// HEAD (`runBatch`), recorded as the checkout's. The next starts when HEAD has
// moved past it, so however many agents commit while one runs, the next run
// covers all of them.
//
// A red one is narrowed in that tree — the failing tests again at the commits
// it covered, halving, to whose commit broke it — and becomes **one** parked
// proposal, put to the orchestrator now, naming the commit and the task its
// trailer says it is. Never one agent per covered task: the orchestrator
// decides, and steering the agent whose commit it was is the first thing it is
// offered. Nothing here starts an agent, holds anything or skips a check.

/** Who a red batch's proposal is made by, as `taskOrigin` reads it. */
const BY = 'extension:checks'

/**
 * How often the batched checkouts are looked at. The task beat comes every
 * couple of seconds and a look reads the run record and asks git for HEAD, so
 * it is paced here: `SETTLE_MS` is a minute, and two looks in it are plenty.
 */
export const BATCH_LOOK_MS = 30_000

export class Batches {
  private readonly wire: Wiring
  private readonly orchestrator: () => Tellable
  /** The HEAD each project's batch is running at, while one is. */
  private readonly going = new Map<string, string>()
  /** Where each checkout's HEAD was last seen, and since when: commits arrive in bursts. */
  private readonly still = new Map<string, { head: string | null; since: number }>()
  /** The last batch that could not run, so the next try waits (`RETRY_MS`). */
  private readonly tried = new Map<string, { head: string; at: number }>()
  /** What was last said about a batch that could not run, so it is said once. */
  private readonly said = new Map<string, string>()
  private looking = false
  private lookedAt = Number.NEGATIVE_INFINITY

  constructor(wire: Wiring, orchestrator: () => Tellable) {
    this.wire = wire
    this.orchestrator = orchestrator
  }

  /**
   * One look at every batched project, at most every `BATCH_LOOK_MS`.
   * Single-flight: a slow look is not stacked under the next beat.
   */
  async beat(): Promise<void> {
    const now = this.wire.now()
    if (this.looking || now - this.lookedAt < BATCH_LOOK_MS) return
    this.looking = true
    this.lookedAt = now
    try {
      for (const project of Object.keys(this.wire.opts.config.projects)) {
        await this.look(project).catch((err: unknown) =>
          this.sayOnce(
            project,
            `the batch could not look: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      }
    } finally {
      this.looking = false
    }
  }

  /** Say what is wrong with a project's batches on screen, once for each reason. */
  private sayOnce(project: string, problem: string): void {
    if (this.said.get(project) === problem) return
    this.said.set(project, problem)
    notify(this.wire, `The full checks of ${project} could not run as a batch: ${problem}`)
    this.wire.draw()
  }

  private async look(project: string): Promise<void> {
    const config = this.wire.opts.config
    const configured = config.projects[project]
    if (!configured || this.going.has(project)) return
    if (workspaceFor(config, project) !== 'checkout') return
    const root = expandHome(configured.root)
    const now = this.wire.now()
    const said = await git(root, ['rev-parse', 'HEAD'], 10_000)
    const head = said.ok ? said.stdout.trim() : null
    const seen = this.still.get(project)
    if (!seen || seen.head !== head) this.still.set(project, { head, since: now })
    const stood = await checksAt({
      config,
      project,
      worktree: root,
      tadeHome: this.wire.opts.home,
      commit: head,
    })
    if (!stood.batched) return
    const answer = batchDue({
      head,
      rollup: stood.rollup.state,
      checks: stood.plan.length,
      batched:
        stood.at.some((run) => run.by === BATCH_BY) ||
        stood.runs.some((run) => run.by === BATCH_BY && run.commit === head),
      running: stood.running !== null,
      stillMs: now - (this.still.get(project)?.since ?? now),
      tried: this.tried.get(project) ?? null,
      now,
    })
    if (!answer.run || !head) return
    this.going.set(project, head)
    // Not awaited: a batch takes minutes, and the next look at the tasks must
    // not wait on it. `going` is what stops a second one starting meanwhile.
    void this.run(project, root, head)
      .catch((err: unknown) =>
        this.sayOnce(project, err instanceof Error ? err.message : String(err)),
      )
      .finally(() => this.going.delete(project))
  }

  private async run(project: string, root: string, head: string): Promise<void> {
    const config = this.wire.opts.config
    const home = this.wire.opts.home
    const batch = await runBatch({ config, home, userHome: homedir(), project, root, commit: head })
    if ('problem' in batch) {
      this.tried.set(project, { head, at: this.wire.now() })
      // Busy is the ordinary case — somebody's run has the machine — and the
      // next look tries again. Anything else is said, once per reason.
      if (!batch.busy) this.sayOnce(project, batch.problem)
      return
    }
    this.said.delete(project)
    const failed = batch.runs.filter(
      (run) => run.required && (run.state === 'failed' || run.state === 'timed out'),
    )
    if (failed.length > 0) await this.red(project, root, head, failed)
  }

  /** A red batch: narrowed to whose commit it was, and made one proposal. */
  private async red(project: string, root: string, head: string, failed: CheckLog[]) {
    const config = this.wire.opts.config
    const home = this.wire.opts.home
    const covered = await coveredBy({ config, home, project, root, head })
    // What the commit says it checks: the batch tree is still at HEAD.
    const checks = (await readChecks({ name: project, root: batchDir(home, project) })).checks
    let narrowed: Narrowed | null = null
    let cannot = covered.base ? '' : 'there is no commit before these to compare with'
    for (const run of failed) {
      if (narrowed || !covered.base) break
      const command = narrowingCommand(run, checks)
      if ('cannot' in command) {
        cannot = command.cannot
        continue
      }
      narrowed = await narrowRed({
        config,
        home,
        project,
        root,
        base: covered.base,
        baseGreen: covered.green,
        commits: covered.commits.map((one) => one.commit),
        command: command.run,
      })
    }
    const culprit: Culprit = narrowed?.culprit ?? { commit: null, because: cannot }
    const whose = covered.commits.find((one) => one.commit === culprit.commit) ?? null
    const facts = { project, head, failed, covered: covered.commits, whose, culprit, narrowed }
    const making = this.wire.opts.client
    const title = `The full checks went red at ${head.slice(0, 8)}`
    const prompt = proposalPrompt(facts)
    const task = await making.createTask({
      project,
      slug: `red-full-run-${head.slice(0, 7)}`,
      intent: prompt,
      by: BY,
      context: proposalContext(facts),
      start: { after: [], prompt, touches: [] },
      proposed: { title },
    })
    await making.parkTask(task.id, true, { by: BY })
    putToOrchestrator(this.wire, this.orchestrator(), toldOf(facts, task.id), [task.id])
  }
}

interface RedFacts {
  project: string
  head: string
  failed: readonly CheckLog[]
  covered: readonly CoveredCommit[]
  whose: CoveredCommit | null
  culprit: Culprit
  narrowed: Narrowed | null
}

/** Whose it is, in one sentence: the commit and its trailer's task, or why nobody's. */
function whoseSaid(facts: RedFacts): string {
  const { whose, culprit } = facts
  if (culprit.commit === null) return `Whose commit broke it cannot be said: ${culprit.because}.`
  const commit = `${culprit.commit.slice(0, 8)} (${whose?.subject ?? 'no subject'})`
  return whose?.task
    ? `Run again on their own at each covered commit, the failing tests first fail at ${commit}, which is ${whose.task}'s by its trailer.`
    : `Run again on their own at each covered commit, the failing tests first fail at ${commit}, which has no Tade-Task trailer.`
}

/** What the orchestrator is told, now. */
function toldOf(facts: RedFacts, task: string): string {
  const tasks = [...new Set(facts.covered.map((one) => one.task ?? 'unattributed'))]
  return [
    `The full checks of ${facts.project} went red at ${facts.head.slice(0, 8)}: ${facts.failed.map((run) => run.check).join(', ')}.`,
    `That batch covered ${facts.covered.length} ${facts.covered.length === 1 ? 'commit' : 'commits'} (${joined(tasks)}).`,
    whoseSaid(facts),
    `It is parked as ${task}: decide it with tade_proposal_decide.`,
    facts.whose?.task
      ? `Steer ${facts.whose.task} if its agent can take it back; otherwise start it.`
      : facts.culprit.commit === null && 'flaky' in facts.culprit && facts.culprit.flaky
        ? 'Leave it if the next batch is green: a failure that does not come back on its own is load or a flake.'
        : 'Start it, or have it wait for whoever is already on the same code.',
    'One agent on it, never one per covered task.',
  ].join(' ')
}

/** What the agent that fixes it is told. */
function proposalPrompt(facts: RedFacts): string {
  return [
    `The full checks of this project went red at ${facts.head.slice(0, 8)} (${facts.failed.map((run) => run.check).join(', ')}), in a batch run over exactly that commit.`,
    whoseSaid(facts),
    'Make them green again at HEAD. What failed, what the batch covered and every commit the failing tests were run again at are in your context file.',
    'Run the failing tests with checks_run related: true and their paths while you work; before you commit, the related run is enough — the next batch runs the full checks.',
  ].join(' ')
}

/** The context file: the tails, the commits covered, and the narrowing step by step. */
function proposalContext(facts: RedFacts): string {
  return [
    `# The full checks went red at ${facts.head}`,
    '',
    '## What failed',
    ...facts.failed.flatMap((run) => [
      '',
      `### ${run.check}`,
      '',
      '```',
      run.tail.split('\n').slice(-60).join('\n').trimEnd(),
      '```',
    ]),
    '',
    '## What the batch covered, oldest first',
    '',
    ...facts.covered.map(
      (one) =>
        `- ${one.commit.slice(0, 8)} ${one.task ?? '(no Tade-Task trailer)'} — ${one.subject}`,
    ),
    '',
    '## Whose commit',
    '',
    whoseSaid(facts),
    ...(facts.narrowed ? ['', ...facts.narrowed.steps.map((step) => `- ${step}`)] : []),
    '',
  ].join('\n')
}

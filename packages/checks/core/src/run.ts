import { coverageOf } from './coverage.ts'
import { waitForRunLock } from './lock.ts'
import type { Check, CheckLog, CheckRun, Covered, ProjectRef, Runner } from './port.ts'
import { RunnerError, settled } from './port.ts'
import { writeRun } from './records.ts'
import { clearRunning, type RunningCheck, type RunningNow, writeRunning } from './running.ts'

// Running a project's checks the way Tade runs them: one run at a time in a
// worktree, what is skipped said rather than dropped, and every finished run
// written down against the commit it was about.
//
// Every caller goes through here — the CLI, the tool an agent calls, the
// window's button, the gate before a push — so the lock, the record and the
// row in the window come free, and four agents in one checkout do not start
// four suites.

export interface RunRequest {
  runner: Runner
  project: ProjectRef
  /** What to run, already planned: `planFor` decided what applies and in what order. */
  checks: readonly Check[]
  /** The commit it is about. A run that does not name one says nothing. */
  commit: string
  /** Who asked: a task, the orchestrator, you, a rule. */
  by: string
  signal?: AbortSignal
  /** Tade's home, so a tail says `~` rather than where you live. */
  home?: string
  keep?: number
  /** How long to wait for another run in this worktree to finish before giving up. */
  waitMs?: number
  onRun?: (run: CheckRun) => void
  onOutput?: (check: string, chunk: string) => void
  now?: () => number
}

/**
 * Run them here and write down what happened. Throws `busy` when another run
 * has the worktree and did not finish in time — never "they passed" because
 * somebody else's run did.
 */
export async function runChecks(request: RunRequest): Promise<CheckLog[]> {
  const { runner, project, commit, by } = request
  const now = request.now ?? Date.now
  const plan = request.checks
  if (plan.length === 0) return []

  const skipped: CheckLog[] = plan
    .filter((check) => check.skip)
    .map((check) => ({
      id: `${commit.slice(0, 7)}:${check.id}:here:0`,
      check: check.id,
      commit,
      state: 'skipped' as const,
      where: { kind: 'here' as const, runner: runner.id, host: '' },
      required: check.required,
      startedAt: new Date(now()).toISOString(),
      finishedAt: new Date(now()).toISOString(),
      code: null,
      summary: check.skip ?? null,
      by,
      ran: check.run,
      tail: '',
    }))
  for (const run of skipped) request.onRun?.(run)
  const toRun = plan.filter((check) => !check.skip)
  if (toRun.length === 0) {
    const all = covering(skipped, await coverageOf(project.root, commit), plan)
    await record(project.root, all, request)
    return all
  }

  // The lock is taken when the machine is what is being asked for: a check
  // that needs it to itself, or a runner told to do one thing at a time.
  const needsMachine = toRun.some((check) => check.alone)
  const lock = needsMachine
    ? await waitForRunLock(project.root, toRun.map((check) => check.id).join(', '), {
        waitMs: request.waitMs ?? 0,
        now,
      })
    : null
  if (lock && 'held' in lock) {
    const since = lock.held.at ? ` (since ${lock.held.at})` : ''
    throw new RunnerError(
      'busy',
      `checks are already running in ${project.root}: ${lock.held.what || 'something'}${since}. Wait for them rather than starting a second run.`,
    )
  }

  // What the commands are about to read, taken once the worktree is ours to
  // read: the commit's tree and whatever differs from it on disk. It is what
  // lets the commit made right after this one still count as checked, and it
  // is taken before rather than after, because what is asked later is whether
  // the bytes that were committed are the bytes that were read.
  const covered = await coverageOf(project.root, commit)

  const controller = new AbortController()
  request.signal?.addEventListener('abort', () => controller.abort(), { once: true })
  // What is going on, for anybody watching: written as it changes, and taken
  // back when the run ends. The record in `checks.jsonl` is still only ever
  // what finished — this is the minutes in between, which used to be silence.
  let watched: RunningCheck[] = [
    ...skipped.map(asRunning),
    ...toRun.map((check) => ({
      check: check.id,
      state: 'queued' as const,
      startedAt: null,
      finishedAt: null,
    })),
  ]
  const watching: RunningNow = {
    pid: process.pid,
    commit,
    by,
    at: new Date(now()).toISOString(),
    checks: watched,
  }
  let told: Promise<void> = writeRunning(project.root, watching)
  const tell = (run: CheckRun) => {
    watched = watched.map((one) => (one.check === run.check ? asRunning(run) : one))
    // Chained rather than raced: two writes of one file must land in the
    // order the states happened, or a watcher sees a finished check go back
    // to running.
    const next = { ...watching, checks: watched }
    told = told.then(() => writeRunning(project.root, next))
  }
  try {
    const ran = await runner.run(project, toRun, {
      commit,
      by,
      signal: controller.signal,
      onRun: (run) => {
        tell(run)
        request.onRun?.(run)
      },
      onOutput: (check, chunk) => request.onOutput?.(check, chunk),
    })
    const all = covering([...skipped, ...ran], covered, plan)
    await record(project.root, all, request)
    return all
  } finally {
    await told.catch(() => {})
    await clearRunning(project.root, watching)
    if (lock && !('held' in lock)) await lock.release()
  }
}

function asRunning(run: CheckRun): RunningCheck {
  return {
    check: run.check,
    state: run.state,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  }
}

/**
 * What each run read, and what it ran. The bytes are what lets a run still
 * speak for the commit made right after it; the command is what lets it still
 * speak for its check after somebody retitles the step it came from. Written
 * here rather than in each runner, so a runner cannot forget either.
 */
function covering(
  runs: readonly CheckLog[],
  covered: Covered | null,
  plan: readonly Check[],
): CheckLog[] {
  const ran = new Map(plan.map((check) => [check.id, check.run]))
  return runs.map((run) => ({
    ...run,
    ...(covered ? { covered } : {}),
    ...(run.ran ? {} : { ran: ran.get(run.check) ?? '' }),
  }))
}

async function record(
  worktree: string,
  runs: readonly CheckLog[],
  request: RunRequest,
): Promise<void> {
  for (const run of runs) {
    if (!settled(run.state)) continue
    await writeRun(worktree, run, {
      ...(request.keep === undefined ? {} : { keep: request.keep }),
      ...(request.home === undefined ? {} : { home: request.home }),
    })
  }
}

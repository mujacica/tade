import { coverageOf } from './coverage.ts'
import { type LockHolder, waitForRunLock } from './lock.ts'
import { type Holders, holdersSaid, queueDir, SLOT_ENV, waitForMachineSlot } from './machine.ts'
import type { Check, CheckLog, CheckRun, Covered, ProjectRef, Runner } from './port.ts'
import { RunnerError, settled } from './port.ts'
import { writeRun } from './records.ts'
import { clearRunning, type RunningCheck, type RunningNow, writeRunning } from './running.ts'
import { HELD_MS, holdKept, joinQueue, KEPT_MS, STILL_MS } from './turn.ts'

// Running a project's checks the way Tade runs them: one run at a time in a
// worktree and `checks.suites` on the machine, what is skipped said rather
// than dropped, and every finished run written down against the commit it was
// about.
//
// Every caller goes through here — the CLI, the tool an agent calls, the
// window's button, the gate before a push — so the locks, the record and the
// row in the window come free, and four agents in one checkout, or in four
// worktrees, do not start four suites.

export interface RunRequest {
  runner: Runner
  project: ProjectRef
  /**
   * Where what happened is written down: Tade's own folder for this directory
   * (`recordsDir`), never the worktree. One per directory checks run in, which
   * is what makes the lock mean "somebody is already running the suite here".
   */
  records: string
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
  /** How long to wait for another run — in this worktree, or holding the machine — before giving up. */
  waitMs?: number
  /**
   * The machine's own bound, over every worktree and project: Tade's home,
   * where its slots are, and how many runs may hold one at once
   * (`checks.suites`). Without it a run is bounded by its worktree alone,
   * which is six suites for six worktrees.
   */
  machine?: { home: string; most: number }
  /** Told who has the machine, each time that changes while this run waits for it. */
  onWait?: (ahead: Holders) => void
  onRun?: (run: CheckRun) => void
  onOutput?: (check: string, chunk: string) => void
  now?: () => number
}

/**
 * Run them here and write down what happened. Throws `busy` when another run
 * has the worktree, or the machine, and did not finish in time — never "they
 * passed" because somebody else's run did.
 */
export async function runChecks(request: RunRequest): Promise<CheckLog[]> {
  const { runner, project, records, commit, by } = request
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
    await record(records, all, request)
    return all
  }

  // The locks are taken when the machine is what is being asked for: a check
  // that needs it to itself, or a runner told to do one thing at a time. The
  // worktree first, so a second run here is told about this one rather than
  // queueing behind it for the machine; then a slot of the machine's, under
  // the same deadline, because `alone` means nothing else of ours beside it
  // and a worktree is not the machine.
  const needsMachine = toRun.some((check) => check.alone)
  const what = toRun.map((check) => check.id).join(', ')
  const asked = now()
  const deadline = asked + (request.waitMs ?? 0)
  // A place this asker kept for the machine goes on holding its turn while
  // they wait for the checkout first. Left alone it stopped after `HELD_MS`,
  // and a suite that asked after them took the slot (`holdKept`). Whoever has
  // the lock, waiting for the machine behind it, is let through and nobody
  // else: that is who has it, where it runs, as the lock says — the checkout
  // for a run there, the batch tree for one in it, which waits for the
  // checkout's lock all the same.
  //
  // One with no place kept is given one, from when it asked, the first time
  // it waits for the checkout. Without it a run waiting for the checkout was
  // nowhere in the machine's queue: one asked at 17:45:19 behind the batch,
  // and two related runs in other worktrees that asked at 17:47:59 and
  // 18:27:47 had the machine before it once the batch let go.
  const machine = request.machine
  const holding = machine
    ? (ms: number, held: LockHolder) =>
        holdKept(queueDir(machine.home), by, { waitingFor: [held], ms, now })
    : null
  const meanwhile =
    machine && holding
      ? async (held: LockHolder) => {
          if (await holding(STILL_MS, held)) return
          const asking = { what, where: project.root, as: by }
          await (await joinQueue(queueDir(machine.home), asking, now, asked)).keep(STILL_MS)
          await holding(STILL_MS, held)
        }
      : null
  const lock = needsMachine
    ? await waitForRunLock(records, what, {
        waitMs: request.waitMs ?? 0,
        now,
        as: by,
        where: project.root,
        ...(meanwhile ? { meanwhile } : {}),
      })
    : null
  if (lock && 'held' in lock) {
    // Given up for the checkout, it holds its turn for the machine while they
    // ask again, as a place given up for the machine does. Gone because whoever
    // asked has gone, there is nobody to hold it for.
    if (holding && !request.signal?.aborted) await holding(HELD_MS, lock.held)
    const since = lock.held.at ? ` (since ${lock.held.at})` : ''
    throw new RunnerError(
      'busy',
      `checks are already running in ${project.root}: ${lock.held.what || 'something'}${since}. ${waitedSaid(now() - asked, request.waitMs)}`,
    )
  }
  const slot =
    lock && request.machine
      ? await waitForMachineSlot(
          request.machine.home,
          request.machine.most,
          { what, where: project.root },
          {
            waitMs: Math.max(0, deadline - now()),
            now,
            as: by,
            ...(request.onWait ? { onWait: request.onWait } : {}),
            ...(request.signal ? { signal: request.signal } : {}),
          },
        ).catch(async (err: unknown) => {
          // The worktree is let go before the trouble is passed on, or a home
          // that cannot be written would leave this checkout busy for ever.
          await lock.release()
          throw err
        })
      : null
  if (slot && 'held' in slot) {
    // Gone at its deadline, it keeps its place for the checkout as it does for
    // the machine: let go with the lock, the run behind it had the checkout
    // the moment it was free and was ahead of it for the machine too. Gone
    // because whoever asked has gone, there is nobody to keep it for.
    await (request.signal?.aborted ? lock?.release() : lock?.giveUp())
    const most = request.machine?.most ?? 1
    throw new RunnerError(
      'busy',
      `this machine runs ${most === 1 ? 'one suite' : `${most} suites`} at a time (checks.suites), and ${holdersSaid(slot.held, request.home)} ${slot.held.length === 1 ? 'has' : 'have'} it. ${waitedSaid(now() - asked, request.waitMs)}`,
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
  // Cancelled while it waited for a turn: a signal already aborted never
  // fires its listener, and the run would start for nobody.
  if (request.signal?.aborted) controller.abort()
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
  let told: Promise<void> = writeRunning(records, watching)
  const tell = (run: CheckRun) => {
    watched = watched.map((one) => (one.check === run.check ? asRunning(run) : one))
    // Chained rather than raced: two writes of one file must land in the
    // order the states happened, or a watcher sees a finished check go back
    // to running.
    const next = { ...watching, checks: watched }
    told = told.then(() => writeRunning(records, next))
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
      ...(slot ? { env: { [SLOT_ENV]: slot.path } } : {}),
    })
    const all = covering([...skipped, ...ran], covered, plan)
    await record(records, all, request)
    return all
  } finally {
    await told.catch(() => {})
    await clearRunning(records, watching)
    if (slot && !('held' in slot)) await slot.release()
    if (lock && !('held' in lock)) await lock.release()
  }
}

/**
 * The end of a busy refusal. One that came after a wait says how long, or
 * "wait for them" reads as a refusal that never waited at all.
 */
function waitedSaid(waited: number, waitMs: number | undefined): string {
  if (!waitMs) return 'Wait for them rather than starting a second run.'
  const seconds = Math.round(waited / 1000)
  const how = seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`
  return `This run waited ${how} for them and gave up; its place in the queue is kept for ${KEPT_MS / 60_000} minutes, so asking again carries on from it rather than starting a second run.`
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
  records: string,
  runs: readonly CheckLog[],
  request: RunRequest,
): Promise<void> {
  for (const run of runs) {
    if (!settled(run.state)) continue
    await writeRun(records, run, {
      ...(request.keep === undefined ? {} : { keep: request.keep }),
      ...(request.home === undefined ? {} : { home: request.home }),
    })
  }
}

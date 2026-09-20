import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import {
  type Check,
  type CheckLog,
  type CheckState,
  type ProjectRef,
  planFor,
  type RunContext,
  type Runner,
  RunnerError,
  type RunnerOptions,
  readChecks,
} from '@tade/checks-core'

// The commands, run the way you would type them.
//
// This is the runner anybody actually wants before a push: seconds rather than
// minutes, nothing to install that the project does not already need, and it
// proves that *this code* is good on *this machine*. What it cannot prove —
// the OS matrix, the runner's toolchain, anything needing a secret — is what
// `fidelity` says out loud beside the tick, because a tick that quietly means
// less than the one next to it is the worst thing this could ship.
//
// Everything it starts is detached, in a process group of its own: the
// terminal is never retitled after a check, and a group signal is the only
// thing that reaches the `pnpm` a command started.

/** How long a stopped check is given to end politely before it is killed. */
const GRACE_MS = 2_000

/**
 * And how long its last bytes are waited for after it is gone. A command that
 * left something behind holding the pipe open would otherwise never let go.
 */
const DRAIN_MS = 2_000

export function makeLocalRunner(options: RunnerOptions = {}): Runner {
  const now = options.now ?? Date.now
  const parallel = Math.max(1, options.parallel ?? 2)
  const tailKept = Math.max(200, options.tail ?? 4_000)
  const host = options.host ?? hostname()
  let counter = 0

  const id = (check: Check, commit: string) => `${commit.slice(0, 7)}:${check.id}:here:${++counter}`

  return {
    id: 'local',
    capabilities: {
      containers: false,
      services: false,
      matrix: false,
      // A check that needs a secret is the project's to arrange: Tade never
      // holds one, so it is run with the environment you have and nothing more.
      secrets: false,
      cancel: true,
      fidelity: 'the commands',
    },
    words: { one: 'check', many: 'checks' },

    async ready(project: ProjectRef): Promise<string | null> {
      try {
        const where = await stat(project.root)
        if (!where.isDirectory()) return `${project.root} is not a directory`
      } catch {
        return `${project.root} is not there: check where the project says it is`
      }
      return null
    },

    async plan(project, at): Promise<Check[]> {
      const manifest = await readChecks(project)
      return planFor(manifest.checks, { changed: at.changed })
    },

    async run(project, checks, ctx): Promise<readonly CheckLog[]> {
      const problem = await this.ready(project)
      if (problem) throw new RunnerError('unavailable', problem)

      const done = new Map<string, CheckLog>()
      const queue = [...checks]
      for (const check of queue) {
        ctx.onRun({
          id: `${ctx.commit.slice(0, 7)}:${check.id}:here:queued`,
          check: check.id,
          commit: ctx.commit,
          state: 'queued',
          where: { kind: 'here', runner: 'local', host },
          required: check.required,
          startedAt: null,
          finishedAt: null,
          code: null,
          summary: null,
          by: ctx.by,
        })
      }

      const skip = (check: Check, why: string): CheckLog => {
        const at = new Date(now()).toISOString()
        const run: CheckLog = {
          id: id(check, ctx.commit),
          check: check.id,
          commit: ctx.commit,
          state: 'skipped',
          where: { kind: 'here', runner: 'local', host },
          required: check.required,
          startedAt: at,
          finishedAt: at,
          code: null,
          summary: why,
          by: ctx.by,
          tail: '',
        }
        ctx.onRun(run)
        return run
      }

      while (queue.length > 0) {
        const batch: Check[] = []
        while (queue.length > 0 && batch.length < parallel) {
          const next = queue[0]
          if (!next) break
          // A check that needs the machine to itself goes alone, and never
          // beside something already going.
          if (next.alone && batch.length > 0) break
          queue.shift()
          const failedNeed = (next.needs ?? []).find(
            (need) => done.has(need) && done.get(need)?.state !== 'passed',
          )
          if (failedNeed) {
            done.set(next.id, skip(next, `${failedNeed} did not pass, so this was not run`))
            continue
          }
          batch.push(next)
          if (next.alone) break
        }
        if (batch.length === 0) continue
        const ran = await Promise.all(
          batch.map((check) => one(check, project, ctx, { now, host, tailKept, idOf: id })),
        )
        for (const run of ran) done.set(run.check, run)
      }
      return [...done.values()]
    },
  }
}

/** One check: start it, watch it, and end it whatever happens. */
async function one(
  check: Check,
  project: ProjectRef,
  ctx: RunContext,
  opts: {
    now: () => number
    host: string
    tailKept: number
    idOf: (check: Check, commit: string) => string
  },
): Promise<CheckLog> {
  const startedAt = new Date(opts.now()).toISOString()
  const base = {
    id: opts.idOf(check, ctx.commit),
    check: check.id,
    commit: ctx.commit,
    where: { kind: 'here' as const, runner: 'local', host: opts.host },
    required: check.required,
    startedAt,
    by: ctx.by,
  }
  ctx.onRun({ ...base, state: 'running', finishedAt: null, code: null, summary: null })

  // A shell, because a check is a command line as a person writes it
  // ("pnpm exec vitest run"), not an argument vector.
  const child = spawn(check.run, {
    shell: true,
    cwd: project.root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: process.env.CI ?? '', TADE_CHECK: check.id },
  })
  let tail = ''
  const keep = (chunk: string) => {
    tail += chunk
    if (tail.length > opts.tailKept * 4) tail = tail.slice(-opts.tailKept * 2)
    ctx.onOutput(check.id, chunk)
  }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  // Listened for now rather than after the exit: 'close' is emitted once, and
  // a listener added after it fired waits for an event that already happened.
  const drained = new Promise<void>((done) => child.once('close', () => done()))

  const end = async (why: 'timed out' | 'cancelled'): Promise<void> => {
    // Said before the signal, not after it: the child's exit arrives first, and
    // a run that was stopped must never be read from its exit code as failing
    // on its own account.
    outcome = why
    stop(child.pid ?? null, 'SIGTERM')
    await new Promise((done) => {
      const timer = setTimeout(done, GRACE_MS)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        done(null)
      })
    })
    stop(child.pid ?? null, 'SIGKILL')
  }

  let outcome: 'timed out' | 'cancelled' | null = null
  const limit = Math.max(1, Math.round(check.minutes * 60_000))
  const timer = setTimeout(() => void end('timed out'), limit)
  timer.unref?.()
  const onAbort = () => void end('cancelled')
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  if (ctx.signal.aborted) onAbort()

  // Exit says the process is gone; it does not say its last bytes have been
  // read. A check that failed on one line of stderr raced that line against
  // its own exit and, on a fast machine, was recorded with nothing under it —
  // a red run nobody can read is barely better than no run at all. So the
  // pipes are given a moment to finish, bounded because a command that left a
  // child holding them open would hold this forever.
  const code = await new Promise<number>((done) => {
    child.once('error', () => done(127))
    child.once('exit', (exit) => done(exit ?? 1))
  })
  // Both let go the moment it is gone, and before the wait below: a check
  // that finished on time must not be recorded as timed out or cancelled
  // because its last bytes took a moment to arrive.
  clearTimeout(timer)
  ctx.signal.removeEventListener('abort', onAbort)
  await Promise.race([
    drained,
    new Promise<void>((done) => {
      const drain = setTimeout(done, DRAIN_MS)
      drain.unref?.()
    }),
  ])

  const state: CheckState = outcome ?? (code === 0 ? 'passed' : 'failed')
  const run: CheckLog = {
    ...base,
    state,
    finishedAt: new Date(opts.now()).toISOString(),
    code: outcome ? null : code,
    summary: state === 'passed' ? null : lastLine(tail),
    tail: tail.slice(-opts.tailKept),
  }
  ctx.onRun(run)
  return run
}

/** Signal the whole group: a command is a shell, and the work is its children. */
function stop(pid: number | null, signal: NodeJS.Signals): void {
  if (pid === null) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone, which is the outcome we wanted.
    }
  }
}

/** What it said last, as its one line. Never a summary we invented. */
function lastLine(tail: string): string | null {
  const line = tail
    .split('\n')
    .map((part) => part.replace(/\s+$/, ''))
    .filter((part) => part.trim() !== '')
    .at(-1)
  return line ? line.slice(0, 200) : null
}

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Check,
  type CheckLog,
  type CheckState,
  type Failing,
  keepTail,
  OUT_OF_DISK,
  type ProjectRef,
  planFor,
  type RunContext,
  type Runner,
  RunnerError,
  type RunnerOptions,
  readChecks,
  SLEPT,
  summaryOf,
} from '@tade/checks-core'
import { type GivesWay, givesWay, loweredLine, machineLabel } from '@tade/core'
import { awakeAt, startAwake } from './awake.ts'
import { type SpaceLeft, spaceLeft, watchDisk } from './disk.ts'
import { type SleptBetween, sleptBetween } from './slept.ts'
import { stop } from './stop.ts'

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
// thing that reaches the `pnpm` a command started. Where the machine asks it
// to, the whole group gives way to whatever a person is looking at
// (`loweredLine`) — the shell and everything under it, because half a
// lowered check is not a lowered check.

/** How long a stopped check is given to end politely before it is killed. */
const GRACE_MS = 2_000

/**
 * And how long its last bytes are waited for after it is gone. A command that
 * left something behind holding the pipe open would otherwise never let go.
 */
const DRAIN_MS = 2_000

/** How often a running check's time awake is counted towards its limit. */
const BEAT_MS = 1_000

export interface LocalRunnerOptions extends RunnerOptions {
  /** How much of a disk is free (`disk.ts`): the machine's own unless a test says otherwise. */
  spaceLeft?: SpaceLeft
  /** Whether the machine really slept (`slept.ts`): the kernel's word unless a test says otherwise. */
  sleptBetween?: SleptBetween
}

export function makeLocalRunner(options: LocalRunnerOptions = {}): Runner {
  const now = options.now ?? Date.now
  const left = options.spaceLeft ?? spaceLeft
  const asleep = options.sleptBetween ?? sleptBetween
  const parallel = Math.max(1, options.parallel ?? 2)
  const tailKept = Math.max(200, options.tail ?? 4_000)
  // The machine's own name (`machine.name`), never its host name: a run's record travels.
  const host = options.host ?? machineLabel()
  // Asked once per runner rather than per check: whether this machine has
  // `nice` does not change between two checks of one run, and the answer is a
  // PATH walk. Nothing is said when it cannot — the lane registry is what says
  // that, once a window, and a line per check run would be the same news again.
  const giveWay = givesWay('checks', options.giveWay ?? 0)
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
          batch.map((check) =>
            one(check, project, ctx, { now, host, tailKept, giveWay, idOf: id, left, asleep }),
          ),
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
    /** How far below the window, already decided (`givesWay`). */
    giveWay: GivesWay
    idOf: (check: Check, commit: string) => string
    left: SpaceLeft
    asleep: SleptBetween
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
  // ("pnpm exec vitest run"), not an argument vector. Still one, lowered:
  // `loweredLine` hands back the same line when nothing is giving way, so the
  // ordinary case is the line the project wrote and nothing else.
  const cwd = check.cwd ? join(project.root, check.cwd) : project.root
  const child = spawn(loweredLine(check.run, opts.giveWay), {
    shell: true,
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...ctx.env, CI: process.env.CI ?? '', TADE_CHECK: check.id },
  })
  const kept = keepTail(opts.tailKept)
  // The disks it writes to: where it runs, and the temp folder it was handed.
  const disk = watchDisk(opts.left, [cwd, ctx.env?.TMPDIR ?? tmpdir()])
  const keep = (chunk: string) => {
    kept.add(chunk)
    disk.heard(chunk)
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

  // Cast rather than annotated: it is set inside `end`, and an annotated null
  // is narrowed to null for good, as if nothing could ever stop the check.
  let outcome = null as 'timed out' | 'cancelled' | null
  // The limit is time awake (`awake.ts`), so it is beaten towards rather than
  // set once: a single timer would count a closed lid against the check.
  const limit = Math.max(1, Math.round(check.minutes * 60_000))
  const began = opts.now()
  let clock = startAwake(began)
  let timer: ReturnType<typeof setTimeout> | undefined
  // Set once the check is gone, so a beat still waiting on the machine's
  // answer when it went neither moves the clock nor stops a dead process.
  let gone = false
  let beating: Promise<void> = Promise.resolve()
  const tick = async () => {
    const at = opts.now()
    let next = awakeAt(clock, at)
    // A gap long enough to be a sleep is asked about now, not only at the end:
    // a loaded machine's late timer with the lid open is time awake, and left
    // out it let the check run past its limit by every such gap.
    if (next.waking.slept !== null) {
      const answer = await opts.asleep(at - next.waking.slept, at)
      if (answer.slept === false) next = awakeAt(clock, at, true)
    }
    if (gone || outcome) return
    clock = next
    if (clock.awake >= limit) void end('timed out')
    else watch()
  }
  const watch = () => {
    timer = setTimeout(
      () => {
        beating = tick()
      },
      Math.min(BEAT_MS, limit - clock.awake),
    )
    timer.unref?.()
  }
  watch()
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
  gone = true
  clearTimeout(timer)
  ctx.signal.removeEventListener('abort', onAbort)
  await beating
  await Promise.race([
    drained,
    new Promise<void>((done) => {
      const drain = setTimeout(done, DRAIN_MS)
      drain.unref?.()
    }),
  ])

  // One more beat at the end: a suite whose own timeouts fired on waking may be
  // gone before the next one, and its failure is the sleep's, not the code's.
  clock = awakeAt(clock, opts.now())
  const said: CheckState = outcome ?? (code === 0 ? 'passed' : 'failed')
  const failing = said === 'failed' || said === 'timed out'
  // A gap in the beats is only a suspicion — a loaded machine fires its timers
  // late with the lid open — so the machine is asked (`slept.ts`), and only its
  // yes calls the run slept. A no, or no answer, leaves it red with its tail.
  const asked = clock.slept && failing ? await opts.asleep(began, opts.now()) : null
  const slept = asked?.slept === true
  // A disk that was full is the machine's too (`OUT_OF_DISK`), and so is not red.
  const look = !slept && failing ? await disk.full(DRAIN_MS) : { full: false, trouble: null }
  const full = look.full
  const state: CheckState = slept || full ? 'cancelled' : said
  // A look that failed leaves the run red, and says why it could not tell.
  const told = look.trouble
    ? `${kept.text()}\n[whether the disk was full could not be told: ${look.trouble}]`
    : kept.text()
  // Said beside the output and never as its summary: the summary is the
  // command's own last word about the code.
  const tail =
    asked && asked.slept === null
      ? `${told}\n[the clock jumped while this ran, and whether the machine slept could not be told: ${asked.trouble}]`
      : told
  const run: CheckLog = {
    ...base,
    state,
    finishedAt: new Date(opts.now()).toISOString(),
    code: outcome ? null : code,
    summary: slept ? SLEPT : full ? OUT_OF_DISK : state === 'passed' ? null : summaryOf(told),
    tail,
    ...namedFailing(kept.failing()),
  }
  ctx.onRun(run)
  return run
}

/** The files a run named as failing, written down only where it named any. */
function namedFailing(failing: Failing): { failing?: Failing } {
  return failing.files.length > 0 || failing.more > 0 ? { failing } : {}
}

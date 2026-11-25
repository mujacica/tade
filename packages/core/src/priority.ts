import { resolveCommand, stringEnv } from './which.ts'

// Who the machine should prefer when there is not enough machine to go round.
//
// Everything Tade starts competes at the same OS priority today: thirteen
// agents, a check suite, the git probes and the window drawing four times a
// second. At load 34 on fourteen cores — which is an ordinary afternoon here,
// not a pathological one — the scheduler has no reason whatever to prefer the
// thread somebody is looking at, so the keystroke waits behind a `tsc`.
//
// The fix is not to raise the window, which needs privilege and is a promise
// about this process that the rest of the machine never agreed to. It is to
// lower everything that is *batch* work: an agent's turn and a check suite
// are things you come back to, and three seconds either way is nothing to
// them, while thirty milliseconds is everything to a cursor.
//
// **What this is, exactly.** One wrapper in front of the command, built of
// programs that each lower the process they are in and then `exec` the rest
// of the line — so one wrapper on the shell is the whole subtree under it,
// and nothing needs privilege, because lowering never does:
//
//   - **`nice`**, POSIX, on every macOS and Linux machine. The floor: where
//     it is missing nothing is lowered, and that is said (`NO_NICE_HERE`).
//   - **`taskpolicy -c utility`**, where the machine has it (macOS). A Mac
//     schedules by QoS first, and a process started from a terminal runs at
//     the default one, the same as every compiler beside it: `nice -n 10`
//     leaves its base priority at 31, a utility clamp takes it to 20 (`ps -o
//     pri` says so, unprivileged, which is what the tests read). With 28
//     busy processes on 14 cores, `ps -axo` from the window went 50 → 90 ms
//     at p50 with the load at the default and back to 49 with it clamped,
//     and keystroke-to-echo p99 1171 ms → 5.7 (`pnpm bench window --lowered`). Utility and not `background` (`-b`, `-c background`): background
//     is base priority 4, efficiency cores only and throttled disk, which is
//     an agent you are waiting on crawling; utility still has the performance
//     cores whenever the window and the frontmost app do not want them, and
//     its disk tier follows its QoS — below the window's, not starved.
//   - **`ionice -c 2 -n 7`**, where the machine has it (Linux, util-linux):
//     best-effort at its lowest level, so the window's `git status` is served
//     ahead of an agent's build on a scheduler that reads I/O priority (BFQ;
//     `none` and `mq-deadline` ignore it, which costs nothing). Best-effort
//     and not idle, because idle can be starved outright by other agents'
//     best-effort I/O, and an agent whose `git add` never completes is an
//     agent that looks hung. No `-t`: busybox's `ionice` has none, and
//     lowering to best-effort is never refused.
//
// Looked for, never decided by platform (`caffeineHold`'s argument): the
// question is whether the program is here.
//
// **Not `os.setPriority`**, which looks tidier and cannot do the job: the
// tmux driver has no pid to set it on at the moment it opens a lane
// (`handle.pid` is null until tmux is asked), setting it after the spawn
// races the shell forking its first child, and Node has no QoS call at all.
// The wrapper is applied before the program starts, by the kernel, and there
// is no window to race.
//
// **Raising the window instead is not possible.** An unprivileged process
// cannot lower its own niceness, and nothing in Node sets a thread's QoS. So
// the window and everything *it* runs for itself — `git` and `ps` for the
// probes, the reaper, the tool host's work, the orchestrator — stay at the
// priority the window was started at, and everything that is batch work is
// put below it. An agent's tool call is answered in the window's own process
// (`harnesses/claude/src/mcp.ts` only relays it), so what an agent asks Tade
// for runs at the window's priority, not the agent's; only the relay itself
// is lowered, with the agent that started it.
//
// **What it does not touch, and why that is the point.** Every one of these
// calls its syscall and then `execvp`, in the same process. So the pid is the
// same pid, the process group is the same group, and `detach()`,
// `shutdown()`, `reaped()` and `process.kill(-pid)` all mean exactly what
// they meant before. There is no extra process to reap and nothing anywhere
// holds a priority — which is what makes this safe to put behind a setting
// somebody can change at any time.
//
// **It is on by default** (`GIVE_WAY_DEFAULT`): a window that goes slow while
// the agents build is the complaint, and the person asked for Tade first in
// so many words. What it costs a check suite is contention with the window
// and the frontmost app, not with the agents, which sit at the same level —
// so a suite's own timeouts compare like with like. 0 turns it off.

/** The programs that lower a process's priority. Nothing else here knows their names. */
export const NICE = 'nice'
/** macOS's: a QoS clamp, which is what the scheduler there actually weighs. */
export const QOS = 'taskpolicy'
/** Linux's (util-linux): the I/O half, which `nice` only implies. */
export const IONICE = 'ionice'

/** What the clamp and the I/O class are, wherever their programs are found. */
const QOS_ARGS = ['-c', 'utility'] as const
const IONICE_ARGS = ['-c', '2', '-n', '7'] as const

/**
 * As far as `nice` goes without privilege, and as far as this will ever ask.
 *
 * POSIX nice runs 0 to 19 for lowering, and 19 is "only when nothing else
 * wants the machine" — which is a real answer for a long check suite and the
 * wrong one for an agent you are waiting on. The schema stops at it; what to
 * actually use is the person's, and the research's starting point is 5.
 */
export const GIVE_WAY_MAX = 19

/**
 * What a config that says nothing gives way by. Halfway down, and well clear
 * of 19: with the QoS clamp doing the work on a Mac, the number is mostly
 * Linux's, where 10 below the window weighs 110 to its 1024 on a contended
 * core (CFS) — the window first, and an agent still making progress.
 */
export const GIVE_WAY_DEFAULT = 10

/**
 * What Tade started, for the one question of whether it gives way.
 *
 * The lane kinds, plus the two things that are started without a lane. Spelled
 * out rather than taken from `LaneKind` so that `checks` and `orchestrator`
 * sit in the same list as the lanes and are answered by the same function —
 * the whole value of this being one table is that nobody has to remember that
 * the orchestrator is not a lane.
 */
export type Started =
  | 'agent'
  | 'checks'
  | 'orchestrator'
  | 'server'
  | 'shell'
  | 'terminal'
  | 'tests'

/**
 * What gives way, and nothing else.
 *
 * **`agent` and the two spellings of a check suite.** An agent's turn and a
 * check run are the batch half of Tade: nobody is watching a character appear
 * in them, and both are already measured in minutes. `tests` is the lane kind
 * a check suite gets when it is run in one, `checks` is the same work run
 * without a lane; they are one answer under two names because the thing that
 * matters is what the work is, not how it is being watched.
 *
 * **The orchestrator never does, and that is the one entry here that is a
 * rule rather than a preference.** It is the thing you are talking to: every
 * word of its answer is latency you sit through, and it is the single process
 * whose turn a person actually waits on. Lowering it would make the one part
 * of Tade that feels like a conversation feel like a queue — which is the
 * opposite of what any of this is for. Nothing on its launch path takes a
 * priority at all (`WorkerAdapter.start`), so this is belt as well as braces.
 *
 * **A `shell` or a `terminal` never does either**, for the same reason as the
 * orchestrator and for one more: it is a person's own command line, and a
 * window that quietly ran everything you typed at a lower priority than
 * itself would be a window that lies about why your build is slow.
 *
 * **A `server` does not**, because a dev server is something somebody is
 * refreshing a browser against. It is the one here that could be argued the
 * other way, and the argument is not strong enough to make a reload slow
 * without being asked.
 */
const GIVES_WAY: ReadonlySet<Started> = new Set<Started>(['agent', 'checks', 'tests'])

/** What `nice` here means, in the one sentence read wherever somebody is deciding. */
export const GIVE_WAY_MEANS =
  'agents and check runs are started below the window — nice, plus a utility QoS clamp on macOS and best-effort ionice on Linux — so the window and its own git and ps stay quick while the machine is busy; 0 is off, and it applies to the next one started'

/**
 * Why nothing gives way here, where something was asked to and cannot.
 *
 * Said rather than swallowed, and in the shape `NO_HOLD_HERE` is: what is
 * missing, and what happens instead — which is simply what happened before
 * anybody asked, so nothing is broken by it.
 */
export const NO_NICE_HERE = `nothing here lowers a process's priority — ${NICE} is POSIX and is not on this machine, so agents and check runs go on sharing it with the window`

/** Where `nice` is, or null where this machine has none. */
function niceAt(env: NodeJS.ProcessEnv): string | null {
  // Looked for rather than decided by platform, which is `caffeineHold`'s
  // argument: the question is whether the program is here, and a machine that
  // has it can lower a process whatever it calls itself. Windows answers null
  // and so never gives way, which is the honest answer rather than a guess at
  // what its priority classes would mean.
  return resolveCommand(NICE, stringEnv(env))
}

/** How much something gives way here, and why it does not where it cannot. */
export interface GivesWay {
  /** Nice steps below the window. 0 is "not at all", and is always a valid answer. */
  by: number
  /**
   * What goes in front of the command to lower it, as an argument vector:
   * `nice`, and the clamp and the I/O class where this machine has them.
   * Empty exactly when `by` is 0.
   */
  wrap: readonly string[]
  /** Why `by` is 0 although something was asked for. Null whenever nothing is wrong. */
  problem: string | null
}

/** Nothing gives way: the answer for what a person is waiting on, and for off. */
export const KEEPS_PACE: GivesWay = { by: 0, wrap: [], problem: null }

/**
 * How much what Tade is about to start should give way to the window.
 *
 * Three ways to come back with nothing, and only the last of them is a
 * problem: what a person is waiting on never gives way whatever is asked
 * (`GIVES_WAY`), nothing was asked for, or something was asked for and this
 * machine has no `nice` to do it with.
 *
 * `asked` is clamped rather than refused. It arrives from a config file that
 * has already been through the schema, so a value out of range means somebody
 * reached past the schema — and a launch is the wrong place to turn that into
 * an agent that will not start.
 */
export function givesWay(
  what: Started,
  asked: number,
  env: NodeJS.ProcessEnv = process.env,
): GivesWay {
  if (!GIVES_WAY.has(what) || !Number.isFinite(asked) || asked <= 0) return KEEPS_PACE
  if (niceAt(env) === null) return { ...KEEPS_PACE, problem: NO_NICE_HERE }
  const by = Math.min(Math.round(asked), GIVE_WAY_MAX)
  // `round` can come back with nought from a fraction below a half, which is
  // off and not "nice by nought".
  if (by <= 0) return KEEPS_PACE
  const here = (program: string) => resolveCommand(program, stringEnv(env)) !== null
  const wrap = [
    NICE,
    '-n',
    String(by),
    ...(here(QOS) ? [QOS, ...QOS_ARGS] : []),
    ...(here(IONICE) ? [IONICE, ...IONICE_ARGS] : []),
  ]
  return { by, wrap, problem: null }
}

/** A command as something starts it: what to run, and the arguments it is run with. */
export interface Launched {
  command: string
  args: readonly string[]
}

/**
 * The same launch, lowered.
 *
 * Pure, and `way` is what `givesWay` already answered — so a caller that has
 * not asked it cannot accidentally wrap something that should never be
 * wrapped. An empty wrap hands back exactly what it was given, which is what
 * makes "the setting is off" the same code path as "there is no setting".
 */
export function lowered<T extends Launched>(
  launch: T,
  way: Pick<GivesWay, 'wrap'>,
): T & { args: string[] } {
  const args = [...launch.args]
  const [first, ...rest] = way.wrap
  if (first === undefined) return { ...launch, args }
  return { ...launch, command: first, args: [...rest, launch.command, ...args] }
}

/**
 * The shell a command line is handed to, spelled out.
 *
 * This is exactly what `spawn(line, { shell: true })` does on a POSIX machine.
 * It is named here because `lowered` can only lower a command it is handed, and
 * what has to give way for a check is the shell *and everything under it*: a
 * line like `a && b` runs `b` as a child of the shell, so nicing the first
 * word of it would lower one half of a check and leave the other alone.
 */
const SHELL = '/bin/sh'

/** A string as a single shell word, however many quotes are in it. */
function quoted(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * A command line for a shell to run, lowered — the same line when nothing gives way.
 *
 * The other shape of `lowered`, for the place a command is a line somebody
 * would type rather than an argument vector. It stays a line, so the caller
 * goes on using the shell it already used and nothing about quoting, globbing
 * or `&&` changes; `exec` is there so the pid that ends up niced is the pid
 * the caller is holding, which is what keeps `process.kill(-pid)` reaching
 * the whole of a check.
 */
export function loweredLine(line: string, way: Pick<GivesWay, 'wrap'>): string {
  if (way.wrap.length === 0) return line
  const { command, args } = lowered({ command: SHELL, args: ['-c', line] }, way)
  return `exec ${[command, ...args].map(quoted).join(' ')}`
}

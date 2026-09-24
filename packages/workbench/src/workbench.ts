import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MANIFEST_PATH, readRuns } from '@tade/checks-core'
import {
  AccountName,
  type Caution,
  type Config,
  ConfigSchema,
  checkBudget,
  type checksFor,
  composeAgentPrompt,
  type DoneRule,
  type EventFilter,
  expandHome,
  HARNESS_CHOICES,
  type HarnessId,
  type LaneId,
  loadConfig,
  modelDetail,
  modelLastRunOn,
  type Note,
  noSpend,
  type Plan,
  type PlanBusy,
  type PlanSource,
  PROJECT_DIR,
  parseConfig,
  type QueueChange,
  resolveRoute,
  routeIn,
  runtimeDir,
  type SandboxKind,
  type Schedule,
  type StartCondition,
  sinceLastLook,
  spendFrom,
  startOfToday,
  type TadeEvent,
  type TaskId,
  THINKING_LEVELS,
  type ThinkingLevel,
  type Unsubscribe,
  workspaceFor,
  writeSetting,
} from '@tade/core'
import type {
  LaneScreen,
  PointerReport,
  WheelTurn,
  WorkspaceCapabilities,
  WorkspaceDriver,
} from '@tade/drivers-core'
import {
  type HarnessAccount,
  type HarnessModels,
  modelsOffered,
  noHarnessSpend,
  offer,
  type PermissionDecision,
  type RunId,
  type SignIn,
  type Support,
  type WorkerAdapter,
  type WorkerCapabilities,
  type WorkerExtras,
  type WorkerHandle,
  type WorkerModel,
} from '@tade/harnesses-core'
import { git, readCommits } from '@tade/status'
import type { Reporter } from '@tade/telemetry'
import { parse as parseYaml } from 'yaml'
import { type AccountView, harnessAccount, listAccounts, planWindows } from './accounts.ts'
import { recordAuthored } from './authored.ts'
import { checksAt, checksGate } from './checks.ts'
import { EventLog, readJournal } from './events.ts'
import {
  accountKey,
  adapterKey,
  adapterParts,
  HARNESS_ADAPTERS,
  type HarnessOptions,
} from './harnesses.ts'
import { ensureIgnored, IGNORE_PATH } from './ignore.ts'
import { type HomeLock, lockHome } from './lock.ts'
import { Memory } from './memory.ts'
import { makePlan, type PlanMade } from './plans.ts'
import { drivers, type LaneRecord, LaneRegistry, type SpawnRequest } from './registry.ts'
import { type KeptSchedule, Schedules } from './schedules.ts'
import {
  beginFrom,
  branchSlug,
  createTask,
  nameTask,
  type RemoveResult,
  readTaskFile,
  removeTask,
  setParked,
  setTaskAccount,
  setTaskHarness,
  setTitle,
  type TaskWorktree,
  taskContextPath,
  taskFilePath,
} from './tasks.ts'
import {
  findTerminal,
  matchingLines,
  nextTerminal,
  type TerminalInfo,
  terminalsFrom,
} from './terminals.ts'
import {
  type ExtensionCall,
  type PendingApproval,
  type RunVitals,
  type StartRunRequest,
  WorkerSupervisor,
} from './workers.ts'

// The workbench: everything Tade is holding while it is open — the lanes, the
// journal, the agents under supervision, the notes.
//
// It is an object, not a service. There is no server here because there is
// nothing left for one to guard: what is running is the driver's to report,
// what happened is the journal's, what the work looks like is git's. Closing
// the workbench lets go of all of it and stops none of it.

export interface WorkbenchOptions {
  home: string
  /** Overrides `workspace.driver`. Mostly for tests. */
  driver?: string
  version?: string
  /**
   * Where the harness keeps its sessions, for reading back what an agent spent
   * while nobody was watching. Defaults to the harness's own location, which
   * is where agents write because Tade deliberately does not move them.
   */
  sessionsRoot?: string
  /** Whose home harnesses find their own sign-ins in: for tests, so none reads yours. */
  harnessHome?: string
  /**
   * What extensions give agents: extras at launch, and a way to run the tools
   * they call. Passed in, so the workbench never has to know what an extension
   * is — only that there may be more to hand an agent than its prompt.
   */
  extensions?: WorkbenchExtensions
  /**
   * Where Tade's own trouble goes. Nothing is sent unless the window opened
   * one that sends; what it is for here is timing agents' turns.
   */
  report?: Reporter
}

export interface WorkbenchExtensions {
  /**
   * What an agent starting on a task in this project gets besides its prompt,
   * in terms of the harness it runs in.
   */
  extras(target: {
    project: string
    task: string
    cwd: string
    harness: string
  }): WorkerExtras | undefined
  /** Run a tool an agent called. Throws with the reason it could not. */
  call(call: ExtensionCall & { project: string }): Promise<string>
  /**
   * What the extensions make of a command an agent is held at, for what the
   * approval rules do not name. Only ever stricter, never an allow, and given
   * a deadline by whoever answers: an agent is waiting on it.
   */
  caution(request: {
    project: string
    task: string
    worktree: string
    tool: string
    command: string
    input: Readonly<Record<string, unknown>>
    decided: { tier: 'auto' | 'soft' | 'hard'; rule: string; reason: string }
    signal: AbortSignal
  }): Promise<{ caution: Caution | null; problems: readonly string[] }>
}

export interface WorkbenchInfo {
  pid: number
  version: string
  driver: string
  capabilities: WorkspaceCapabilities
  home: string
  openedAt: number
  lanes: number
  runs: number
  approvals: string
}

export interface CreateTaskRequest {
  project: string
  slug: string
  intent: string
  /** Defaults to the project's configured root. */
  root?: string
  base?: string
  /** No branch until there is work to name it after. */
  detached?: boolean
  /** What the agent should know before it starts: written to `.tade/context.md`. */
  context?: string
  /** Where the work came from, kept with the task and shown beside it. */
  links?: readonly { title: string; url: string }[]
  /** Where the agent works; the project's own answer (`workspaceFor`) unless said. */
  workspace?: 'checkout' | 'worktree'
  /** The change this task is one repository's share of, by its slug. */
  effort?: string
  /** Who asked for it, as `TaskOrigin` says it: kept with the task and in the journal. */
  by?: string
  /** How it counts as finished; `said` unless chosen. */
  done?: DoneRule
  /** When it starts: after other tasks, not before a time. Made now, started by the queue. */
  start?: StartCondition
}

/**
 * How many commits one look at a project reads, at the most.
 *
 * A bound rather than a window: the look is already limited to commits since
 * the last one written down, and this is what stops a machine that was shut
 * for a fortnight from reading a year of history to find them.
 */
const COMMITS_SEEN = 200

export interface RemoveTaskRequest {
  root: string
  worktree: string
  branch: string
  /** The task's id: what finds a task that shares the checkout. */
  task?: string
  force?: boolean
}

/**
 * The driver lanes will live in.
 *
 * A driver the machine cannot provide is not a dead end — `workspace.fallback`
 * says where to go instead — but it is never silent: agents quietly losing the
 * ability to outlive the window is the kind of thing you would discover at the
 * worst possible moment. Set `fallback` to the same driver to refuse instead.
 */
export async function chooseDriver(opts: {
  wanted: string
  fallback: string
  home: string
  /** Injectable so the choice can be tested without uninstalling anything. */
  registry?: Record<string, (home: string) => WorkspaceDriver>
}): Promise<{ driver: WorkspaceDriver; warning: string }> {
  const registry = opts.registry ?? drivers
  const make = registry[opts.wanted]
  if (!make) throw new Error(`unknown workspace driver: ${opts.wanted}`)
  const driver = make(opts.home)
  const availability = await driver.available()
  if (availability.ok) return { driver, warning: '' }

  const makeFallback = opts.fallback === opts.wanted ? undefined : registry[opts.fallback]
  if (!makeFallback) {
    throw new Error(`workspace.driver is ${opts.wanted}, and ${availability.reason}`)
  }
  const fallback = makeFallback(opts.home)
  const second = await fallback.available()
  if (!second.ok) throw new Error(`neither ${opts.wanted} nor ${opts.fallback} can run here`)
  return {
    driver: fallback,
    warning:
      `workspace.driver is ${opts.wanted}, and ${availability.reason}. ` +
      `Using ${opts.fallback} instead` +
      (fallback.capabilities.detach ? '.' : ', so agents will not outlive this window.'),
  }
}

export class Workbench {
  readonly home: string
  readonly log: EventLog
  readonly registry: LaneRegistry
  readonly driver: WorkspaceDriver
  readonly workers: WorkerSupervisor
  /** The config as it was opened, and as the window has changed it since. */
  config: Config
  private readonly memory: Memory
  /** The schedules as told: `kept` rather than `schedules`, which is the method that lists them. */
  private readonly kept: Schedules
  private readonly lock: HomeLock
  private readonly version: string
  /** One adapter per harness there is, the same ones the supervisor answers runs with. */
  private readonly adapters: Record<string, WorkerAdapter>
  /** How an adapter is made, for an account's, which is made the first time it is needed. */
  private readonly harnessOptions: HarnessOptions
  private readonly openedAt = Date.now()
  private closing: Promise<void> | null = null
  private readonly extensions: WorkbenchExtensions | null

  private constructor(opts: {
    home: string
    version: string
    driver: WorkspaceDriver
    log: EventLog
    registry: LaneRegistry
    workers: WorkerSupervisor
    config: Config
    lock: HomeLock
    adapters: Record<string, WorkerAdapter>
    harnessOptions: HarnessOptions
    extensions?: WorkbenchExtensions
  }) {
    this.home = opts.home
    this.adapters = opts.adapters
    this.harnessOptions = opts.harnessOptions
    this.version = opts.version
    this.driver = opts.driver
    this.log = opts.log
    this.registry = opts.registry
    this.workers = opts.workers
    this.config = opts.config
    this.lock = opts.lock
    this.memory = Memory.open(opts.home)
    this.kept = Schedules.open(opts.home)
    this.extensions = opts.extensions ?? null
  }

  static async open(opts: WorkbenchOptions): Promise<Workbench> {
    await mkdir(opts.home, { recursive: true })
    const lock = await lockHome(opts.home)
    // Kept out here so the failure path can close it: an open that got as far
    // as the journal and then went wrong — no driver, a registry that would not
    // load — used to release the lock and leave the file behind, which is the
    // descriptor `doClose` says the garbage collector now throws about.
    let journal: EventLog | null = null
    try {
      // A broken config must not stop Tade opening; `tade config --check` is
      // where a typo gets reported, so here it degrades to defaults.
      const loaded = await loadConfig(join(opts.home, 'config.yaml'))
      const config = loaded.ok ? loaded.config : ConfigSchema.parse({})
      const log = await EventLog.open({ path: join(opts.home, 'events.jsonl') })
      journal = log
      const { driver, warning } = await chooseDriver({
        wanted: opts.driver ?? config.workspace.driver,
        fallback: config.workspace.fallback,
        home: opts.home,
      })
      if (warning) await log.append({ type: 'warning', detail: { message: warning } })
      const registry = await LaneRegistry.open({ driver, log, path: join(opts.home, 'lanes.json') })
      if (!loaded.ok) {
        await log.append({
          type: 'warning',
          detail: {
            message: `config.yaml is invalid, using defaults: ${loaded.issues[0]?.message ?? ''}`,
          },
        })
      }
      // One adapter per harness there is; the route's is the default.
      const harnessOptions: HarnessOptions = {
        runDir: join(opts.home, 'runs'),
        socketDir: runtimeDir(opts.home),
        approvals: config.approvals.mode,
        ...(opts.sessionsRoot ? { sessionsRoot: opts.sessionsRoot } : {}),
        ...(opts.harnessHome ? { home: opts.harnessHome } : {}),
        // Into the agent's own lane, through its driver: nothing else reaches it.
        type: (run: RunId, text: string) =>
          registry.write(run as unknown as LaneId, Buffer.from(text, 'utf8')),
        onWarning: (message: string) => {
          void log.append({ type: 'warning', detail: { message } }).catch(() => {})
        },
      }
      const adapters: Record<string, WorkerAdapter> = Object.fromEntries(
        Object.entries(HARNESS_ADAPTERS).map(([id, make]) => [id, make(harnessOptions)]),
      )
      const defaultHarness = config.workers.routes[config.workers.default]?.harness ?? 'pi'
      const fallback = adapters[defaultHarness] ?? adapters.pi
      if (!fallback) throw new Error(`no harness called ${defaultHarness}`)
      const workers = new WorkerSupervisor({
        adapter: fallback,
        adapters,
        log,
        approvals: {
          mode: config.approvals.mode,
          autoAllow: config.approvals.auto_allow,
          rules: config.approvals.rules,
        },
        ...(opts.report ? { report: opts.report } : {}),
        // The checks rule: a push with nothing green behind it comes back
        // refused, with what is missing and the call that fixes it.
        checks: checksGate({
          config,
          events: () => readJournal(opts.home, { types: ['tool_call'] }).catch(() => []),
          head: async (worktree) => {
            const head = await git(worktree, ['rev-parse', 'HEAD'])
            return head.ok ? head.stdout.trim() : null
          },
        }),
        // Written into the task, not held: the branch may be named long after,
        // by a window opened later.
        onTitle: (task, worktree, title, named) => {
          void setTitle(worktree, title, named, task).catch(() => {})
        },
        // A tool an agent calls runs in this process, where the extensions are.
        onExtensionCall: async (call) => {
          if (!opts.extensions) throw new Error('Tade has no extensions loaded')
          return opts.extensions.call({ ...call, project: call.task.split('/')[0] ?? '' })
        },
        // And so does a second reading of what it is about to run. Left out
        // where there are no extensions, which is the gate Tade has on its own.
        ...(opts.extensions
          ? {
              caution: (call: Parameters<WorkbenchExtensions['caution']>[0]) =>
                opts.extensions!.caution(call),
            }
          : {}),
      })

      const workbench = new Workbench({
        home: opts.home,
        version: opts.version ?? '0.0.0',
        driver,
        log,
        registry,
        workers,
        config,
        lock,
        adapters,
        harnessOptions,
        ...(opts.extensions ? { extensions: opts.extensions } : {}),
      })
      await log.append({
        type: 'tade_opened',
        detail: { pid: process.pid, driver: driver.id, lanes: registry.list().length },
      })
      // Pick the agents that kept working back up: the channel first, so their
      // extensions can reconnect, then the spend that went unreported while
      // there was nothing for them to report to. Neither is fatal.
      // Anything an agent wrote for itself while nobody was looking gets a
      // commit now, so it is reviewable rather than merely present.
      await recordAuthored(
        expandHome(config.orchestrator.extensions),
        'tools written since Tade was last open',
      )
      await recordAuthored(join(opts.home, 'skills'), 'lessons proposed since Tade was last open')
      await workbench.resupervise().catch(() => {})
      await workbench.reconcileSpend().catch(() => {})
      await workbench.lookAtCommits().catch(() => {})
      await workbench.lookAtChecks().catch(() => {})
      return workbench
    } catch (err) {
      await journal?.close().catch(() => {})
      await lock.release()
      throw err
    }
  }

  /**
   * Open the channel again for agents that were already working.
   *
   * An agent whose window closed has an extension dialling for a socket that
   * is no longer there. Putting it back is what makes reopening whole rather
   * than partial: without it a surviving agent can be typed at and nothing
   * else — no journal, no spend as it happens, and under `policy` a gate with
   * nobody at the other end, which refuses everything.
   */
  private async resupervise(): Promise<void> {
    for (const lane of this.registry.list()) {
      if (lane.kind !== 'agent' || !lane.alive) continue
      // By the harness it was started in: another adapter would listen on a
      // channel its agent never dials.
      const harness = lane.harness ?? (await this.harnessOf(lane.task, lane.spec.cwd))
      // And the account it was started on, whose adapter is made again here.
      const resumed = await Promise.resolve()
        .then(() => this.adapterFor(harness, lane.account))
        .then(() =>
          this.workers.resume({
            task: lane.task as never,
            run: lane.id as RunId,
            cwd: lane.spec.cwd,
            prompt: '',
            harness: adapterKey(harness, lane.account),
          }),
        )
        .catch(() => null)
      if (resumed) this.followExit(lane.id as LaneId)
    }
  }

  /**
   * Tell the supervisor when an agent's lane ends. The lane is the only thing
   * that sees it: an agent running in a terminal takes its channel down with
   * it, so it never gets to say it exited.
   */
  private followExit(lane: LaneId): void {
    const stop = this.registry.onExit(lane, ({ code }) => {
      stop()
      void this.workers.gone(lane as unknown as RunId, code)
    })
  }

  /**
   * Account for what the agents spent while nobody was watching.
   *
   * The supervision extension reports each turn as it happens, but only while
   * Tade is there to be told — and under a driver whose lanes outlive the
   * window, it often is not. A harness writes every message to its own record
   * regardless, so on opening we compare what that says against what the
   * journal already knows and record the difference. The harness's record is
   * the ledger; the journal is a copy of it that can fall behind.
   *
   * Best effort by design: a session we cannot read leaves the accounting
   * short, which is a worse answer than the truth and a far better one than
   * refusing to open.
   */
  private async reconcileSpend(): Promise<void> {
    const journalled = spendFrom(await this.log.read({ types: ['usage'] }).catch(() => []))
    for (const lane of this.registry.list()) {
      if (lane.kind !== 'agent') continue
      const harness = lane.harness ?? (await this.harnessOf(lane.task, lane.spec.cwd))
      const adapter = await Promise.resolve()
        .then(() => this.adapterFor(harness, lane.account))
        .catch(() => null)
      const session = await Promise.resolve()
        .then(() => adapter?.spent(lane.task as TaskId, lane.spec.cwd) ?? noHarnessSpend())
        .catch(() => noHarnessSpend())
      if (session.messages === 0) continue
      const known = journalled.byTask[lane.task] ?? noSpend()
      // What this harness's dollars are worth, so money it cannot price is
      // never reconciled into the journal: what the journal read of a plan's
      // turns is nothing, so the difference would be the whole session,
      // written again at every open and never closing. Tokens either way.
      const prices = adapter?.capabilities.spend.usd !== 'none'
      // Each measure on its own, never below nothing: a harness whose record
      // keeps tokens and no prices (Claude Code's) knows less money than the
      // journal was told live, and that is not a refund.
      const missing = {
        input: Math.max(0, session.input - known.input),
        output: Math.max(0, session.output - known.output),
        cacheRead: Math.max(0, session.cacheRead - known.cacheRead),
        cacheWrite: Math.max(0, session.cacheWrite - known.cacheWrite),
        tokens: Math.max(0, session.tokens - known.tokens),
        usd: prices ? Math.max(0, session.usd - known.usd) : 0,
      }
      // Only ever forward. The journal knowing more than the session means the
      // session was trimmed or replaced, and inventing a negative charge to
      // make the two agree would corrupt every total that reads it.
      if (missing.tokens <= 0 && missing.usd <= 0) continue
      await this.log.append({
        type: 'usage',
        task: lane.task,
        detail: {
          ...missing,
          // What it last ran on, so the spend lands on a model rather than on
          // the bucket for nothing recorded — written the one way every other
          // writer writes it, or money found later would be a row of its own.
          ...modelDetail(session.model),
          priced: adapter?.capabilities.spend.usd ?? 'estimate',
          // And whose it was: the lane says which harness and which sign-in,
          // so money found later is filed exactly where the live turns were.
          harness,
          ...(lane.account ? { account: lane.account } : {}),
          source: 'session',
          reason: 'spent while Tade was closed',
        },
      })
    }
  }

  /**
   * Write down commits nobody has written down yet, once each.
   *
   * How much an agent actually wrote is the one statistic that cannot be
   * answered by asking again later. `git log` is a query, and every answer it
   * gives changes: a rebase rewrites the shas, a squash merge collapses ten
   * commits into one, and removing a worktree takes the whole history of that
   * branch with it. So the count is kept at the moment it is true, keyed by
   * sha, which is exactly what `watch_found` does for a watch — the journal is
   * the record, and nothing here holds one of its own.
   *
   * Only commits since the last one written down. On a machine that has never
   * run Tade that means nothing at all: a project's first open would otherwise
   * dump years of somebody else's history into today, and a chart that spikes
   * on the day you installed something is a chart nobody trusts again.
   *
   * Best effort throughout. A project whose root has moved, a checkout that is
   * not a repository and a git that will not run are all the same answer as a
   * project with no new commits, because counting things may never be why a
   * window fails to open.
   */
  async lookAtCommits(): Promise<void> {
    const written = await this.log.read({ types: ['commit_seen'] }).catch(() => [])
    const seen = new Set<string>()
    for (const event of written) {
      const sha = event.detail.sha
      if (typeof sha === 'string') seen.add(sha)
    }
    // Where to start: `sinceLastLook`'s to decide, and the one part of this
    // worth testing on its own.
    const newest = sinceLastLook(
      written,
      written.length > 0 ? [] : await this.log.read({ types: ['tade_opened'] }).catch(() => []),
    )
    // A second of overlap, because git's `--since` is granular to the second
    // and a commit made in the same second as the boundary would fall the
    // wrong side of it. Overlapping costs nothing: the sha decides what is
    // new, not the window.
    const since = (newest === 0 ? Date.now() : newest) - 1_000
    for (const [project, settings] of Object.entries(this.config.projects)) {
      const root = settings?.root
      if (!root) continue
      const commits = await readCommits(root, { limit: COMMITS_SEEN, since }).catch(() => [])
      // Oldest first, so the journal reads in the order the work happened.
      for (const commit of [...commits].reverse()) {
        if (seen.has(commit.sha)) continue
        seen.add(commit.sha)
        await this.log
          .append({
            type: 'commit_seen',
            // Whose it is, is the trailer's to say. A commit without one is
            // nobody's, and is counted as the project's rather than guessed on
            // to whichever agent happened to be running when it landed.
            task: commit.task,
            detail: {
              sha: commit.sha,
              project,
              // When it actually landed, which is not when we noticed: a
              // window that opens on Tuesday and catches up Monday's work
              // would otherwise put Monday's commits in Tuesday's total.
              at: commit.at,
              attributed: commit.task !== null,
              added: commit.added,
              removed: commit.removed,
              files: commit.files,
            },
          })
          .catch(() => {})
      }
    }
  }

  /**
   * Write down check runs nobody has written down yet, once each.
   *
   * A run is already kept where it ran — `.tade/checks.jsonl` in that worktree
   * — but that file rotates at a couple of hundred runs and goes entirely when
   * the worktree does, which is the moment the work is merged and cleaned up.
   * So "how often does `types` fail, and how long does it take" would be
   * answerable only about work still in progress, which is the opposite of the
   * question.
   *
   * Read rather than written at the moment of running, for the same reason
   * commits are: `tade check` on the command line runs with no window, and a
   * second writer in one journal would interleave with the window's. The run
   * it wrote is picked up by whichever window opens next, keyed by the run's
   * own id, so nothing is counted twice and nothing is missed because nobody
   * was watching.
   */
  async lookAtChecks(): Promise<void> {
    const written = await this.log.read({ types: ['check_ran'] }).catch(() => [])
    const seen = new Set<string>()
    for (const event of written) {
      const id = event.detail.run
      if (typeof id === 'string') seen.add(id)
    }
    // Every worktree that could hold runs: a project's own checkout, and each
    // agent's, which in `worktree` mode is where its checks actually ran.
    const roots = new Map<string, string | null>()
    for (const settings of Object.values(this.config.projects)) {
      if (settings?.root) roots.set(settings.root, null)
    }
    for (const lane of this.registry.list()) {
      if (lane.kind === 'agent') roots.set(lane.spec.cwd, lane.task)
    }
    for (const [root, task] of roots) {
      const runs = await readRuns(root).catch(() => [])
      for (const run of runs) {
        if (seen.has(run.id)) continue
        seen.add(run.id)
        const started = Date.parse(run.startedAt ?? '')
        const finished = Date.parse(run.finishedAt ?? '')
        const ms =
          Number.isFinite(started) && Number.isFinite(finished) && finished >= started
            ? finished - started
            : null
        await this.log
          .append({
            type: 'check_ran',
            task,
            detail: {
              run: run.id,
              check: run.check,
              state: run.state,
              required: run.required,
              where: run.where.kind,
              runner: run.where.kind === 'here' ? run.where.runner : run.where.forge,
              by: run.by ?? 'unknown',
              // When it ran, not when this window read it out of the file: a
              // run from yesterday picked up at today's open is yesterday's.
              ...(Number.isFinite(finished)
                ? { at: finished }
                : Number.isFinite(started)
                  ? { at: started }
                  : {}),
              ...(ms === null ? {} : { ms }),
            },
          })
          .catch(() => {})
      }
    }
  }

  /**
   * How much of each account's plan is used, as its harness last said, beside
   * what that harness is able to say at all.
   *
   * Never asks anybody: a harness that is told its own limits keeps the last
   * answer it was given, and this reads it. Anything that reached out here
   * would be a network call on the window's beat, which is the thing that must
   * not happen.
   *
   * Every account that has an adapter is reported, the ones with nothing to
   * say included: "none used" and "cannot know" are different answers, only
   * one of them is good news, and which it is, is `planStandings`' to decide
   * from the harness's own declaration rather than from an empty figure. An
   * account nothing has needed yet has no adapter and is absent, which says
   * the same thing — nothing has run as it, so nothing has been said.
   */
  planUsage(): PlanSource[] {
    return Object.entries(this.adapters).map(([key, adapter]) => {
      const can = adapter.capabilities.spend.limits
      const said = can === 'none' ? null : adapter.limits()
      return {
        ...adapterParts(key),
        can,
        why: adapter.capabilities.why.limits ?? null,
        said: said ? { at: said.at, windows: planWindows(said) } : null,
      }
    })
  }

  info(): WorkbenchInfo {
    return {
      pid: process.pid,
      version: this.version,
      driver: this.driver.id,
      capabilities: { ...this.driver.capabilities },
      home: this.home,
      openedAt: this.openedAt,
      lanes: this.registry.list().filter((l) => l.alive).length,
      runs: this.workers.list().length,
      approvals: this.config.approvals.mode,
    }
  }

  // --- lanes
  //
  // Thin by design: the registry is the thing that knows about lanes, and
  // these exist so callers say `tade.capture(lane)` rather than reaching
  // through two objects to get there.

  spawn(req: SpawnRequest): Promise<LaneRecord> {
    return this.registry.spawn(req)
  }

  /** Start a lane again from its stored spec, after it went away. */
  relaunch(lane: LaneId): Promise<LaneRecord> {
    return this.registry.relaunch(lane)
  }

  lanes(task?: string): LaneRecord[] {
    return this.registry.list(task)
  }

  lane(id: LaneId): LaneRecord | null {
    return this.registry.get(id)
  }

  write(lane: LaneId, data: Uint8Array | string): Promise<void> {
    return this.registry.write(lane, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
  }

  /** The lane's screen. `styled` keeps its colour, for drawing it the way it looks. */
  capture(lane: LaneId, lines = 100, styled = false): Promise<string> {
    return this.registry.capture(lane, lines, styled)
  }

  /** How far back that screen can be read, where typing appears, and whose the scrolling is. */
  screen(lane: LaneId): Promise<LaneScreen> {
    return this.registry.screen(lane)
  }

  /** Turn the wheel over a lane whose program scrolls itself. */
  wheel(lane: LaneId, turn: WheelTurn): Promise<void> {
    return this.registry.wheel(lane, turn)
  }

  /** Tell a lane what the pointer did, for a program that answers it itself. */
  point(lane: LaneId, report: PointerReport): Promise<void> {
    return this.registry.point(lane, report)
  }

  resize(lane: LaneId, cols: number, rows: number): Promise<void> {
    return this.registry.resize(lane, cols, rows)
  }

  setTitle(lane: LaneId, title: string): Promise<void> {
    return this.registry.setTitle(lane, title)
  }

  // --- terminals

  /** The terminals open now, in one project or all of them. */
  terminals(project?: string): TerminalInfo[] {
    return terminalsFrom(this.registry.list(), project)
  }

  /**
   * Open a terminal: a login shell in the project's folder, or wherever you
   * say. Called `terminal <n>` unless you name it.
   */
  async openTerminal(req: {
    project: string
    cwd?: string
    name?: string
    cols?: number
    rows?: number
  }): Promise<TerminalInfo> {
    const configured = this.config.projects[req.project]
    const cwd = req.cwd ?? (configured ? expandHome(configured.root) : undefined)
    if (!cwd) throw new Error(`unknown project "${req.project}"`)
    const next = nextTerminal(req.project, this.registry.list())
    const name = req.name?.trim() || next.name
    await this.registry.spawn({
      id: next.id as LaneId,
      task: `${req.project}/terminals`,
      kind: 'terminal',
      cwd,
      command: process.env.SHELL ?? '/bin/sh',
      args: ['-l'],
      ...(req.cols ? { cols: req.cols } : {}),
      ...(req.rows ? { rows: req.rows } : {}),
      title: name,
    })
    const opened = this.terminals(req.project).find((terminal) => terminal.id === next.id)
    if (!opened) throw new Error(`the terminal did not start in ${cwd}`)
    return opened
  }

  /**
   * The terminal somebody meant: an id, a name, a number — within a project
   * when one is given. Throws with the choices when it could be several.
   */
  terminal(said: string | null | undefined, project?: string): TerminalInfo {
    const all = this.terminals(project)
    const exact = all.find((terminal) => terminal.id === said)
    const found = exact ?? findTerminal(all, said)
    if (found) return found
    if (all.length === 0) throw new Error('no terminal is open')
    throw new Error(`which terminal? ${all.map((terminal) => terminal.name).join(', ')}`)
  }

  async renameTerminal(said: string, name: string, project?: string): Promise<TerminalInfo> {
    const terminal = this.terminal(said, project)
    const text = name.trim()
    if (!text) throw new Error('a terminal needs a name')
    await this.registry.setTitle(terminal.id as LaneId, text)
    return { ...terminal, name: text }
  }

  async closeTerminal(said: string, project?: string): Promise<TerminalInfo> {
    const terminal = this.terminal(said, project)
    await this.registry.close(terminal.id as LaneId)
    return terminal
  }

  /**
   * Type a command into a terminal, and press enter unless told not to. What
   * runs is exactly what a person typing it would have run, in the shell
   * they can see.
   */
  async runInTerminal(
    said: string,
    command: string,
    opts: { submit?: boolean; project?: string } = {},
  ): Promise<TerminalInfo> {
    const terminal = this.terminal(said, opts.project)
    const text = command.replace(/[\r\n]+$/, '')
    await this.registry.write(
      terminal.id as LaneId,
      Buffer.from(opts.submit === false ? text : `${text}\r`, 'utf8'),
    )
    return terminal
  }

  /** What a terminal shows, and as much of its scrollback as asked for, as plain text. */
  async readTerminal(said: string, lines = 200, project?: string): Promise<string> {
    const terminal = this.terminal(said, project)
    return this.registry.capture(terminal.id as LaneId, lines, false)
  }

  /** Lines in a terminal's scrollback containing some text. */
  async searchTerminal(
    said: string,
    text: string,
    project?: string,
  ): Promise<{ terminal: TerminalInfo; matches: { line: number; text: string }[] }> {
    const terminal = this.terminal(said, project)
    const screen = await this.registry.capture(terminal.id as LaneId, 5_000, false)
    return { terminal, matches: matchingLines(screen, text) }
  }

  /** Close a lane. To close the workbench itself, use `close()`. */
  closeLane(lane: LaneId): Promise<void> {
    return this.registry.close(lane)
  }

  /** What a human would run to see this lane in their own terminal. */
  attachCommand(lane: LaneId): string {
    return this.registry.attachCommand(lane)
  }

  /**
   * Raise a lane's own window, where the driver has real windows to raise.
   * Throws `UnsupportedCapabilityError` where it does not: check
   * `driver.capabilities.focus` first rather than calling it hopefully.
   */
  focusLane(lane: LaneId): Promise<void> {
    return this.registry.focus(lane)
  }

  /**
   * Watch a lane: the rendered screen as it is now, then every byte after.
   * The snapshot comes first so a new watcher sees what it missed rather than
   * an empty pane until the agent next says something.
   */
  async watch(
    lane: LaneId,
    onData: (chunk: Uint8Array) => void,
    opts: { lines?: number; onExit?: (exit: { code: number | null }) => void } = {},
  ): Promise<{ snapshot: string; cols: number; rows: number; stop: Unsubscribe }> {
    const record = this.registry.get(lane)
    if (!record) throw new Error(`no such lane: ${lane}`)
    const snapshot = await this.registry.capture(lane, opts.lines ?? 200)
    const stops = [this.registry.onOutput(lane, onData)]
    // Watching something that ends has to be told it ended, or whoever is
    // looking at it waits forever at a screen that will never change again.
    if (opts.onExit) stops.push(this.registry.onExit(lane, opts.onExit))
    return {
      snapshot,
      cols: record.spec.cols ?? 80,
      rows: record.spec.rows ?? 24,
      stop: () => {
        for (const stop of stops) stop()
      },
    }
  }

  // --- tasks

  /** Create a task: a branch, a worktree, and your intent recorded verbatim. */
  async createTask(req: CreateTaskRequest): Promise<TaskWorktree> {
    const configured = this.config.projects[req.project]
    const root = req.root ?? (configured ? expandHome(configured.root) : undefined)
    if (!root) {
      throw new Error(`unknown project "${req.project}": add it to config.yaml or pass a root`)
    }
    await this.guardName(`${req.project}/${req.slug}`)
    const workspace = req.workspace ?? workspaceFor(this.config, req.project)
    if ((req.done === 'committed' || req.done === 'merged') && workspace !== 'worktree') {
      // In a shared checkout nothing is any one agent's to commit or merge.
      throw new Error(
        `a task in ${req.project}'s checkout cannot finish when ${req.done}: agents there share one branch. Use said, idle or manual`,
      )
    }
    // Before the task, so the folder it is about to write is ignored from the
    // instant it exists rather than from the next one.
    await this.ignoreOwnFiles(req.project, root)
    const task = await createTask({
      project: req.project,
      root,
      slug: req.slug,
      intent: req.intent,
      worktreeRoot: join(this.home, 'worktrees'),
      ...(req.base ? { base: req.base } : {}),
      ...(req.detached ? { detached: true } : {}),
      ...(req.context ? { context: req.context } : {}),
      ...(req.links ? { links: req.links } : {}),
      ...(req.by ? { by: req.by } : {}),
      ...(req.done ? { done: req.done } : {}),
      ...(req.start ? { start: req.start } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      workspace,
    })
    await this.log.append({
      type: 'task_created',
      task: task.id,
      detail: {
        branch: task.branch,
        worktree: task.worktree,
        workspace: task.workspace,
        base: task.base,
        // The journal is where "what was that about" gets answered.
        intent_spoken: req.intent,
        ...(req.effort ? { effort: req.effort } : {}),
        ...(req.by ? { by: req.by } : {}),
        ...(req.done ? { done: req.done } : {}),
        ...(req.start ? { after: req.start.after.map((dep) => dep.task) } : {}),
        ...(req.start?.at ? { at: req.start.at } : {}),
      },
    })
    return task
  }

  /**
   * Add Tade's own files to a project's ignore rules the first time it works
   * there, and write down that it did. Idempotent, so every task after the
   * first costs a read and nothing else — which is also what fixes a project
   * Tade had already been working in before this existed.
   *
   * It is in the project's own checkout, uncommitted, where `git status` shows
   * it and a person commits or reverts it. A worktree made before that commit
   * carries the tree it was made from, so agents there are protected once
   * somebody keeps it.
   */
  private async ignoreOwnFiles(project: string, root: string): Promise<void> {
    const done = await ensureIgnored(root)
    if (done.added.length === 0) return
    await this.log.append({
      type: 'ignore_written',
      detail: {
        project,
        path: IGNORE_PATH,
        added: done.added,
        // Nothing commits it: this is the one file Tade changes in somebody's
        // repository beside the checks manifest, and both are theirs to keep.
        message: `${IGNORE_PATH} in ${project} now ignores what Tade writes under ${PROJECT_DIR}/, except ${MANIFEST_PATH}. It is not committed.`,
      },
    })
  }

  /**
   * Make every task in a plan. `makePlan` does the work — it is about several
   * projects at once, which is its own subject — and this hands it the few
   * things it needs of the workbench.
   */
  async planTasks(
    plan: Plan,
    by = 'orchestrator',
    /** Work the projects already have, so the plan is checked against it too. */
    busy: readonly PlanBusy[] = [],
  ): Promise<PlanMade> {
    return makePlan(
      {
        config: this.config,
        events: (filter) => this.log.read(filter),
        note: async (event) => {
          await this.log.append(event)
        },
        createTask: (req) => this.createTask(req),
        resolveModel: (said) => this.resolveModel(said),
      },
      plan,
      by,
      busy,
    )
  }

  /**
   * Start queued work: from where it should begin, on what it was planned to
   * run on, told what it was planned to be told. Said in the journal, so what
   * started it and why is there to be asked about later.
   *
   * Told once. Work whose agent already has a conversation has had its
   * instruction — it was started before, and the queue is looking at it again
   * because what says so was lost — so it is brought back where it left off
   * instead, and the journal says which of the two happened.
   */
  async startQueued(req: {
    task: string
    worktree: string
    /** What it begins on top of, in a worktree: what it waited on, or the base. */
    from?: readonly string[]
    why: string
  }): Promise<LaneRecord> {
    const file = await readTaskFile(req.worktree, req.task)
    if (!file?.start) throw new Error(`${req.task} is not queued work`)
    if (file.workspace !== 'checkout' && req.from && req.from.length > 0) {
      await beginFrom(req.worktree, req.task, req.from)
    }
    const { start } = file
    const told = await this.hasConversation(req.task, req.worktree)
    const lane = told
      ? await this.reopenAgent({ task: req.task as TaskId, cwd: req.worktree })
      : await this.startAgent({
          task: req.task as TaskId,
          cwd: req.worktree,
          prompt: start.prompt,
          ...(start.model ? { model: start.model } : {}),
          ...(start.thinking && isThinkingLevel(start.thinking)
            ? { thinking: start.thinking }
            : {}),
        })
    await this.log.append({
      type: 'queue_started',
      task: req.task,
      detail: {
        why: req.why,
        after: start.after.map((dep) => dep.task),
        ...(told ? { reopened: true } : {}),
      },
    })
    return lane
  }

  // --- schedules

  /** The schedules as they stand, paused ones included. */
  schedules(): KeptSchedule[] {
    return this.kept.all()
  }

  /**
   * Make a schedule, or change the one with its id. Refused with why when its
   * rule cannot be kept or its project is not one Tade knows.
   */
  async setSchedule(schedule: Schedule, by: string): Promise<KeptSchedule> {
    if (!this.config.projects[schedule.project]) {
      throw new Error(`unknown project "${schedule.project}": add it to config.yaml first`)
    }
    const kept = this.kept.set(schedule, by)
    await this.log.append({
      type: 'schedule_changed',
      detail: { schedule: kept.id, change: 'set', by, name: kept.name },
    })
    return kept
  }

  /** Rename, pause, resume or remove a schedule, as whoever asked. */
  async changeSchedule(req: {
    id: string
    change: 'rename' | 'pause' | 'resume' | 'remove'
    by: string
    name?: string
  }): Promise<KeptSchedule | null> {
    let kept: KeptSchedule | null = null
    if (req.change === 'rename') kept = this.kept.rename(req.id, req.name ?? '', req.by)
    if (req.change === 'pause' || req.change === 'resume') {
      kept = this.kept.pause(req.id, req.change === 'pause', req.by)
    }
    if (req.change === 'remove') this.kept.remove(req.id, req.by)
    await this.log.append({
      type: 'schedule_changed',
      detail: {
        schedule: req.id,
        change: req.change,
        by: req.by,
        ...(req.name ? { name: req.name } : {}),
      },
    })
    return kept
  }

  /**
   * A schedule came due: written down first — so a window that stops half way
   * never runs it twice — and then, for one that starts agents, its agent's task
   * made as queued work, which the queue starts as soon as there is room. What
   * it runs in is the project's own way of working, as any agent's is.
   */
  async fireSchedule(
    id: string,
    due: { run: boolean; due: number; missed: number },
    now = Date.now(),
  ): Promise<{ task: string | null }> {
    const schedule = this.kept.get(id)
    if (!schedule) throw new Error(`there is no schedule called ${id}`)
    const at = new Date(due.due).toISOString()
    if (!due.run || schedule.does.kind !== 'agent') {
      await this.log.append({
        type: 'schedule_fired',
        // A watch looks on a clock: what it finds is news, the looking is not.
        ...(schedule.does.kind === 'watch' ? { urgency: 'routine' as const } : {}),
        detail: { schedule: id, due: at, missed: due.missed, ran: due.run },
      })
      return { task: null }
    }
    const day = new Date(now)
    const month = String(day.getMonth() + 1).padStart(2, '0')
    const stem = `${id}-${month}${String(day.getDate()).padStart(2, '0')}`
    const does = schedule.does
    for (let n = 1; n <= 50; n++) {
      const slug = n === 1 ? stem : `${stem}-${n}`
      let task: TaskWorktree
      try {
        task = await this.createTask({
          project: schedule.project,
          slug,
          intent: schedule.said || schedule.name,
          by: `schedule:${id}`,
          ...(does.done ? { done: does.done } : {}),
          start: {
            after: [],
            prompt: does.prompt,
            touches: [],
            ...(does.model ? { model: does.model } : {}),
            ...(does.thinking ? { thinking: does.thinking } : {}),
          },
        })
      } catch (err) {
        if (/already exists|used before/.test(err instanceof Error ? err.message : '')) continue
        throw err
      }
      await this.log.append({
        type: 'schedule_fired',
        task: task.id,
        detail: { schedule: id, due: at, missed: due.missed, ran: true },
      })
      return { task: task.id }
    }
    throw new Error(`every name like ${stem} is taken in ${schedule.project}`)
  }

  /**
   * A watch looked: how much it found, which was new, how much of that waits
   * for its next look, and where that look starts — or why it could not look.
   */
  async watchChecked(
    id: string,
    look:
      | { found: number; fresh: readonly string[]; left: number; since: string | null }
      | { problem: string },
  ): Promise<void> {
    await this.log.append({
      type: 'watch_checked',
      detail: { schedule: id, ...look },
    })
  }

  /**
   * Something a watch found for the first time, written down so it never
   * starts work twice. Given what to tell an agent, its work is made as queued
   * work named for what it is about, which the queue starts as soon as there is
   * room, in the project's own workspace. Otherwise it was told to someone, or
   * could not be started on, and why. A start that fails is written down with
   * why too: tried again at every look, it would fail at every look.
   */
  async watchFound(
    id: string,
    finding: { key: string; title: string },
    outcome:
      | {
          agent: {
            title: string
            prompt: string
            context?: string
            links?: readonly { title: string; url: string }[]
          }
        }
      | { told: string }
      | { problem: string },
  ): Promise<{ task: string | null }> {
    const schedule = this.kept.get(id)
    if (!schedule) throw new Error(`there is no schedule called ${id}`)
    const found = { schedule: id, key: finding.key, title: finding.title }
    if (!('agent' in outcome)) {
      await this.log.append({ type: 'watch_found', detail: { ...found, ...outcome } })
      return { task: null }
    }
    const { agent } = outcome
    const stem = branchSlug(agent.title)
    try {
      for (let n = 1; n <= 50; n++) {
        const slug = n === 1 ? stem : `${stem}-${n}`
        let task: TaskWorktree
        try {
          task = await this.createTask({
            project: schedule.project,
            slug,
            intent: agent.prompt,
            by: `schedule:${id}`,
            ...(agent.context ? { context: agent.context } : {}),
            ...(agent.links && agent.links.length > 0 ? { links: agent.links } : {}),
            start: { after: [], prompt: agent.prompt, touches: [] },
          })
        } catch (err) {
          if (/already exists|used before/.test(err instanceof Error ? err.message : '')) continue
          throw err
        }
        await this.log.append({ type: 'watch_found', task: task.id, detail: found })
        return { task: task.id }
      }
      throw new Error(`every name like ${stem} is taken in ${schedule.project}`)
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err)
      await this.log.append({ type: 'watch_found', detail: { ...found, problem } })
      throw err
    }
  }

  /**
   * A person's choice about queued work — pause, resume, start it anyway,
   * wait past what held it, or put what is ready in an order — or about a
   * project's whole queue, when no task is named. Written down: what the queue
   * does next is read from it.
   */
  async changeQueued(req: {
    task?: string
    project?: string
    change: QueueChange
    /** For `order`: the tasks, first to last. What is not named keeps its place behind. */
    order?: readonly string[]
    by: 'you' | 'orchestrator'
  }): Promise<void> {
    if (!req.task && (req.change === 'start' || req.change === 'wait')) {
      throw new Error(`${req.change} is for one piece of work: say which`)
    }
    const order = (req.order ?? []).map((task) => task.trim()).filter((task) => task !== '')
    if (req.change === 'order' && order.length === 0) {
      throw new Error('an order is a list of queued work, first to last: say which comes first')
    }
    // `all` marks a choice made about a whole project's queue, which is what
    // pausing and resuming everything is read from. An order is never that.
    const whole = !req.task && (req.change === 'pause' || req.change === 'resume')
    await this.log.append({
      type: 'queue_changed',
      task: req.task ?? null,
      detail: {
        change: req.change,
        by: req.by,
        ...(req.change === 'order' ? { order } : {}),
        ...(whole ? { all: true } : {}),
        ...(!req.task && req.project ? { project: req.project } : {}),
      },
    })
  }

  /** Queued work that could not start, held with why until someone chooses. */
  async holdQueued(
    task: string,
    because: string,
    how: {
      on?: string
      start?: 'failed'
      /** The files work going on now had changed under it, when that is what held it. */
      changed?: readonly string[]
      /** Whose changes they were, where git said whose. */
      by?: readonly string[]
    },
  ): Promise<void> {
    await this.log.append({
      type: 'queue_held',
      task,
      detail: {
        because,
        ...(how.on ? { on: how.on } : {}),
        ...(how.start ? { start: how.start } : {}),
        ...(how.changed ? { changed: [...how.changed] } : {}),
        ...(how.by && how.by.length > 0 ? { by: [...how.by] } : {}),
      },
    })
  }

  /**
   * Record that a task is finished: a person marking it, the orchestrator on
   * their word, or Tade seeing the task's own rule met. Its agent says so
   * itself, through its harness. Whatever waits on it starts from this.
   */
  async markDone(
    task: string,
    how: { by: 'you' | 'orchestrator' | 'rule'; summary?: string; rule?: DoneRule },
  ): Promise<void> {
    await this.log.append({
      type: 'task_done',
      task,
      detail: {
        by: how.by,
        summary: how.summary?.trim() ?? '',
        ...(how.rule ? { rule: how.rule } : {}),
      },
    })
  }

  /**
   * Refuse a name any task has had. A harness keeps a conversation by the
   * task's name, so a new agent under a removed one's name would carry on its
   * conversation — and two names that make the same conversation in any
   * harness, `a.b` and `a-b` in pi, share one. The journal is what remembers a
   * name after its task is gone.
   */
  private async guardName(id: string): Promise<void> {
    const adapters = Object.values(this.adapters)
    const keys = adapters.map((adapter) => adapter.conversationKey(id as TaskId))
    const created = await this.log.read({ types: ['task_created'] }).catch(() => [])
    const clash = created.find(
      (event) =>
        event.task &&
        (event.task === id ||
          adapters.some((adapter, n) => adapter.conversationKey(event.task as TaskId) === keys[n])),
    )?.task
    if (!clash) return
    throw new Error(
      clash === id
        ? `${id} was used before, and a task's name is never used twice: pick another`
        : `${id} would carry on ${clash}'s conversation, which was used before: pick another name`,
    )
  }

  /**
   * Give an agent that started without a branch one, named for its work. Said
   * in the journal, because a branch appearing is something you may look for.
   */
  async nameTask(req: {
    task: string
    root: string
    worktree: string
    title: string
  }): Promise<string> {
    const branch = await nameTask(req)
    await this.log.append({
      type: 'task_named',
      task: req.task,
      detail: { branch, title: req.title },
    })
    return branch
  }

  /** Remove a task. Refuses to destroy uncommitted or unmerged work. */
  async removeTask(req: RemoveTaskRequest): Promise<RemoveResult> {
    const result = await removeTask(req)
    if (result.removed) {
      await this.log.append({
        type: 'task_removed',
        ...(req.task ? { task: req.task } : {}),
        detail: { branch: req.branch, worktree: req.worktree, forced: req.force === true },
      })
    }
    return result
  }

  /** Set a task aside, or pick it back up. */
  async parkTask(
    worktree: string,
    parked: boolean,
    task?: string,
  ): Promise<{ task: string; parked: boolean }> {
    const result = await setParked(worktree, parked, task)
    await this.log.append({
      type: 'state_change',
      task: result.task || null,
      detail: { state: parked ? 'parked' : 'resumed', by: 'you' },
    })
    return result
  }

  // --- notes

  /**
   * Write something down, exactly as it was said, with the headline whoever
   * took it wrote for it — what it is about and what it does, never a tidier
   * version of the words themselves.
   */
  remember(
    text: string,
    scope: string | null = null,
    by = 'unknown',
    summary: string | null = null,
  ): Note {
    return this.memory.remember(text, scope, by, Date.now(), summary)
  }

  /**
   * What has been said about something, newest first: notes about the task,
   * about its project, and about everything. `null` asks for only the last.
   */
  recall(scope: string | null): Note[] {
    return this.memory.recall(scope)
  }

  /** Everything that has ever been remembered, whatever it was about. */
  recallAll(): Note[] {
    return this.memory.all()
  }

  /** Take a note back, named by when it was said and what it said. False when there was no such note. */
  forget(note: { at: string; text: string }, by = 'unknown'): boolean {
    return this.memory.forget(note, by)
  }

  // --- agents

  /**
   * Bring an agent back to where it left off: the same lane, the same
   * conversation, and nothing said to it.
   *
   * This is what reopening the window does, and it is deliberately not
   * `startAgent` with an empty prompt by convention — the request has no
   * prompt to pass, so no caller can reattach and instruct in one breath.
   * An agent that was already told what to do must never be told again: it
   * would start the work over, on top of what it has already done.
   */
  reopenAgent(req: Omit<StartRunRequest, 'prompt'>): Promise<LaneRecord> {
    return this.startAgent({ ...req, prompt: '' })
  }

  /**
   * Put an agent to work, in a lane you can watch.
   *
   * This is how agents run: pi as itself, in a terminal, driven by the same
   * keystrokes you would type. It outlives us exactly as far as the driver
   * says it does, and reopening finds it again rather than starting it over —
   * the lane by adoption, the conversation by pi's own session id.
   *
   * `prompt` is the opening instruction, which is said once. Coming back to
   * an agent is `reopenAgent`, which says nothing.
   */
  async startAgent(req: StartRunRequest): Promise<LaneRecord> {
    this.guardParallel(req.task)
    await this.guardBudget(req.task)
    const lane = `${req.task}/agent` as LaneId
    if (this.registry.get(lane)?.alive) {
      // Two agents in one worktree is two agents editing the same files.
      throw new Error(`${req.task} already has an agent running: steer it or stop it first`)
    }
    const harness = req.harness ?? (await this.harnessOf(req.task, req.cwd))
    const account = req.account ?? (await this.accountOf(req.task, req.cwd, harness))
    const adapter = this.adapterFor(harness, account)
    const extras = withTade(
      req.extras ??
        this.extensions?.extras({
          project: req.task.split('/')[0] ?? '',
          task: req.task,
          cwd: req.cwd,
          harness,
        }),
      await this.agentPrompt(req.task, req.cwd, adapter.capabilities.done),
    )
    const { chosen } = await this.taskFile(req.cwd, req.task)
    // The model new agents start on is for new agents. One coming back to its
    // conversation keeps the model that conversation was on, which its session
    // remembers — told the default instead, it would quietly change models.
    const resuming = await adapter.hasConversation(req.task, req.cwd)
    // Coming back, a harness that keeps its model is left on it; one that does
    // not is told again what it last ran on, as the journal heard it.
    const keeps = resuming && adapter.capabilities.resumeKeeps
    const thinking = req.thinking ?? (keeps ? undefined : this.thinkingFor(req.task, harness))
    const model =
      req.model ??
      (keeps
        ? undefined
        : ((resuming ? await this.lastModelOf(req.task, harness) : undefined) ??
          this.modelFor(req.task, harness)))
    const spec = {
      run: lane as RunId,
      task: req.task,
      cwd: req.cwd,
      prompt: req.prompt,
      ...(chosen ? { title: chosen } : {}),
      ...(extras ? { extras } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      lane,
      sandbox: {
        kind: req.sandbox ?? this.sandboxFor(req.task),
        worktree: req.worktree ?? req.cwd,
        // Where the harness keeps the conversation: contained without it, an
        // agent runs and quietly keeps nothing.
        writable: [...adapter.sandboxWrites().paths],
        writablePrefixes: [...adapter.sandboxWrites().prefixes],
      },
    }
    // Listen before launching: the channel has to exist for the agent's very
    // first signal, and its path is derived from the run id so both halves
    // agree without being told.
    await this.workers.start({
      ...req,
      run: lane as RunId,
      model: spec.model,
      ...(spec.thinking ? { thinking: spec.thinking } : {}),
      harness: adapterKey(harness, account),
      ...(extras ? { extras } : {}),
    })
    const launch = adapter.launchSpec(spec)
    try {
      const record = await this.registry.spawn({
        id: lane,
        task: req.task,
        kind: 'agent',
        cwd: req.cwd,
        command: launch.command,
        args: launch.args,
        // Said at this launch and written down nowhere: what puts the lane
        // back later must not repeat the instruction it opened with.
        ...(launch.opening ? { opening: launch.opening } : {}),
        env: launch.env,
        title: req.task,
        harness,
        ...(account ? { account } : {}),
      })
      this.followExit(lane)
      return record
    } catch (err) {
      // Nothing to supervise after all.
      await this.workers.stop(lane as RunId).catch(() => {})
      throw err
    }
  }

  /**
   * Whether this task's agent has a conversation to come back to, which its
   * harness keeps rather than Tade. A task that has one has been told what it
   * is for at least once.
   */
  private async hasConversation(task: string, cwd: string): Promise<boolean> {
    const harness = await this.harnessOf(task, cwd)
    const account = await this.accountOf(task, cwd, harness)
    return Promise.resolve()
      .then(() => this.adapterFor(harness, account).hasConversation(task as TaskId, cwd))
      .catch(() => false)
  }

  /** What a task's file says: what was asked, and the name a person chose, if any. */
  private async taskFile(
    cwd: string,
    task?: string,
  ): Promise<{ intent: string; chosen: string | null }> {
    try {
      const file = parseYaml(await readFile(taskFilePath(cwd, task), 'utf8')) as {
        intent_spoken?: unknown
        title?: unknown
        title_named?: unknown
      } | null
      return {
        intent: typeof file?.intent_spoken === 'string' ? file.intent_spoken : '',
        chosen: file?.title_named === true && typeof file.title === 'string' ? file.title : null,
      }
    } catch {
      // No task file: an agent opened on a worktree Tade did not make.
      return { intent: '', chosen: null }
    }
  }

  /**
   * What a project's checks are, and the rule about when they run, for the
   * agent's prompt. Nothing at all for a project that checks nothing, which
   * is what leaves the old one-command sentence in place.
   */
  private async checksTold(
    project: string,
    cwd: string,
  ): Promise<{ checks?: { ids: string[]; rule: ReturnType<typeof checksFor>; hold: boolean } }> {
    try {
      const stood = await checksAt({ config: this.config, project, worktree: cwd, commit: null })
      if (stood.manifest.source === 'none' || stood.manifest.checks.length === 0) return {}
      return {
        checks: {
          ids: stood.manifest.checks.map((check) => check.id),
          rule: stood.rule,
          // Only under `policy` can a push actually be held; anywhere else
          // the rule is something the agent keeps, and Tade writes down.
          hold: this.config.approvals.mode === 'policy' && stood.rule.on_red === 'hold',
        },
      }
    } catch {
      // A manifest that will not read is the extension's problem to report,
      // never a reason an agent cannot start.
      return {}
    }
  }

  /** What an agent starting on a task is told about where it is. */
  private async agentPrompt(task: string, cwd: string, canSayDone: boolean): Promise<string> {
    const project = task.split('/')[0] ?? ''
    const configured = this.config.projects[project]
    const { intent } = await this.taskFile(cwd, task)
    const head = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const context = taskContextPath(cwd, task)
    const shared = taskFilePath(cwd, task) !== join(cwd, '.tade', 'task.yaml')
    const agents = this.config.agents
    return composeAgentPrompt({
      task,
      project,
      worktree: cwd,
      root: configured ? expandHome(configured.root) : null,
      intent,
      branch: head.ok ? head.stdout.trim() : '',
      notes: this.memory.recall(task),
      context: existsSync(join(cwd, context)) ? context : null,
      workspace: shared ? 'checkout' : 'worktree',
      commit: agents.commit,
      ...(agents.instructions ? { instructions: agents.instructions } : {}),
      ...(configured?.test_command ? { testCommand: configured.test_command } : {}),
      ...(await this.checksTold(project, cwd)),
      canSayDone,
    })
  }

  /**
   * A harness's adapter: the route's harness unless one is named. The very
   * one the supervisor answers its runs with, never a second made to ask.
   */
  private adapterFor(harness?: string, account?: string): WorkerAdapter {
    const id = harness ?? this.config.workers.routes[this.config.workers.default]?.harness ?? 'pi'
    const own = this.adapters[id]
    if (!own)
      throw new Error(
        `no harness called ${id}: Tade runs ${Object.keys(HARNESS_ADAPTERS).join(', ')}`,
      )
    if (!account) return own
    const key = adapterKey(id, account)
    const known = this.adapters[key]
    if (known) return known
    // An account's own adapter, made the first time an agent needs it and
    // answering its runs from then on.
    const made = HARNESS_ADAPTERS[id]?.({
      ...this.harnessOptions,
      account: this.accountFor(account),
    })
    if (!made) throw new Error(`no harness called ${id}`)
    this.adapters[key] = made
    this.workers.add(key, made)
    return made
  }

  /**
   * An account as its harness is given it: its folder under Tade's home, and
   * for one paid by API key, the command that reads that key from where Tade
   * keeps it — never the key.
   */
  private accountFor(name: string): HarnessAccount {
    return harnessAccount(this.config, this.home, name)
  }

  /**
   * The account a task's agent runs as: its own choice, else the one its
   * harness's new agents use, else the harness's own sign-in. One that is not
   * this harness's is not used: an account belongs to one harness.
   */
  private async accountOf(task: string, cwd: string, harness: string): Promise<string | undefined> {
    const own = await this.taskAccount(cwd, task)
    if (!own) return this.accountUsing(harness)
    return this.config.accounts[own]?.harness === harness ? own : undefined
  }

  /**
   * The account a harness's new agents run as: the one chosen for it, when it
   * is that harness's own. An account belongs to one harness.
   */
  private accountUsing(harness: string): string | undefined {
    const chosen = this.config.workers.accounts[harness as HarnessId]
    if (!chosen) return undefined
    return this.config.accounts[chosen]?.harness === harness ? chosen : undefined
  }

  private async taskAccount(cwd: string, task: string): Promise<string | null> {
    try {
      const file = parseYaml(await readFile(taskFilePath(cwd, task), 'utf8')) as {
        account?: unknown
      } | null
      return typeof file?.account === 'string' ? file.account : null
    } catch {
      return null
    }
  }

  /**
   * The harness a task's agent runs in and what it can be asked to do there,
   * as the harness declares it: what the window shows and hides for it.
   */
  async agentHarness(
    task: string,
    cwd: string,
  ): Promise<{ harness: string; account: string | null; capabilities: WorkerCapabilities }> {
    const harness = await this.harnessOf(task, cwd)
    const account = await this.accountOf(task, cwd, harness)
    return {
      harness,
      account: account ?? null,
      capabilities: this.adapterFor(harness).capabilities,
    }
  }

  private canQuietly(task: string, feature: 'model' | 'thinking' | 'rename'): boolean {
    try {
      this.can(task, feature)
      return true
    } catch {
      return false
    }
  }

  /**
   * Refuse what a running agent's harness cannot do, with the harness's own
   * reason: the same sentence the window shows beside the control it hides.
   */
  private can(task: string, feature: 'model' | 'thinking' | 'rename'): Support {
    const run = this.workers.list().find((handle) => handle.task === task)
    const adapter = run ? this.workers.adapterOf(run.run) : this.adapterFor()
    const support = adapter.capabilities[feature]
    const said = offer(adapter.capabilities, feature, support)
    if (!said.shown) throw new Error(`${adapter.id} ${said.note}`)
    return support
  }

  /** The harness a task's agent runs in: its own choice, else its project's route. */
  private async harnessOf(task: string, cwd: string): Promise<string> {
    const own = await this.taskHarness(cwd, task)
    if (own) return own
    const project = task.split('/')[0] ?? ''
    return resolveRoute(this.config, { project }).harness
  }

  private async taskHarness(cwd: string, task: string): Promise<string | null> {
    try {
      const file = parseYaml(await readFile(taskFilePath(cwd, task), 'utf8')) as {
        harness?: unknown
      } | null
      return typeof file?.harness === 'string' ? file.harness : null
    } catch {
      return null
    }
  }

  // --- accounts ------------------------------------------------------------------

  /**
   * Every account there is to run agents as: each harness's own sign-in, and
   * the ones added beside it, with who each is signed in as — as the harness
   * says, asked now — how much of its plan is used, and how many agents are on
   * it. Never throws: a harness that cannot answer says so in `status.problem`.
   */
  async accounts(): Promise<AccountView[]> {
    const running = this.workers.list()
    return listAccounts(this.config, {
      adapterFor: (harness, name) => this.adapterFor(harness, name ?? undefined),
      agentsOn: (adapter) =>
        running.filter((run) => this.workers.adapterOf(run.run) === adapter).length,
    })
  }

  /**
   * Add an account to run a harness's agents as, beside its own sign-in: its
   * folder made and made ready, and its name written down. Signing in to it is
   * the next step, and the harness's own.
   */
  async addAccount(req: {
    name: string
    harness: string
    kind?: 'subscription' | 'api-key'
    share?: boolean
  }): Promise<void> {
    const name = req.name.trim().toLowerCase()
    const parsed = AccountName.safeParse(name)
    if (!parsed.success) {
      throw new Error(`"${req.name}" cannot name an account: ${parsed.error.issues[0]?.message}`)
    }
    if (this.config.accounts[name]) throw new Error(`there is already an account called ${name}`)
    const own = this.adapterFor(req.harness)
    if (!own.capabilities.accounts) {
      throw new Error(`${req.harness} ${own.capabilities.why.accounts ?? 'has one account'}`)
    }
    const kind = req.kind ?? 'subscription'
    const share = req.share ?? true
    this.writeConfig(`accounts.${name}`, { harness: req.harness, kind, share })
    await this.adapterFor(req.harness, name).prepareAccount(share)
    await this.log.append({
      type: 'state_change',
      detail: { account: name, harness: req.harness, kind, added: true, by: 'you' },
    })
  }

  /**
   * Take an account away: signed out, its folder removed, its name gone —
   * and nothing left pointing at it. Refused while an agent runs as it.
   */
  async removeAccount(name: string): Promise<void> {
    const account = this.config.accounts[name]
    if (!account) throw new Error(`no account called ${name}`)
    const adapter = this.adapterFor(account.harness, name)
    const busy = this.workers.list().filter((run) => this.workers.adapterOf(run.run) === adapter)
    if (busy.length > 0) {
      throw new Error(
        `${busy.map((run) => run.task).join(', ')} ${busy.length === 1 ? 'runs' : 'run'} as ${name}: stop ${busy.length === 1 ? 'it' : 'them'} first`,
      )
    }
    if (account.kind === 'subscription') await adapter.signOut().catch(() => {})
    await rm(join(this.home, 'accounts', name), { recursive: true, force: true })
    if (this.config.workers.accounts[account.harness] === name) {
      this.writeConfig(`workers.accounts.${account.harness}`, undefined)
    }
    this.writeConfig(`accounts.${name}`, undefined)
    delete this.adapters[adapterKey(account.harness, name)]
    await this.log.append({
      type: 'state_change',
      detail: { account: name, harness: account.harness, removed: true, by: 'you' },
    })
  }

  /** Which account a harness's new agents run as: `null` for its own sign-in. */
  async useAccount(harness: string, name: string | null): Promise<void> {
    if (name && this.config.accounts[name]?.harness !== harness) {
      throw new Error(`${name} is not a ${harness} account`)
    }
    this.writeConfig(`workers.accounts.${harness}`, name ?? undefined)
    await this.log.append({
      type: 'state_change',
      detail: { harness, account: name ?? 'default', forNewAgents: true, by: 'you' },
    })
  }

  /**
   * Run one task's agent as another account — the one to move to when an
   * account has run out of its plan. Its conversation goes with it, where the
   * harness can carry it, so it goes on rather than starting over; a running
   * agent is started again there.
   */
  async setAgentAccount(req: {
    task: string
    worktree: string
    account: string | null
  }): Promise<{ account: string | null; restarted: boolean; carried: boolean }> {
    const harness = await this.harnessOf(req.task, req.worktree)
    if (req.account && this.config.accounts[req.account]?.harness !== harness) {
      throw new Error(`${req.account} is not a ${harness} account`)
    }
    const from = this.adapterFor(harness, await this.accountOf(req.task, req.worktree, harness))
    const to = this.adapterFor(harness, req.account ?? undefined)
    const lane = `${req.task}/agent` as LaneId
    const running = this.registry.get(lane)?.alive === true
    if (running) await this.stopAgent(req.task)
    const carried =
      from !== to
        ? await from.carryConversation(req.task as TaskId, req.worktree, to).catch(() => false)
        : false
    await setTaskAccount(req.worktree, req.task, req.account)
    if (running) {
      await this.startAgent({
        task: req.task as TaskId,
        cwd: req.worktree,
        prompt: '',
        ...(req.account ? { account: req.account } : {}),
      })
    }
    await this.log.append({
      type: 'state_change',
      task: req.task,
      detail: { account: req.account ?? 'default', carried, by: 'you' },
    })
    return { account: req.account, restarted: running, carried }
  }

  /**
   * What to run, in a terminal you can see, to sign an account in: the
   * harness's own sign-in, so what you give it goes where it keeps it.
   */
  signInFor(harness: string, name: string | null): SignIn {
    const spec = this.adapterFor(harness, name ?? undefined).signIn()
    if (!spec)
      throw new Error(`${name ?? harness} has nothing to sign in to: it is paid for with a key`)
    return spec
  }

  async signOut(harness: string, name: string | null): Promise<void> {
    await this.adapterFor(harness, name ?? undefined).signOut()
    await this.log.append({
      type: 'state_change',
      detail: { harness, account: name ?? 'default', signedOut: true, by: 'you' },
    })
  }

  /**
   * Write an API-key account's key into the config, and say where it went.
   *
   * The harness is still handed a command that prints it rather than the key
   * itself — a key in a launch line is a key in the process table — but the
   * key is here, in plain sight, next to the account it belongs to. Taking
   * the account away takes it with it: it is one of the account's own fields.
   */
  saveAccountKey(name: string, key: string): string {
    if (this.config.accounts[name]?.kind !== 'api-key') {
      throw new Error(`${name} is not an account paid for with an API key`)
    }
    this.writeConfig(accountKey(name), key.trim() === '' ? undefined : key.trim())
    return 'config.yaml'
  }

  /** Write one setting and read the config back, so what was written is what runs. */
  private writeConfig(key: string, value: Parameters<typeof writeSetting>[2]): void {
    const path = join(this.home, 'config.yaml')
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null
    writeSetting(path, key, value)
    const parsed = parseConfig(readFileSync(path, 'utf8'), path)
    if (!parsed.ok) {
      // Never leave behind a file the next window would refuse.
      if (before === null) rmSync(path, { force: true })
      else writeFileSync(path, before, { mode: 0o600 })
      throw new Error(`that would make config.yaml invalid: ${parsed.issues[0]?.message ?? ''}`)
    }
    this.config = parsed.config
  }

  /**
   * Run a task's agent in another harness. Kept in its task, so it starts there
   * every time after; a running agent is stopped and started again in the new
   * one, since a conversation does not move between harnesses.
   */
  async setAgentHarness(req: {
    task: string
    worktree: string
    harness: string
  }): Promise<{ harness: string; restarted: boolean }> {
    const choice = HARNESS_CHOICES.find((one) => one.id === req.harness)
    if (!choice) {
      throw new Error(
        `no harness called ${req.harness}: there are ${HARNESS_CHOICES.map((one) => one.id).join(', ')}`,
      )
    }
    if (!choice.ready || !this.adapters[req.harness]) {
      throw new Error(
        `${choice.title} is ${choice.about}: Tade runs ${Object.keys(this.adapters).join(', ')}`,
      )
    }
    await setTaskHarness(req.worktree, req.task, req.harness)
    const lane = `${req.task}/agent` as LaneId
    const running = this.registry.get(lane)?.alive === true
    if (running) {
      await this.stopAgent(req.task)
      await this.startAgent({ task: req.task as TaskId, cwd: req.worktree, prompt: '' })
    }
    await this.log.append({
      type: 'state_change',
      task: req.task,
      detail: { harness: req.harness, by: 'you' },
    })
    return { harness: req.harness, restarted: running }
  }

  /**
   * Say something to a running agent without stopping it.
   *
   * Over the channel when there is one, which delivers it as a message into
   * the turn. Failing that — an agent adopted from a window that has since
   * closed, whose extension has nowhere to reconnect yet — type it at the
   * terminal, which is what you would do yourself.
   */
  async steerAgent(task: string, message: string): Promise<void> {
    const lane = `${task}/agent` as LaneId
    if (!this.registry.get(lane)?.alive) throw new Error(`no agent running on ${task}`)
    try {
      await this.workers.steer(lane as RunId, message)
    } catch {
      // The newline is the send: without it the words sit in pi's input box.
      await this.registry.write(lane, Buffer.from(`${message}\n`, 'utf8'))
    }
  }

  /**
   * Give an agent's work a name you chose. Kept in its task, so nothing names it
   * over it; told to its session when it is running, and when it next starts
   * otherwise. Its branch keeps its name: renaming a branch is its own choice.
   */
  async renameAgent(req: { task: string; worktree: string; title: string }): Promise<string> {
    const title = req.title.replace(/\s+/g, ' ').trim()
    if (!title) throw new Error('what should it be called?')
    await setTitle(req.worktree, title, true, req.task)
    const run = `${req.task}/agent` as RunId
    // Kept in the task either way; told to a session whose harness can take it.
    if (this.registry.get(run as unknown as LaneId)?.alive && this.canQuietly(req.task, 'rename')) {
      await this.workers.name(run, title).catch(() => {})
    }
    await this.log.append({ type: 'task_named', task: req.task, detail: { title, by: 'you' } })
    return title
  }

  /**
   * Switch a running agent to another model, said the way people say it —
   * "opus 5". Only for this agent's session: nothing else changes model with it.
   */
  async setAgentModel(task: string, said: string): Promise<{ provider: string; id: string }> {
    const run = `${task}/agent` as RunId
    if (!this.registry.get(run as unknown as LaneId)?.alive) {
      throw new Error(`${task} has no agent running: open it first`)
    }
    const support = this.can(task, 'model')
    const adapter = this.workers.adapterOf(run)
    // Named among what its own harness offers: another harness's model is no
    // model at all to this one.
    const found = await adapter.resolveModel(said)
    if (!found.ok) throw new Error(found.reason)
    const model = { provider: found.provider, id: found.id }
    // What it switched to is journalled by the agent itself, as the model its usage is priced at.
    if (support === 'restart') await this.restartAgent(task, { model })
    else await this.workers.setModel(run, model)
    this.keepAgentModel(task, model, adapter.id)
    return model
  }

  /**
   * The models a task's agent could run on: its own harness's, on the account
   * it runs as — a model is reached through a sign-in, and another account's
   * catalog is not this agent's. An empty answer carries the harness's own
   * words rather than anybody else's list.
   */
  async agentModels(task: string, cwd: string): Promise<HarnessModels> {
    const harness = await this.harnessOf(task, cwd)
    return modelsOffered(this.adapterFor(harness, await this.accountOf(task, cwd, harness)))
  }

  /**
   * What one harness offers to run, on the account its new agents use: for
   * choosing a model before there is any agent to ask, which is what Settings
   * and the orchestrator's own picker do.
   */
  async harnessModels(harness: string): Promise<HarnessModels> {
    try {
      return await modelsOffered(this.adapterFor(harness, this.accountUsing(harness)))
    } catch {
      return { harness, models: [], why: 'is not a harness Tade runs' }
    }
  }

  /**
   * What a harness can do, as it declares it, before any agent runs in it:
   * what a surface offering a choice for a harness nobody has started yet is
   * drawn by. Null for one Tade does not run.
   */
  capabilitiesOf(harness: string): WorkerCapabilities | null {
    try {
      return this.adapterFor(harness).capabilities
    } catch {
      return null
    }
  }

  /** A model said for a task's agent, among what its harness offers. Throws what to ask. */
  async resolveModelFor(
    task: string,
    cwd: string,
    said: string,
  ): Promise<{ provider: string; id: string }> {
    const found = await this.adapterFor(await this.harnessOf(task, cwd)).resolveModel(said)
    if (!found.ok) throw new Error(found.reason)
    return { provider: found.provider, id: found.id }
  }

  /**
   * Start a running agent again on the same conversation, with what changed:
   * how a harness that takes a model or a thinking level only at launch is
   * given one. Never in the middle of a turn, which it would cut short.
   */
  private async restartAgent(
    task: string,
    change: { model?: WorkerModel; thinking?: ThinkingLevel },
  ): Promise<void> {
    const lane = `${task}/agent` as LaneId
    const record = this.registry.get(lane)
    if (!record?.alive) throw new Error(`${task} has no agent running: open it first`)
    if (this.workers.turnOf(lane) === 'running') {
      throw new Error(
        `${task} is in the middle of a turn, and changing that means starting it again: ask once the turn ends`,
      )
    }
    await this.stopAgent(task)
    await this.startAgent({
      task: task as TaskId,
      cwd: record.spec.cwd,
      prompt: '',
      ...(record.harness ? { harness: record.harness } : {}),
      ...(record.account ? { account: record.account } : {}),
      ...change,
    })
  }

  /**
   * A model chosen for an agent is the one new agents start on from then on,
   * until another is chosen: kept in the route the agent's project uses, which
   * is where Settings shows the agent model. Unset, the harness picks — and pi
   * picks by what you are signed in to, which is how every agent ended up on
   * the same model whatever anyone chose.
   */
  keepAgentModel(task: string, model: { provider: string; id: string }, harness?: string): void {
    this.keepAgentRoute(task, { provider: model.provider, model: model.id }, harness)
  }

  /**
   * Change what new agents in a task's project start on: in the file, and
   * here. Kept for the harness the agent runs in — the route's own when it is
   * that one, and beside it for any other — so no harness is handed another's
   * model.
   */
  private keepAgentRoute(
    task: string,
    change: { provider?: string; model?: string; thinking?: ThinkingLevel },
    harness?: string,
  ): void {
    const project = task.split('/')[0]
    const route = resolveRoute(this.config, project ? { project } : {})
    const own = !harness || harness === route.harness
    const at = own
      ? `workers.routes.${route.name}`
      : `workers.routes.${route.name}.harnesses.${harness}`
    const path = join(this.home, 'config.yaml')
    try {
      for (const [key, value] of Object.entries(change)) writeSetting(path, `${at}.${key}`, value)
    } catch {
      // A config that cannot be written: this agent changed, and new ones
      // start where they did before.
      return
    }
    const { name: _name, ...kept } = route
    const next = own
      ? { ...kept, ...change }
      : {
          ...kept,
          harnesses: {
            ...kept.harnesses,
            [harness]: { ...kept.harnesses?.[harness as HarnessId], ...change },
          },
        }
    this.config = {
      ...this.config,
      workers: {
        ...this.config.workers,
        routes: { ...this.config.workers.routes, [route.name]: next },
      },
    }
  }

  /**
   * How hard an agent thinks from its next turn on — and new agents from
   * their first, until another level is chosen: kept beside the agent model.
   */
  async setAgentThinking(task: string, level: string): Promise<ThinkingLevel> {
    const chosen = THINKING_LEVELS.find((one) => one === level.trim().toLowerCase())
    if (!chosen) {
      throw new Error(`${level} is not a thinking level: ${THINKING_LEVELS.join(', ')}`)
    }
    const run = `${task}/agent` as RunId
    if (!this.registry.get(run as unknown as LaneId)?.alive) {
      throw new Error(`${task} has no agent running: open it first`)
    }
    const support = this.can(task, 'thinking')
    const thinker = this.workers.adapterOf(run)
    const levels = thinker.capabilities.thinkingLevels
    if (!levels.includes(chosen)) {
      throw new Error(
        `${this.workers.adapterOf(run).id} thinks at ${levels.join(', ')}, not ${chosen}`,
      )
    }
    // What it settled on is said back by the agent: a model that cannot think that hard takes less.
    if (support === 'restart') await this.restartAgent(task, { thinking: chosen })
    else await this.workers.setThinking(run, chosen)
    this.keepAgentRoute(task, { thinking: chosen }, thinker.id)
    return chosen
  }

  /**
   * The model someone named, among the ones they are signed in to. Throws what
   * to ask them when it is not one model: before anything is started on it.
   */
  async resolveModel(said: string): Promise<{ provider: string; id: string }> {
    const found = await this.adapterFor().resolveModel(said)
    if (!found.ok) throw new Error(found.reason)
    return { provider: found.provider, id: found.id }
  }

  /** Stop an agent: the lane ends, the task and its worktree stay. */
  async stopAgent(task: string): Promise<void> {
    const lane = `${task}/agent` as LaneId
    await this.workers.stop(lane as RunId).catch(() => {})
    await this.registry.close(lane)
  }

  /** The agents working right now. */
  /** The model and context an agent last reported. Null until it has said. */
  vitals(task: string): RunVitals | null {
    return this.workers.vitals(task)
  }

  runs(): WorkerHandle[] {
    return this.workers.list()
  }

  /** Whether an agent is in the middle of a turn, as it last said. */
  turnOf(run: string): 'running' | 'idle' | 'unknown' {
    return this.workers.turnOf(run)
  }

  /** Approvals waiting on a human. Empty unless approvals are switched on. */
  pendingApprovals(task?: string): PendingApproval[] {
    return this.workers.pending(task)
  }

  promptRun(run: RunId, message: string): Promise<void> {
    return this.workers.prompt(run, message)
  }

  steerRun(run: RunId, message: string): Promise<void> {
    return this.workers.steer(run, message)
  }

  decideApproval(run: RunId, requestId: string, decision: PermissionDecision): Promise<void> {
    return this.workers.decide(run, requestId, decision)
  }

  stopRun(run: RunId): Promise<void> {
    return this.workers.stop(run)
  }

  // --- the journal

  events(filter: EventFilter = {}): Promise<TadeEvent[]> {
    return this.log.read(filter)
  }

  subscribe(handler: (event: TadeEvent) => void, filter: EventFilter = {}): Unsubscribe {
    return this.log.subscribe(handler, filter)
  }

  /**
   * Refuse to run more agents on a project than it allows. The setting existed
   * and nothing enforced it, so a project configured for one agent would
   * happily get five.
   */
  private guardParallel(task: string): void {
    const project = task.split('/')[0] ?? ''
    const limit = this.config.projects[project]?.max_parallel
    if (!limit) return
    const running = this.workers.list().filter((h) => h.task.startsWith(`${project}/`)).length
    if (running >= limit) {
      throw new Error(
        `${project} already has ${running} agent${running === 1 ? '' : 's'} running, and max_parallel is ${limit}`,
      )
    }
  }

  /**
   * Refuse to start a run that would take a project past what it may spend in
   * a day, and say so before it gets close. A long run that dies at 100% with
   * no warning is how people lose work.
   */
  private async guardBudget(task: string): Promise<void> {
    const project = task.split('/')[0] ?? ''
    const budget = this.config.projects[project]?.budget
    if (!budget) return
    const events = await this.log.read({ types: ['usage'] }).catch(() => [])
    const spent = spendFrom(events, { since: startOfToday(Date.now()) }).byProject[project]
    const state = checkBudget(spent ?? noSpend(), budget)
    if (state.verdict === 'over') {
      throw new Error(`${project} has spent its budget for today: ${state.reason}`)
    }
    if (state.verdict === 'warn') {
      await this.log.append({
        type: 'warning',
        task,
        // Said out loud, not just journalled: by the time an earcon sends you
        // to look, the budget is spent.
        detail: { message: `${project} is near its budget: ${state.reason}` },
      })
    }
  }

  /**
   * How the task's route says to contain a worker. Deliberately not caught: a
   * route that cannot be resolved fails the run rather than quietly starting
   * an agent with the whole disk writable.
   */
  private sandboxFor(task: string): SandboxKind {
    const project = task.split('/')[0]
    return resolveRoute(this.config, project ? { project } : {}).sandbox
  }

  /**
   * The model the task's route names. `projects.*.worker` picks a route and
   * the route picks the model — which nothing was doing, so choosing a route
   * changed the sandbox and nothing else.
   */
  /** How hard new agents in a task's project think, when a level was chosen. */
  private thinkingFor(task: string, harness: string): ThinkingLevel | undefined {
    const project = task.split('/')[0]
    return routeIn(resolveRoute(this.config, project ? { project } : {}), harness).thinking
  }

  private modelFor(task: string, harness: string): WorkerModel | undefined {
    const project = task.split('/')[0]
    const route = routeIn(resolveRoute(this.config, project ? { project } : {}), harness)
    if (!route.model) return undefined
    return { id: route.model, ...(route.provider ? { provider: route.provider } : {}) }
  }

  /**
   * The model a task's agent last ran on, as it said when it opened and again
   * as it reported what it spent.
   *
   * The *spelling* is what is wanted here and not the model's own name: this
   * is handed back to a harness to start an agent on, and a bare
   * `claude-opus-5` is offered by several providers — pi refuses to guess
   * between them, which is an agent that exits before reading a word.
   */
  private async lastModelOf(task: string, harness: string): Promise<WorkerModel | undefined> {
    const said = await this.log.read({ types: ['usage', 'run_model'] }).catch(() => [])
    const id = modelLastRunOn(said, task, harness)
    // The spelling alone, never the provider beside it: the spelling already
    // carries whatever route it was reached by — that is what makes it a
    // spelling and not a name — and handing a harness both would ask it for
    // `openrouter/openrouter/anthropic/claude-opus-5`.
    return id ? { id } : undefined
  }

  /**
   * Close the window. Agents under supervision are our own children and stop
   * with us; lanes are let go of rather than ended, so under a driver whose
   * lanes outlive us they carry on working while nothing watches.
   */
  async close(): Promise<void> {
    this.closing ??= this.doClose()
    return this.closing
  }

  /**
   * Every step of it is tried, and the journal and the lock go back whatever
   * happened above them — the same rule `attach` obeys about the terminal it
   * put in raw mode: an exit path that gives up half way is worse than the
   * failure that stopped it.
   *
   * What it costs when they are not is one-sided. A detach that failed leaves a
   * lane running, which is survivable and is what the tmux driver does on
   * purpose; a journal left open leaves a file descriptor nobody holds a
   * reference to any more, and since Node 20 that is not a leak that waits for
   * the process to end — it is an **error thrown out of the garbage
   * collector**, landing on whatever happened to be running at the time. In
   * this repository that was the test suite, blaming files at random under
   * load for a handle none of them had opened.
   *
   * The first thing that went wrong is still thrown, so nothing goes silently;
   * it is thrown at the end, once everything has been let go of.
   */
  private async doClose(): Promise<void> {
    const trouble: unknown[] = []
    const step = (what: () => Promise<unknown>) => what().catch((err) => void trouble.push(err))
    await step(() => this.log.append({ type: 'tade_closing', detail: { pid: process.pid } }))
    // Let go of both, ending neither: saying `shutdown` to an agent because a
    // window closed would stop exactly the work the tmux driver keeps alive.
    await step(() => this.workers.detach())
    await step(() => this.registry.detach())
    await step(() => this.log.close())
    await step(() => this.lock.release())
    if (trouble.length > 0) throw trouble[0]
  }

  /** Stop everything, lanes included, rather than letting go of it. */
  async stopEverything(): Promise<void> {
    await this.workers.shutdown()
    await this.registry.shutdown()
    await this.close()
  }
}

/** A level someone wrote down, if it is one there is. */
function isThinkingLevel(level: string): level is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(level)
}

export type { LaneId, LaneRecord, SpawnRequest }

/**
 * What Tade tells an agent about itself, before what extensions add. Said in
 * its instructions rather than its prompt, so it holds when the conversation
 * is reopened, and a prompt you typed yourself is never rewritten.
 */
function withTade(extras: WorkerExtras | undefined, told: string): WorkerExtras {
  return {
    ...(extras ?? {}),
    instructions: [told, extras?.instructions ?? '']
      .filter((part) => part.trim() !== '')
      .join('\n\n'),
  }
}

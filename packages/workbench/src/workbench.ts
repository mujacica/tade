import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Config,
  ConfigSchema,
  checkBudget,
  type EventFilter,
  expandHome,
  type LaneId,
  loadConfig,
  type Note,
  noSpend,
  resolveRoute,
  type SandboxKind,
  spendFrom,
  startOfToday,
  type Unsubscribe,
  type WilcoEvent,
} from '@wilco/core'
import type { WorkspaceCapabilities, WorkspaceDriver } from '@wilco/drivers-core'
import type { PermissionDecision, RunId, WorkerHandle, WorkerModel } from '@wilco/harnesses-core'
import { noUsage, PiAdapter, usageOfTask } from '@wilco/harnesses-pi'
import { EventLog } from './events.ts'
import { type HomeLock, lockHome } from './lock.ts'
import { Memory } from './memory.ts'
import { drivers, type LaneRecord, LaneRegistry, type SpawnRequest } from './registry.ts'
import { createTask, type RemoveResult, removeTask, setParked, type TaskWorktree } from './tasks.ts'
import { type PendingApproval, type StartRunRequest, WorkerSupervisor } from './workers.ts'

// The workbench: everything Wilco is holding while it is open — the lanes, the
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
   * is where agents write because Wilco deliberately does not move them.
   */
  sessionsRoot?: string
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
}

export interface RemoveTaskRequest {
  root: string
  worktree: string
  branch: string
  force?: boolean
}

export class Workbench {
  readonly home: string
  readonly log: EventLog
  readonly registry: LaneRegistry
  readonly driver: WorkspaceDriver
  readonly workers: WorkerSupervisor
  readonly config: Config
  private readonly memory: Memory
  private readonly lock: HomeLock
  private readonly version: string
  private readonly sessionsRoot: string | undefined
  private readonly openedAt = Date.now()
  private closing: Promise<void> | null = null

  private constructor(opts: {
    home: string
    version: string
    driver: WorkspaceDriver
    log: EventLog
    registry: LaneRegistry
    workers: WorkerSupervisor
    config: Config
    lock: HomeLock
    sessionsRoot?: string
  }) {
    this.home = opts.home
    this.sessionsRoot = opts.sessionsRoot
    this.version = opts.version
    this.driver = opts.driver
    this.log = opts.log
    this.registry = opts.registry
    this.workers = opts.workers
    this.config = opts.config
    this.lock = opts.lock
    this.memory = Memory.open(opts.home)
  }

  static async open(opts: WorkbenchOptions): Promise<Workbench> {
    await mkdir(opts.home, { recursive: true })
    const lock = await lockHome(opts.home)
    try {
      // A broken config must not stop Wilco opening; `wilco config --check` is
      // where a typo gets reported, so here it degrades to defaults.
      const loaded = await loadConfig(join(opts.home, 'config.yaml'))
      const config = loaded.ok ? loaded.config : ConfigSchema.parse({})
      const driverName = opts.driver ?? config.workspace.driver
      const makeDriver = drivers[driverName]
      if (!makeDriver) throw new Error(`unknown workspace driver: ${driverName}`)

      const log = await EventLog.open({ path: join(opts.home, 'events.jsonl') })
      const driver = makeDriver(opts.home)
      const registry = await LaneRegistry.open({ driver, log, path: join(opts.home, 'lanes.json') })
      if (!loaded.ok) {
        await log.append({
          type: 'warning',
          detail: {
            message: `config.yaml is invalid, using defaults: ${loaded.issues[0]?.message ?? ''}`,
          },
        })
      }
      const workers = new WorkerSupervisor({
        adapter: new PiAdapter({
          runDir: join(opts.home, 'runs'),
          approvals: config.approvals.mode,
        }),
        log,
        approvals: { mode: config.approvals.mode, autoAllow: config.approvals.auto_allow },
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
        ...(opts.sessionsRoot ? { sessionsRoot: opts.sessionsRoot } : {}),
      })
      await log.append({
        type: 'wilco_opened',
        detail: { pid: process.pid, driver: driverName, lanes: registry.list().length },
      })
      // What the agents spent while we were away. Never fatal: an unreadable
      // session is a gap in the accounting, not a reason to refuse to open.
      await workbench.reconcileSpend().catch(() => {})
      return workbench
    } catch (err) {
      await lock.release()
      throw err
    }
  }

  /**
   * Account for what the agents spent while nobody was watching.
   *
   * The supervision extension reports each turn as it happens, but only while
   * Wilco is there to be told — and under a driver whose lanes outlive the
   * window, it often is not. pi writes every priced message to its own session
   * regardless, so on opening we compare what that says against what the
   * journal already knows and record the difference. The session file is the
   * ledger; the journal is a copy of it that can fall behind.
   *
   * Best effort by design: a session we cannot read leaves the accounting
   * short, which is a worse answer than the truth and a far better one than
   * refusing to open.
   */
  private async reconcileSpend(): Promise<void> {
    const journalled = spendFrom(await this.log.read({ types: ['usage'] }).catch(() => []))
    for (const lane of this.registry.list()) {
      if (lane.kind !== 'agent') continue
      const session = await usageOfTask(lane.task, {
        ...(this.sessionsRoot ? { root: this.sessionsRoot } : {}),
      }).catch(() => noUsage())
      if (session.messages === 0) continue
      const known = journalled.byTask[lane.task] ?? noSpend()
      const missing = {
        input: session.input - known.input,
        output: session.output - known.output,
        cacheRead: session.cacheRead - known.cacheRead,
        cacheWrite: session.cacheWrite - known.cacheWrite,
        tokens: session.tokens - known.tokens,
        usd: session.usd - known.usd,
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
          source: 'session',
          reason: 'spent while Wilco was closed',
        },
      })
    }
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
  // these exist so callers say `wilco.capture(lane)` rather than reaching
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

  capture(lane: LaneId, lines = 100): Promise<string> {
    return this.registry.capture(lane, lines)
  }

  resize(lane: LaneId, cols: number, rows: number): Promise<void> {
    return this.registry.resize(lane, cols, rows)
  }

  setTitle(lane: LaneId, title: string): Promise<void> {
    return this.registry.setTitle(lane, title)
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
    const task = await createTask({
      project: req.project,
      root,
      slug: req.slug,
      intent: req.intent,
      worktreeRoot: join(this.home, 'worktrees'),
      ...(req.base ? { base: req.base } : {}),
    })
    await this.log.append({
      type: 'task_created',
      task: task.id,
      detail: {
        branch: task.branch,
        worktree: task.worktree,
        base: task.base,
        // The journal is where "what was that about" gets answered.
        intent_spoken: req.intent,
      },
    })
    return task
  }

  /** Remove a task. Refuses to destroy uncommitted or unmerged work. */
  async removeTask(req: RemoveTaskRequest): Promise<RemoveResult> {
    const result = await removeTask(req)
    if (result.removed) {
      await this.log.append({
        type: 'task_removed',
        detail: { branch: req.branch, worktree: req.worktree, forced: req.force === true },
      })
    }
    return result
  }

  /** Set a task aside, or pick it back up. */
  async parkTask(worktree: string, parked: boolean): Promise<{ task: string; parked: boolean }> {
    const result = await setParked(worktree, parked)
    await this.log.append({
      type: 'state_change',
      task: result.task || null,
      detail: { state: parked ? 'parked' : 'resumed', by: 'you' },
    })
    return result
  }

  // --- notes

  /** Write something down, exactly as it was said. */
  remember(text: string, scope: string | null = null, by = 'unknown'): Note {
    return this.memory.remember(text, scope, by)
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

  // --- agents

  /**
   * Put an agent to work, in a lane you can watch.
   *
   * This is how agents run: pi as itself, in a terminal, driven by the same
   * keystrokes you would type. It outlives us exactly as far as the driver
   * says it does, and reopening finds it again rather than starting it over —
   * the lane by adoption, the conversation by pi's own session id.
   */
  async startAgent(req: StartRunRequest): Promise<LaneRecord> {
    this.guardParallel(req.task)
    await this.guardBudget(req.task)
    const lane = `${req.task}/agent` as LaneId
    const existing = this.registry.get(lane)
    if (existing?.alive) {
      // Two agents in one worktree is two agents editing the same files.
      throw new Error(`${req.task} already has an agent running: steer it or stop it first`)
    }
    const launch = new PiAdapter({
      runDir: join(this.home, 'runs'),
      approvals: this.config.approvals.mode,
    }).laneLaunchSpec({
      run: lane as unknown as RunId,
      task: req.task,
      cwd: req.cwd,
      prompt: req.prompt,
      model: req.model ?? this.modelFor(req.task),
      sandbox: {
        kind: req.sandbox ?? this.sandboxFor(req.task),
        worktree: req.worktree ?? req.cwd,
      },
    })
    return this.registry.spawn({
      id: lane,
      task: req.task,
      kind: 'agent',
      cwd: req.cwd,
      command: launch.command,
      args: launch.args,
      env: launch.env,
      title: req.task,
    })
  }

  /** Say something to a running agent, as though you had typed it. */
  async steerAgent(task: string, message: string): Promise<void> {
    const lane = `${task}/agent` as LaneId
    if (!this.registry.get(lane)?.alive) throw new Error(`no agent running on ${task}`)
    // The newline is the send: without it the words sit in pi's input box.
    await this.registry.write(lane, Buffer.from(`${message}\n`, 'utf8'))
  }

  async startRun(req: StartRunRequest): Promise<WorkerHandle> {
    this.guardParallel(req.task)
    await this.guardBudget(req.task)
    return this.workers.start({
      ...req,
      // A project names a route; the route names the model. Asking for one
      // explicitly still wins.
      model: req.model ?? this.modelFor(req.task),
      sandbox: req.sandbox ?? this.sandboxFor(req.task),
    })
  }

  runs(): WorkerHandle[] {
    return this.workers.list()
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

  events(filter: EventFilter = {}): Promise<WilcoEvent[]> {
    return this.log.read(filter)
  }

  subscribe(handler: (event: WilcoEvent) => void, filter: EventFilter = {}): Unsubscribe {
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
  private modelFor(task: string): WorkerModel | undefined {
    const project = task.split('/')[0]
    const route = resolveRoute(this.config, project ? { project } : {})
    if (!route.model) return undefined
    return { id: route.model, ...(route.provider ? { provider: route.provider } : {}) }
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

  private async doClose(): Promise<void> {
    await this.log.append({ type: 'wilco_closing', detail: { pid: process.pid } })
    await this.workers.shutdown()
    await this.registry.detach()
    await this.log.close()
    await this.lock.release()
  }

  /** Stop everything, lanes included, rather than letting go of it. */
  async stopEverything(): Promise<void> {
    await this.workers.shutdown()
    await this.registry.shutdown()
    await this.close()
  }
}

export type { LaneId, LaneRecord, SpawnRequest }

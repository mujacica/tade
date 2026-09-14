import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Config,
  ConfigSchema,
  checkBudget,
  composeAgentPrompt,
  type DoneRule,
  type EventFilter,
  expandHome,
  HARNESS_CHOICES,
  type LaneId,
  loadConfig,
  type Note,
  noSpend,
  resolveRoute,
  runtimeDir,
  type SandboxKind,
  spendFrom,
  startOfToday,
  type TaskId,
  THINKING_LEVELS,
  type ThinkingLevel,
  type Unsubscribe,
  type WilcoEvent,
  writeSetting,
} from '@wilco/core'
import type { WorkspaceCapabilities, WorkspaceDriver } from '@wilco/drivers-core'
import type {
  PermissionDecision,
  RunId,
  WorkerExtras,
  WorkerHandle,
  WorkerModel,
} from '@wilco/harnesses-core'
import {
  findModel,
  noUsage,
  sessionFileFor,
  sessionIdFor,
  usableModels,
  usageOfTask,
} from '@wilco/harnesses-pi'
import { git } from '@wilco/status'
import { parse as parseYaml } from 'yaml'
import { recordAuthored } from './authored.ts'
import { EventLog } from './events.ts'
import { HARNESS_ADAPTERS, type LaneHarness } from './harnesses.ts'
import { type HomeLock, lockHome } from './lock.ts'
import { Memory } from './memory.ts'
import { drivers, type LaneRecord, LaneRegistry, type SpawnRequest } from './registry.ts'
import {
  createTask,
  nameTask,
  type RemoveResult,
  removeTask,
  setParked,
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
  /**
   * What extensions give agents: extras at launch, and a way to run the tools
   * they call. Passed in, so the workbench never has to know what an extension
   * is — only that there may be more to hand an agent than its prompt.
   */
  extensions?: WorkbenchExtensions
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
  /** What the agent should know before it starts: written to `.wilco/context.md`. */
  context?: string
  /** Where the work came from, kept with the task and shown beside it. */
  links?: readonly { title: string; url: string }[]
  /** Where the agent works; the config's `agents.workspace` unless said. */
  workspace?: 'checkout' | 'worktree'
  /** Who asked for it, as `TaskOrigin` says it: kept with the task and in the journal. */
  by?: string
  /** How it counts as finished; `said` unless chosen. */
  done?: DoneRule
}

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
  private readonly lock: HomeLock
  private readonly version: string
  private readonly sessionsRoot: string | undefined
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
    sessionsRoot?: string
    extensions?: WorkbenchExtensions
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
    this.extensions = opts.extensions ?? null
  }

  static async open(opts: WorkbenchOptions): Promise<Workbench> {
    await mkdir(opts.home, { recursive: true })
    const lock = await lockHome(opts.home)
    try {
      // A broken config must not stop Wilco opening; `wilco config --check` is
      // where a typo gets reported, so here it degrades to defaults.
      const loaded = await loadConfig(join(opts.home, 'config.yaml'))
      const config = loaded.ok ? loaded.config : ConfigSchema.parse({})
      const log = await EventLog.open({ path: join(opts.home, 'events.jsonl') })
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
      const harnessOptions = {
        runDir: join(opts.home, 'runs'),
        socketDir: runtimeDir(opts.home),
        approvals: config.approvals.mode,
      }
      const adapters = Object.fromEntries(
        Object.entries(HARNESS_ADAPTERS).map(([id, make]) => [id, make(harnessOptions)]),
      )
      const defaultHarness = config.workers.routes[config.workers.default]?.harness ?? 'pi'
      const workers = new WorkerSupervisor({
        adapter: adapters[defaultHarness] ?? HARNESS_ADAPTERS.pi!(harnessOptions),
        adapters,
        log,
        approvals: {
          mode: config.approvals.mode,
          autoAllow: config.approvals.auto_allow,
          rules: config.approvals.rules,
        },
        // Written into the task, not held: the branch may be named long after,
        // by a window opened later.
        onTitle: (task, worktree, title, named) => {
          void setTitle(worktree, title, named, task).catch(() => {})
        },
        // A tool an agent calls runs in this process, where the extensions are.
        onExtensionCall: async (call) => {
          if (!opts.extensions) throw new Error('Wilco has no extensions loaded')
          return opts.extensions.call({ ...call, project: call.task.split('/')[0] ?? '' })
        },
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
        ...(opts.extensions ? { extensions: opts.extensions } : {}),
      })
      await log.append({
        type: 'wilco_opened',
        detail: { pid: process.pid, driver: driver.id, lanes: registry.list().length },
      })
      // Pick the agents that kept working back up: the channel first, so their
      // extensions can reconnect, then the spend that went unreported while
      // there was nothing for them to report to. Neither is fatal.
      // Anything an agent wrote for itself while nobody was looking gets a
      // commit now, so it is reviewable rather than merely present.
      await recordAuthored(
        expandHome(config.orchestrator.extensions),
        'tools proposed since Wilco was last open',
      )
      await recordAuthored(join(opts.home, 'skills'), 'lessons proposed since Wilco was last open')
      await workbench.resupervise().catch(() => {})
      await workbench.reconcileSpend().catch(() => {})
      return workbench
    } catch (err) {
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
      const resumed = await this.workers
        .resume({ task: lane.task as never, run: lane.id as RunId, cwd: lane.spec.cwd, prompt: '' })
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
          // What it last ran on, so the spend lands on a model rather than on "unknown".
          ...(session.model ? { model: session.model } : {}),
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

  /** The lane's screen. `styled` keeps its colour, for drawing it the way it looks. */
  capture(lane: LaneId, lines = 100, styled = false): Promise<string> {
    return this.registry.capture(lane, lines, styled)
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
    const workspace = req.workspace ?? this.config.agents.workspace
    if ((req.done === 'committed' || req.done === 'merged') && workspace !== 'worktree') {
      // In a shared checkout nothing is any one agent's to commit or merge.
      throw new Error(
        `a task in ${req.project}'s checkout cannot finish when ${req.done}: agents there share one branch. Use said, idle or manual`,
      )
    }
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
        ...(req.by ? { by: req.by } : {}),
        ...(req.done ? { done: req.done } : {}),
      },
    })
    return task
  }

  /**
   * Record that a task is finished: a person marking it, the orchestrator on
   * their word, or Wilco seeing the task's own rule met. Its agent says so
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
   * Refuse a name any task has had. pi keeps a conversation by the task's name,
   * so a new agent under a removed one's name would carry on its conversation —
   * and two names that make the same session id, `a.b` and `a-b`, share one.
   * The journal is what remembers a name after its task is gone.
   */
  private async guardName(id: string): Promise<void> {
    const session = sessionIdFor(id)
    const created = await this.log.read({ types: ['task_created'] }).catch(() => [])
    const clash = created.find(
      (event) => event.task && (event.task === id || sessionIdFor(event.task) === session),
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

  /** Take a note back, named by when it was said and what it said. False when there was no such note. */
  forget(note: { at: string; text: string }, by = 'unknown'): boolean {
    return this.memory.forget(note, by)
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
    if (this.registry.get(lane)?.alive) {
      // Two agents in one worktree is two agents editing the same files.
      throw new Error(`${req.task} already has an agent running: steer it or stop it first`)
    }
    const harness = req.harness ?? (await this.harnessOf(req.task, req.cwd))
    const extras = withWilco(
      req.extras ??
        this.extensions?.extras({
          project: req.task.split('/')[0] ?? '',
          task: req.task,
          cwd: req.cwd,
          harness,
        }),
      await this.agentPrompt(req.task, req.cwd, this.adapterFor(harness).capabilities.done),
    )
    const { chosen } = await this.taskFile(req.cwd, req.task)
    // The model new agents start on is for new agents. One coming back to its
    // conversation keeps the model that conversation was on, which its session
    // remembers — told the default instead, it would quietly change models.
    const resuming =
      (await sessionFileFor(req.task, this.sessionsRoot ? { root: this.sessionsRoot } : {}).catch(
        () => null,
      )) !== null
    const thinking = req.thinking ?? (resuming ? undefined : this.thinkingFor(req.task))
    const spec = {
      run: lane as RunId,
      task: req.task,
      cwd: req.cwd,
      prompt: req.prompt,
      ...(chosen ? { title: chosen } : {}),
      ...(extras ? { extras } : {}),
      model: req.model ?? (resuming ? undefined : this.modelFor(req.task)),
      ...(thinking ? { thinking } : {}),
      lane,
      sandbox: {
        kind: req.sandbox ?? this.sandboxFor(req.task),
        worktree: req.worktree ?? req.cwd,
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
      harness,
      ...(extras ? { extras } : {}),
    })
    const launch = this.adapterFor(harness).launchSpec(spec)
    try {
      const record = await this.registry.spawn({
        id: lane,
        task: req.task,
        kind: 'agent',
        cwd: req.cwd,
        command: launch.command,
        args: launch.args,
        env: launch.env,
        title: req.task,
      })
      this.followExit(lane)
      return record
    } catch (err) {
      // Nothing to supervise after all.
      await this.workers.stop(lane as RunId).catch(() => {})
      throw err
    }
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
      // No task file: an agent opened on a worktree Wilco did not make.
      return { intent: '', chosen: null }
    }
  }

  /** What an agent starting on a task is told about where it is. */
  private async agentPrompt(task: string, cwd: string, canSayDone: boolean): Promise<string> {
    const project = task.split('/')[0] ?? ''
    const configured = this.config.projects[project]
    const { intent } = await this.taskFile(cwd, task)
    const head = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const context = taskContextPath(cwd, task)
    const shared = taskFilePath(cwd, task) !== join(cwd, '.wilco', 'task.yaml')
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
      canSayDone,
    })
  }

  /** A harness's adapter, from the registry: the route's harness unless one is named. */
  private adapterFor(harness?: string): LaneHarness {
    const id = harness ?? this.config.workers.routes[this.config.workers.default]?.harness ?? 'pi'
    const make = HARNESS_ADAPTERS[id]
    if (!make)
      throw new Error(
        `no harness called ${id}: Wilco runs ${Object.keys(HARNESS_ADAPTERS).join(', ')}`,
      )
    return make({
      runDir: join(this.home, 'runs'),
      socketDir: runtimeDir(this.home),
      approvals: this.config.approvals.mode,
    })
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
    if (!choice.ready || !HARNESS_ADAPTERS[req.harness]) {
      throw new Error(
        `${choice.title} is ${choice.about}: Wilco runs ${Object.keys(HARNESS_ADAPTERS).join(', ')}`,
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
    if (this.registry.get(run as unknown as LaneId)?.alive) {
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
    const found = await this.resolveModel(said)
    // What it switched to is journalled by the agent itself, as the model its usage is priced at.
    await this.workers.setModel(run, found)
    this.keepAgentModel(task, found)
    return found
  }

  /**
   * A model chosen for an agent is the one new agents start on from then on,
   * until another is chosen: kept in the route the agent's project uses, which
   * is where Settings shows the agent model. Unset, the harness picks — and pi
   * picks by what you are signed in to, which is how every agent ended up on
   * the same model whatever anyone chose.
   */
  keepAgentModel(task: string, model: { provider: string; id: string }): void {
    this.keepAgentRoute(task, { provider: model.provider, model: model.id })
  }

  /** Change the route new agents in a task's project start on: in the file, and here. */
  private keepAgentRoute(
    task: string,
    change: { provider?: string; model?: string; thinking?: ThinkingLevel },
  ): void {
    const project = task.split('/')[0]
    const route = resolveRoute(this.config, project ? { project } : {})
    const path = join(this.home, 'config.yaml')
    try {
      for (const [key, value] of Object.entries(change)) {
        writeSetting(path, `workers.routes.${route.name}.${key}`, value)
      }
    } catch {
      // A config that cannot be written: this agent changed, and new ones
      // start where they did before.
      return
    }
    const { name: _name, ...kept } = route
    this.config = {
      ...this.config,
      workers: {
        ...this.config.workers,
        routes: { ...this.config.workers.routes, [route.name]: { ...kept, ...change } },
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
    // What it settled on is said back by the agent: a model that cannot think that hard takes less.
    await this.workers.setThinking(run, chosen)
    this.keepAgentRoute(task, { thinking: chosen })
    return chosen
  }

  /**
   * The model someone named, among the ones they are signed in to. Throws what
   * to ask them when it is not one model: before anything is started on it.
   */
  async resolveModel(said: string): Promise<{ provider: string; id: string }> {
    const found = findModel(said, await usableModels())
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
  private thinkingFor(task: string): ThinkingLevel | undefined {
    const project = task.split('/')[0]
    return resolveRoute(this.config, project ? { project } : {}).thinking
  }

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
    // Let go of both, ending neither: saying `shutdown` to an agent because a
    // window closed would stop exactly the work the tmux driver keeps alive.
    await this.workers.detach()
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

/**
 * What Wilco tells an agent about itself, before what extensions add. Said in
 * its instructions rather than its prompt, so it holds when the conversation
 * is reopened, and a prompt you typed yourself is never rewritten.
 */
function withWilco(extras: WorkerExtras | undefined, told: string): WorkerExtras {
  return {
    ...(extras ?? {}),
    instructions: [told, extras?.instructions ?? '']
      .filter((part) => part.trim() !== '')
      .join('\n\n'),
  }
}

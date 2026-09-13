import { chmod, mkdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import {
  type Config,
  ConfigSchema,
  type EventFilter,
  expandHome,
  type LaneId,
  loadConfig,
  resolveRoute,
  type SandboxKind,
} from '@wilco/core'
import type { WorkspaceDriver } from '@wilco/drivers-core'
import type { PermissionDecision, RunId } from '@wilco/harnesses-core'
import { PiAdapter } from '@wilco/harnesses-pi'
import { EventLog } from './events.ts'
import { Memory } from './memory.ts'
import { type DaemonInfo, Method, Notification, socketPath } from './protocol.ts'
import { drivers, LaneRegistry, type SpawnRequest } from './registry.ts'
import { createTask, type RemoveTaskOptions, removeTask, setParked } from './tasks.ts'
import { type StartRunRequest, WorkerSupervisor } from './workers.ts'

// vscode-jsonrpc is CommonJS.
const { createMessageConnection, SocketMessageReader, SocketMessageWriter } = createRequire(
  import.meta.url,
)('vscode-jsonrpc/node') as typeof import('vscode-jsonrpc/node')

export interface DaemonOptions {
  home: string
  socket?: string
  driver?: string
  version?: string
}

interface Connection {
  socket: Socket
  dispose(): void
  subscriptions: Map<string, () => void>
}

export class Daemon {
  readonly socketPath: string
  readonly log: EventLog
  readonly registry: LaneRegistry
  readonly driver: WorkspaceDriver
  readonly workers: WorkerSupervisor
  private readonly config: Config
  private readonly server: Server
  private readonly connections = new Set<Connection>()
  private readonly startedAt = Date.now()
  private readonly version: string
  private readonly home: string
  /** Opened here rather than in `start`: unlike the others it is synchronous. */
  private readonly memory: Memory
  private nextSubscription = 0
  private stopping: Promise<void> | null = null

  private constructor(
    opts: Required<Pick<DaemonOptions, 'home'>> & {
      socket: string
      version: string
      driver: WorkspaceDriver
      log: EventLog
      registry: LaneRegistry
      workers: WorkerSupervisor
      config: Config
      server: Server
    },
  ) {
    this.home = opts.home
    this.memory = Memory.open(opts.home)
    this.socketPath = opts.socket
    this.version = opts.version
    this.driver = opts.driver
    this.log = opts.log
    this.registry = opts.registry
    this.workers = opts.workers
    this.config = opts.config
    this.server = opts.server
  }

  static async start(opts: DaemonOptions): Promise<Daemon> {
    const socket = opts.socket ?? socketPath({ ...process.env, WILCO_HOME: opts.home })
    // A broken config must not stop the daemon booting; `wilco config --check`
    // is where a typo gets reported, so here it degrades to defaults.
    const loaded = await loadConfig(join(opts.home, 'config.yaml'))
    const config = loaded.ok ? loaded.config : ConfigSchema.parse({})
    // Explicit argument, then the config, then the default. The config used to
    // be ignored entirely, so `workspace.driver: tmux` did nothing.
    const driverName = opts.driver ?? config.workspace.driver
    const makeDriver = drivers[driverName]
    if (!makeDriver) throw new Error(`unknown workspace driver: ${driverName}`)

    // The OS caps Unix socket paths (104 bytes on macOS, 108 on Linux) and
    // reports a bare EINVAL when they're too long.
    const length = Buffer.byteLength(socket)
    if (length > 100) {
      throw new Error(`socket path is too long (${length} bytes, limit ~100): ${socket}`)
    }
    await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
    await removeStaleSocket(socket)

    const log = await EventLog.open({ path: join(opts.home, 'events.jsonl') })
    const driver = makeDriver()
    const registry = await LaneRegistry.open({
      driver,
      log,
      path: join(opts.home, 'lanes.json'),
    })
    if (!loaded.ok) {
      await log.append({
        type: 'warning',
        detail: {
          message: `config.yaml is invalid, using defaults: ${loaded.issues[0]?.message ?? ''}`,
        },
      })
    }

    const workers = new WorkerSupervisor({
      adapter: new PiAdapter({ runDir: join(opts.home, 'runs') }),
      log,
      approvals: { mode: config.approvals.mode, autoAllow: config.approvals.auto_allow },
    })

    const server = createServer()
    const daemon = new Daemon({
      home: opts.home,
      socket,
      version: opts.version ?? '0.0.0',
      driver,
      log,
      registry,
      workers,
      config,
      server,
    })

    server.on('connection', (s) => daemon.accept(s))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    // Only this user may talk to the daemon.
    await chmod(socket, 0o600)
    await log.append({ type: 'daemon_started', detail: { pid: process.pid, socket, driverName } })
    return daemon
  }

  /**
   * How the task's route says to contain a worker. Deliberately not caught: a
   * route that cannot be resolved fails the run rather than quietly starting
   * an agent with the whole disk writable.
   */
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

  private sandboxFor(task: string): SandboxKind {
    const project = task.split('/')[0]
    return resolveRoute(this.config, project ? { project } : {}).sandbox
  }

  private accept(socket: Socket): void {
    const connection = createMessageConnection(
      new SocketMessageReader(socket),
      new SocketMessageWriter(socket),
    )
    const entry: Connection = {
      socket,
      subscriptions: new Map(),
      dispose: () => connection.dispose(),
    }
    this.connections.add(entry)

    connection.onRequest(Method.info, (): DaemonInfo => this.info())
    connection.onRequest(Method.stop, async () => {
      queueMicrotask(() => void this.stop())
      return { stopping: true }
    })

    connection.onRequest(Method.laneSpawn, (req: SpawnRequest) => this.registry.spawn(req))
    connection.onRequest(Method.laneRelaunch, ({ lane }: { lane: LaneId }) =>
      this.registry.relaunch(lane),
    )
    connection.onRequest(Method.laneList, ({ task }: { task?: string } = {}) =>
      this.registry.list(task),
    )
    connection.onRequest(Method.laneGet, ({ lane }: { lane: LaneId }) => this.registry.get(lane))
    connection.onRequest(
      Method.laneWrite,
      async ({ lane, data }: { lane: LaneId; data: string }) => {
        await this.registry.write(lane, Buffer.from(data, 'base64'))
        return { ok: true }
      },
    )
    connection.onRequest(Method.laneCapture, ({ lane, lines }: { lane: LaneId; lines?: number }) =>
      this.registry.capture(lane, lines ?? 100),
    )
    connection.onRequest(
      Method.laneResize,
      async ({ lane, cols, rows }: { lane: LaneId; cols: number; rows: number }) => {
        await this.registry.resize(lane, cols, rows)
        return { ok: true }
      },
    )
    connection.onRequest(
      Method.laneSetTitle,
      async ({ lane, title }: { lane: LaneId; title: string }) => {
        await this.registry.setTitle(lane, title)
        return { ok: true }
      },
    )
    connection.onRequest(Method.laneClose, async ({ lane }: { lane: LaneId }) => {
      await this.registry.close(lane)
      return { ok: true }
    })

    connection.onRequest(
      Method.laneAttach,
      async ({ lane, lines }: { lane: LaneId; lines?: number }) => {
        const record = this.registry.get(lane)
        if (!record) throw new Error(`no such lane: ${lane}`)
        const id = `sub-${++this.nextSubscription}`
        const snapshot = await this.registry.capture(lane, lines ?? 200)
        const stopOutput = this.registry.onOutput(lane, (chunk) => {
          void connection.sendNotification(Notification.laneData, {
            subscription: id,
            data: Buffer.from(chunk).toString('base64'),
          })
        })
        const stopExit = this.driver.onExit(lane, ({ code, signal }) => {
          void connection.sendNotification(Notification.laneExit, {
            subscription: id,
            code,
            signal,
          })
        })
        entry.subscriptions.set(id, () => {
          stopOutput()
          stopExit()
        })
        return {
          subscription: id,
          snapshot,
          cols: record.spec.cols ?? 80,
          rows: record.spec.rows ?? 24,
        }
      },
    )
    connection.onRequest(Method.laneDetach, ({ subscription }: { subscription: string }) => {
      entry.subscriptions.get(subscription)?.()
      entry.subscriptions.delete(subscription)
      return { ok: true }
    })

    connection.onRequest(
      Method.taskCreate,
      async (req: {
        project: string
        slug: string
        intent: string
        root?: string
        base?: string
      }) => {
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
      },
    )
    connection.onRequest(Method.taskRemove, async (req: RemoveTaskOptions) => {
      const result = await removeTask(req)
      if (result.removed) {
        await this.log.append({
          type: 'task_removed',
          detail: { branch: req.branch, worktree: req.worktree, forced: req.force === true },
        })
      }
      return result
    })

    connection.onRequest(Method.taskPark, async (req: { worktree: string; parked: boolean }) => {
      const result = await setParked(req.worktree, req.parked)
      await this.log.append({
        type: 'state_change',
        task: result.task || null,
        detail: { state: req.parked ? 'parked' : 'resumed', by: 'you' },
      })
      return result
    })

    connection.onRequest(
      Method.memoryRemember,
      ({ text, scope, by }: { text: string; scope?: string | null; by?: string }) =>
        this.memory.remember(text, scope ?? null, by ?? 'unknown'),
    )
    // No scope at all asks for everything; an explicit null asks for only what
    // was said about nothing in particular.
    connection.onRequest(Method.memoryRecall, ({ scope }: { scope?: string | null } = {}) =>
      scope === undefined ? this.memory.all() : this.memory.recall(scope),
    )

    connection.onRequest(Method.workerStart, (req: StartRunRequest) => {
      this.guardParallel(req.task)
      return this.workers.start({ ...req, sandbox: req.sandbox ?? this.sandboxFor(req.task) })
    })
    connection.onRequest(Method.workerList, () => this.workers.list())
    connection.onRequest(Method.workerPending, ({ task }: { task?: string } = {}) =>
      this.workers.pending(task),
    )
    connection.onRequest(
      Method.workerPrompt,
      async ({ run, message }: { run: RunId; message: string }) => {
        await this.workers.prompt(run, message)
        return { ok: true }
      },
    )
    connection.onRequest(
      Method.workerSteer,
      async ({ run, message }: { run: RunId; message: string }) => {
        await this.workers.steer(run, message)
        return { ok: true }
      },
    )
    connection.onRequest(
      Method.workerDecide,
      async (req: { run: RunId; requestId: string; decision: PermissionDecision }) => {
        await this.workers.decide(req.run, req.requestId, req.decision)
        return { ok: true }
      },
    )
    connection.onRequest(Method.workerStop, async ({ run }: { run: RunId }) => {
      await this.workers.stop(run)
      return { ok: true }
    })

    connection.onRequest(Method.eventsRead, (filter: EventFilter = {}) => this.log.read(filter))
    connection.onRequest(Method.eventsSubscribe, (filter: EventFilter = {}) => {
      const id = `sub-${++this.nextSubscription}`
      const stop = this.log.subscribe((event) => {
        void connection.sendNotification(Notification.event, { subscription: id, event })
      }, filter)
      entry.subscriptions.set(id, stop)
      return { subscription: id }
    })
    connection.onRequest(Method.eventsUnsubscribe, ({ subscription }: { subscription: string }) => {
      entry.subscriptions.get(subscription)?.()
      entry.subscriptions.delete(subscription)
      return { ok: true }
    })

    socket.on('close', () => this.drop(entry))
    socket.on('error', () => this.drop(entry))
    connection.listen()
  }

  private drop(entry: Connection): void {
    if (!this.connections.delete(entry)) return
    for (const stop of entry.subscriptions.values()) stop()
    entry.subscriptions.clear()
    entry.dispose()
    entry.socket.destroy()
  }

  info(): DaemonInfo {
    return {
      pid: process.pid,
      version: this.version,
      driver: this.driver.id,
      capabilities: { ...this.driver.capabilities },
      socket: this.socketPath,
      home: this.home,
      startedAt: this.startedAt,
      lanes: this.registry.list().filter((l) => l.alive).length,
      runs: this.workers.list().length,
      approvals: this.config.approvals.mode,
    }
  }

  async stop(): Promise<void> {
    this.stopping ??= this.doStop()
    return this.stopping
  }

  private async doStop(): Promise<void> {
    await this.log.append({ type: 'daemon_stopping', detail: { pid: process.pid } })
    for (const entry of [...this.connections]) this.drop(entry)
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    // Supervised agents are the daemon's children too: stop them before the
    // log closes, so their exits are recorded.
    await this.workers.shutdown()
    await this.registry.shutdown()
    await this.log.close()
    await rm(this.socketPath, { force: true })
  }
}

/** A socket file left behind by a crashed daemon is not a running daemon. */
async function removeStaleSocket(path: string): Promise<void> {
  try {
    await stat(path)
  } catch {
    return
  }
  const { connect } = await import('node:net')
  await new Promise<void>((resolve) => {
    const probe = connect(path)
    probe.on('connect', () => {
      probe.destroy()
      resolve(Promise.reject(new Error(`daemon already running at ${path}`)) as never)
    })
    probe.on('error', () => {
      probe.destroy()
      void rm(path, { force: true }).then(() => resolve())
    })
  })
}

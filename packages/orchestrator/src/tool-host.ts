import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import {
  type Arm,
  type DoneRule,
  inboxProvenance,
  inboxWaiting,
  type LaneId,
  LOCAL,
  type Plan,
  planReport,
  type When,
} from '@tade/core'
import type { PermissionDecision, RunId, WorkerImage } from '@tade/harnesses-core'
import {
  chatsFrom,
  clipped,
  inboxFrom,
  inboxItem,
  intakeWouldRun,
  openChat,
  readTaskFile,
  type Workbench,
  wouldRunSays,
} from '@tade/workbench'
import { documentMethods } from './host-documents.ts'
import { lessonMethods } from './host-lessons.ts'
import { machineMethods, type UpdateHost } from './host-machine.ts'
import { doneRuleOf, scheduleMethods } from './host-queue.ts'
import { type RaceHost, raceMethods } from './host-race.ts'
import { type ReplayHost, replayMethods } from './host-replay.ts'
import { templateMethods } from './host-templates.ts'
import { type Arming, allowMethod, allowTool, waiting, writtenBy } from './origin.ts'

// How the orchestrator's tools reach the workbench.
//
// The orchestrator is pi, and its tools run inside pi, which is a separate
// process — so `tade_run_start` has to come back out to whoever is holding
// the lanes and the journal. This is that way back: one socket, hosted by the
// window that owns the workbench, for its own children only.
//
// It is not a daemon and must never grow into one. Nothing discovers it (the
// path is handed to the child in its environment), nothing outside this
// process tree may connect, and it dies with the window. The test is simple:
// if something that is not our own child would ever want to call it, it has
// stopped being a channel and become a service.

export interface ToolHostOptions {
  tade: Workbench
  /** Where the socket goes. One per host, so two windows never collide. */
  path: string
  /** A terminal was opened or used, so the window can put it in front of you. */
  onTerminal?: (terminal: string) => void
  /**
   * Finds the model the orchestrator was asked to think with and keeps it for
   * the next start. Without it, the orchestrator cannot change its own model.
   */
  orchestratorModel?: (said: string) => Promise<{ provider: string; id: string }>
  /**
   * What goes with the prompt of an agent the orchestrator starts: the files
   * attached to what it is answering, put where the agent works (`cwd`), a
   * sentence saying where, and the pictures among them.
   */
  handOff?: (task: string) => Promise<{ note: string; images: readonly WorkerImage[] }>
  /**
   * Where everything stands, as the window sees it. Only the process
   * supervising the agents knows which of them are between turns; `tade
   * status` from outside it calls every running agent working.
   */
  status?: () => Promise<unknown>
  /**
   * The queue, as the window runs it: planning work, saying where it stands,
   * and changing it. Without a window there is nothing to start queued work,
   * so there is no queue.
   */
  queue?: {
    describe(): Promise<string>
    change(req: {
      task?: string
      schedule?: string
      project?: string
      change: string
      name?: string
      /** For `order`: the queued tasks, first to last. */
      order?: readonly string[]
      /** For `after`: what it waits on, each with why; with `replace`, instead of what it did. */
      after?: readonly { task: string; why: string }[]
      replace?: boolean
      /** For `retell`: what it is told when it starts, and what it says it will change. */
      prompt?: string
      touches?: readonly string[]
      /** For `remove`: what waited on it is held (the default), or waits on what it waited on. */
      dependents?: 'hold' | 'inherit'
    }): Promise<string>
    plan(plan: Plan): Promise<string>
    schedule(req: {
      name: string
      project: string
      said: string
      when?: When
      agent?: string
      ask?: string
      watch?: string
      input?: Record<string, unknown>
      found?: 'agent' | 'ask'
      most?: number
      decides?: 'orchestrator' | 'itself'
      done?: DoneRule
      missed?: 'once' | 'skip'
    }): Promise<string>
    /** What was decided about work a schedule or a watch made parked for the orchestrator. */
    decide(req: {
      task: string
      decision: string
      because: string
      on?: string
      message?: string
    }): Promise<string>
  }
  /**
   * Changing what Tade has been told: reading the settings it offers, writing
   * one back, and opening or closing a project.
   *
   * The window's, not the workbench's, and for the same reason the queue is:
   * a setting written has to be read back, checked against the schema and used
   * everywhere that holds a config — the window, the workbench, the extension
   * host — and only the window can do that. Where the boundary refuses, it
   * throws with what a person would do instead, which is what the model reads.
   */
  config?: {
    settings(find: string): Promise<string>
    change(req: { path: string; value: string; said: string }): Promise<string>
    openProject(req: { path: string; name?: string; create: boolean }): Promise<string>
    closeProject(req: { project: string; said: string }): Promise<string>
    renameProject(req: { project: string; name: string; said: string }): Promise<string>
    reorderProjects(req: { order: readonly string[] }): Promise<string>
    configureProject(req: {
      project: string
      setting: string
      value: string
      said: string
    }): Promise<string>
  }
  /**
   * What Tade is watching for, and turning one watch on or off.
   *
   * The window's, like the config, and for the same reason: a watch is a
   * schedule in a project, the schedules are the window's, and the boundary
   * that decides whether the orchestrator may touch one is enforced there
   * rather than in the tool — a rule that lives where the model lives is a
   * rule the model can be talked out of.
   */
  watches?: {
    list(find: string): Promise<string>
    change(req: { watch: string; project: string; on: boolean; said: string }): Promise<string>
  }
  /**
   * How far the turn in flight reaches, and what a narrowed one is answered
   * with (`Arming`, in `origin.ts` beside the tables it is asked about).
   *
   * **Optional, and its absence is the guarantee.** With nothing handed over,
   * every call is `LOCAL` and this host behaves exactly as it did — which is
   * what a window with `surfaces.web.orchestrator` off hands over, so there is
   * no remote arm to be in and no narrowing to get wrong.
   */
  remote?: Arming
  /** Updating what Tade runs, and reloading the window: the window's (`host-machine.ts`). */
  updates?: UpdateHost
  /** Starting, reading and picking a race: the window's (`host-race.ts`). */
  race?: RaceHost
  /** Starting a replay and reading one: the window's (`host-replay.ts`). */
  replay?: ReplayHost
  /** Runs the orchestrator's extension tools. Without it, it has none. */
  extensions?: (call: {
    tool: string
    input: Record<string, unknown>
    callId: string
  }) => Promise<string>
}

type Handler = (params: Record<string, unknown>, arm: Arm) => unknown | Promise<unknown>

/** Which terminal a call names, as said: an id, a name, a number, or nothing when there is one. */
const said = (p: Record<string, unknown>): string => (p.terminal ? String(p.terminal) : '')
const project = (p: Record<string, unknown>): string | undefined =>
  p.project ? String(p.project) : undefined

export class ToolHost {
  readonly path: string
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private readonly methods: Record<string, Handler>
  private readonly opts: ToolHostOptions

  private constructor(
    path: string,
    server: Server,
    methods: Record<string, Handler>,
    opts: ToolHostOptions,
  ) {
    this.path = path
    this.server = server
    this.methods = methods
    this.opts = opts
  }

  static async listen(opts: ToolHostOptions): Promise<ToolHost> {
    const { tade } = opts
    const methods: Record<string, Handler> = {
      'task/create': (p) =>
        tade.createTask({
          project: String(p.project),
          slug: String(p.slug),
          intent: String(p.intent),
          ...(p.root ? { root: String(p.root) } : {}),
          ...(p.base ? { base: String(p.base) } : {}),
          ...(p.context ? { context: String(p.context) } : {}),
          ...(Array.isArray(p.links) ? { links: linksOf(p.links) } : {}),
          ...(p.done ? { done: doneRuleOf(p.done) } : {}),
          ...(p.produces ? { produces: String(p.produces) } : {}),
          by: 'orchestrator',
        }),
      'task/done': async (p) => {
        await tade.markDone(String(p.task), {
          by: 'orchestrator',
          ...(p.summary ? { summary: String(p.summary) } : {}),
        })
        return `${String(p.task)} is finished`
      },
      // Documents tasks produced: `host-documents.ts`, where the boundary is.
      ...documentMethods(tade),
      // A mistake seen twice, proposed as a check and parked: `host-lessons.ts`.
      ...lessonMethods(tade),
      // Updating what Tade runs and reloading the window: `host-machine.ts`.
      ...machineMethods(() => opts.updates),
      'queue/plan': async (p) => queueOf(opts).plan(planOf(p)),
      'queue/list': async () => queueOf(opts).describe(),
      // Stored workflows: `host-templates.ts`, where the boundary is.
      ...templateMethods(tade),
      // Races, which the window's queue starts and the person picks: `host-race.ts`.
      ...raceMethods(() => opts.race),
      // Replays, which the window's queue starts and paces: `host-replay.ts`.
      ...replayMethods(() => opts.replay),
      // Work that arrived from outside, read and never acted on. Two methods
      // and deliberately not a third: there is no way from here to approve,
      // refuse or retry one, and no way to change a grant — `settingReach`
      // has the whole `surfaces.intake` subtree at `never`, and the text the
      // orchestrator reads all day does not get to put itself on an allowlist.
      //
      // Neither answer carries the request's own words. `inboxFrom` and
      // `inboxProvenance` have nowhere to put a body, which is the
      // enforcement: `openIntakeRow` is the door that reads one and it is not
      // called here, and could not be — an orchestrator that had read a
      // stranger's instructions is one whose next turn might act on them.
      'intake/list': async (p) => {
        const rows = await inboxFrom({
          home: tade.home,
          events: await tade.log.read({}),
          ...(p.project ? { project: String(p.project) } : {}),
        })
        return JSON.stringify(p.waiting === true ? inboxWaiting(rows) : rows, null, 2)
      },
      'intake/show': async (p) => {
        const item = String(p.item ?? '')
        const row = await inboxItem({ home: tade.home, events: await tade.log.read({}), item })
        if (!row) throw new Error(`nothing called ${item} has been handed to this machine`)
        const would = await intakeWouldRun(
          { home: tade.home, config: tade.config, events: (filter) => tade.log.read(filter) },
          row,
          planReport(tade.planUsage(), Date.now()).signIns.map((one) =>
            one.cannotTell ? `${one.label}: cannot tell — ${one.cannotTell}` : one.label,
          ),
        )
        return [
          ...inboxProvenance(row).map((fact) => `${fact.label}: ${fact.value}`),
          `state: ${row.state} — ${row.because}`,
          '',
          ...wouldRunSays(would),
        ].join('\n')
      },
      'queue/change': async (p) =>
        queueOf(opts).change({
          ...(p.task ? { task: String(p.task) } : {}),
          ...(p.schedule ? { schedule: String(p.schedule) } : {}),
          ...(p.project ? { project: String(p.project) } : {}),
          ...(p.name ? { name: String(p.name) } : {}),
          ...(Array.isArray(p.order) ? { order: p.order.map(String) } : {}),
          ...(Array.isArray(p.after) ? { after: waitsOf(p.after) } : {}),
          ...(p.replace === true ? { replace: true } : {}),
          ...(typeof p.prompt === 'string' ? { prompt: p.prompt } : {}),
          ...(Array.isArray(p.touches) ? { touches: p.touches.map(String) } : {}),
          ...(p.dependents === undefined ? {} : { dependents: dependentsOf(p.dependents) }),
          change: String(p.change ?? ''),
        }),
      // Work on a clock, and what is decided about what one makes: `host-queue.ts`.
      ...scheduleMethods(() => queueOf(opts)),
      'config/settings': async (p) => configOf(opts).settings(p.find ? String(p.find) : ''),
      'config/change': async (p) =>
        configOf(opts).change({
          path: String(p.path ?? ''),
          value: String(p.value ?? ''),
          said: String(p.said ?? ''),
        }),
      'watch/list': async (p) => watchesOf(opts).list(p.find ? String(p.find) : ''),
      'watch/change': async (p) =>
        watchesOf(opts).change({
          watch: String(p.watch ?? ''),
          project: String(p.project ?? ''),
          on: p.on === true,
          said: String(p.said ?? ''),
        }),
      'project/open': async (p) =>
        configOf(opts).openProject({
          path: String(p.path ?? ''),
          ...(p.name ? { name: String(p.name) } : {}),
          create: p.create === true,
        }),
      'project/close': async (p) =>
        configOf(opts).closeProject({
          project: String(p.project ?? ''),
          said: String(p.said ?? ''),
        }),
      'project/rename': async (p) =>
        configOf(opts).renameProject({
          project: String(p.project ?? ''),
          name: String(p.name ?? ''),
          said: String(p.said ?? ''),
        }),
      'project/reorder': async (p) => {
        // The window first, then the argument, like every other method here:
        // with nothing holding the config there is nothing to reorder whatever
        // was passed, and answering about the argument instead sends whoever
        // asked off to fix a list that was never the problem.
        const config = configOf(opts)
        if (!Array.isArray(p.order))
          throw new Error('order is the projects, first to last: a list of their names')
        return config.reorderProjects({ order: p.order.map((name) => String(name)) })
      },
      'project/configure': async (p) =>
        configOf(opts).configureProject({
          project: String(p.project ?? ''),
          setting: String(p.setting ?? ''),
          value: String(p.value ?? ''),
          said: String(p.said ?? ''),
        }),
      // Where each sign-in stands against its plan. Read from what the
      // harnesses already hold, so it asks nobody anything; it changes nothing
      // and there is no method here that would, because which sign-in agents
      // run as is a person's.
      'plan/limits': async () => planReport(tade.planUsage(), Date.now()),
      // **The gate itself**, asked by Tade's own tools extension before every
      // tool this session has — its own and the harness's alike. It answers a
      // decision and nothing else, which is why a remote turn may reach it:
      // the alternative is a gate that cannot be asked during the turn it is
      // for.
      'origin/allow': (p, arm) => {
        const tool = String(p.tool ?? '')
        const said = allowTool(tool, arm)
        if (said.ok) return { allow: true }
        opts.remote?.refused(arm, tool, said.said)
        return { allow: false, reason: said.said }
      },
      'status/read': async (_p, arm) => {
        // A remote turn is answered with that device's own projection, which
        // is the narrowing rather than a filter over a wider answer: nothing
        // is taken out of `tade status` here, because `tade status` is never
        // built for one.
        if (arm.how === 'remote') {
          if (!opts.remote) throw new Error('this Tade cannot answer a paired device')
          return opts.remote.seen(arm)
        }
        if (!opts.status) throw new Error('this Tade has no window to ask')
        return opts.status()
      },
      'extension/call': async (p) => {
        if (!opts.extensions) throw new Error('Tade has no extensions loaded')
        const input = (p.input ?? {}) as Record<string, unknown>
        const tool = String(p.tool)
        // Written down before it runs: an act with a who and a why — how an
        // override is read back out of the journal — and one that failed
        // still happened.
        await tade.log.append({
          type: 'tool_call',
          detail: { tool, input: clipped(input), caller: 'orchestrator' },
        })
        return opts.extensions({ tool, input, callId: String(p.callId ?? '') })
      },
      'task/park': (p) => tade.parkTask(String(p.task), p.parked === true),
      'task/rename': (p) =>
        tade.renameAgent({
          task: String(p.task),
          worktree: String(p.worktree),
          title: String(p.title),
        }),
      'worker/model': (p) => tade.setAgentModel(String(p.task), String(p.model)),
      'worker/thinking': async (p) => ({
        level: await tade.setAgentThinking(String(p.task), String(p.level)),
      }),
      'worker/harness': (p) =>
        tade.setAgentHarness({
          task: String(p.task),
          worktree: String(p.worktree),
          harness: String(p.harness),
        }),
      'orchestrator/model': (p) => {
        if (!opts.orchestratorModel)
          throw new Error('this window cannot change the orchestrator model')
        return opts.orchestratorModel(String(p.model))
      },
      'worker/start': async (p) => {
        // The model is settled before anything starts: one that cannot be
        // found is a question for the human, never a run on some other model.
        const prompt = String(p.prompt ?? '')
        const cwd = String(p.cwd)
        // Among what the task's own harness offers.
        const model = p.model
          ? await tade.resolveModelFor(String(p.task), cwd, String(p.model))
          : undefined
        // Files go with something to say about them. A start that says nothing
        // opens the agent, and must not set it working on a picture alone.
        const handed = prompt.trim() && opts.handOff ? await opts.handOff(String(p.task)) : null
        return tade.startAgent({
          task: String(p.task) as never,
          cwd,
          prompt: handed?.note ? `${prompt}\n\n${handed.note}` : prompt,
          ...(model ? { model } : {}),
          ...(handed?.images.length ? { images: handed.images } : {}),
        })
      },
      'worker/list': () => tade.runs(),
      // Narrowed on the way out for a remote arm: the tool's name, the run and
      // the request, and never the harness's own summary of the command. The
      // page is shown the same (`TaskIn.approval`), for the same reason.
      'worker/pending': (p, arm) =>
        waiting(tade.pendingApprovals(p.task ? String(p.task) : undefined), arm),
      'worker/steer': async (p) => {
        const task = String(p.task)
        await tade.steerAgent(task, String(p.message)).catch(async (err: unknown) => {
          throw (await notStartedYet(tade, task)) ?? err
        })
        return { ok: true }
      },
      'worker/stop': async (p) => {
        await tade.stopAgent(String(p.task))
        return { ok: true }
      },
      'worker/decide': async (p) => {
        await tade.decideApproval(
          String(p.run) as RunId,
          String(p.requestId),
          p.decision as PermissionDecision,
        )
        return { ok: true }
      },
      // `by` is **rewritten** for a remote arm and never taken from the call:
      // a note the orchestrator wrote because a phone asked for it is the
      // phone's, and one filed as the orchestrator's own is the same
      // provenance hole as a remote act recorded as `you`.
      'memory/remember': (p, arm) =>
        tade.remember(
          String(p.text),
          p.scope === null || p.scope === undefined ? null : String(p.scope),
          writtenBy(arm, p.by),
          p.summary ? String(p.summary) : null,
        ),
      'events/read': (p) => tade.events(p as never),
      // Chats: agents in the lower pane with no task. Listed and opened here;
      // steered and stopped through `worker/steer` and `worker/stop` by the
      // task id this hands back, because that is what they are — agents — and
      // a second pair of verbs for the same act is a second thing to keep in
      // step.
      'chat/list': () => chatsFrom(tade.lanes()),
      'chat/open': async (p) => {
        const opened = await openChat(tade, {
          ...(p.harness ? { harness: String(p.harness) } : {}),
          ...(p.cwd ? { cwd: String(p.cwd) } : {}),
          ...(p.prompt ? { prompt: String(p.prompt) } : {}),
        })
        opts.onTerminal?.(opened.id)
        return opened
      },
      'terminal/list': (p) => tade.terminals(p.project ? String(p.project) : undefined),
      'terminal/open': async (p) => {
        const opened = await tade.openTerminal({
          project: String(p.project),
          ...(p.name ? { name: String(p.name) } : {}),
          ...(p.cwd ? { cwd: String(p.cwd) } : {}),
        })
        opts.onTerminal?.(opened.id)
        return opened
      },
      'terminal/close': (p) => tade.closeTerminal(said(p), project(p)),
      'terminal/rename': (p) => tade.renameTerminal(said(p), String(p.name), project(p)),
      'terminal/run': async (p) => {
        const ran = await tade.runInTerminal(said(p), String(p.command), {
          submit: p.submit !== false,
          ...(project(p) ? { project: project(p) } : {}),
        })
        opts.onTerminal?.(ran.id)
        return ran
      },
      'terminal/read': (p) =>
        tade.readTerminal(said(p), Number(p.lines) > 0 ? Number(p.lines) : 200, project(p)),
      'terminal/search': (p) => tade.searchTerminal(said(p), String(p.text), project(p)),
      'lane/write': async (p) => {
        await tade.write(String(p.lane) as LaneId, String(p.data))
        return { ok: true }
      },
    }

    await mkdir(dirname(opts.path), { recursive: true, mode: 0o700 })
    await rm(opts.path, { force: true })
    const server = createServer()
    const host = new ToolHost(opts.path, server, methods, opts)
    server.on('connection', (socket) => host.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(opts.path, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    // Only this user, and only ever this user's own agents.
    await chmod(opts.path, 0o600)
    return host
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const split = buffer.indexOf('\r\n\r\n')
        if (split < 0) return
        const header = buffer.subarray(0, split).toString('utf8')
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0)
        const start = split + 4
        if (buffer.byteLength < start + length) return
        const body = buffer.subarray(start, start + length).toString('utf8')
        buffer = buffer.subarray(start + length)
        void this.dispatch(socket, body)
      }
    })
  }

  /**
   * How far this call reaches, asked at the call and never cached.
   *
   * A throw out of the window's own reader is answered with `LOCAL`? No: the
   * safe answer to *whose turn is this* is the narrowest one there is, so a
   * reader that threw is read as a remote arm granted nothing. A window that
   * cannot say who is asking must not be read as saying the person is.
   */
  private armOf(): Arm {
    const remote = this.opts.remote
    if (!remote) return LOCAL
    try {
      return remote.arm()
    } catch {
      return { how: 'remote', device: '', projects: [], may: [] }
    }
  }

  private async dispatch(socket: Socket, body: string): Promise<void> {
    let id: unknown = null
    try {
      const message = JSON.parse(body) as {
        id?: unknown
        method?: string
        params?: Record<string, unknown>
      }
      id = message.id ?? null
      const method = message.method ?? ''
      const handler = this.methods[method]
      if (!handler) throw new Error(`no such method: ${message.method}`)
      const params = message.params ?? {}
      // **The gate, and it is in front of every method rather than inside the
      // ones somebody remembered.** A connection to this socket is the only
      // way in, so a tool the harness's own gate let through, a tool call Tade
      // never registered, and a second process of the same agent are all
      // judged here by the same table.
      const arm = this.armOf()
      if (arm.how === 'remote') {
        const allowed = allowMethod(method, params, arm, this.projectFor(method, params))
        if (!allowed.ok) {
          this.opts.remote?.refused(arm, method, allowed.said)
          throw new Error(allowed.said)
        }
      }
      reply(socket, { jsonrpc: '2.0', id, result: (await handler(params, arm)) ?? null })
    } catch (err) {
      // A tool that fails must say why in words the model can act on, not
      // drop the connection and leave it guessing.
      reply(socket, {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * The project a call is about, for the one method whose project only the
   * window can find.
   *
   * `worker/decide` names a run and a request, and which task a run belongs to
   * is the supervisor's answer rather than something in the call — so a remote
   * arm's project check for it goes through the approval it names. An approval
   * that is not there answers `null` and the method's own re-check refuses it
   * as gone, which is the right order: *not found* is not *out of scope*.
   */
  private projectFor(method: string, params: Record<string, unknown>): string | null {
    if (method !== 'worker/decide') return null
    const run = String(params.run ?? '')
    const request = String(params.requestId ?? '')
    const found = this.opts.tade
      .pendingApprovals()
      .find((one) => one.run === run && one.requestId === request)
    if (!found) return null
    const cut = found.task.indexOf('/')
    return cut <= 0 ? null : found.task.slice(0, cut)
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    await rm(this.path, { force: true })
  }
}

function reply(socket: Socket, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  socket.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
  socket.write(body)
}

/** What changes the config, or why there is nothing to change it with. */
function configOf(opts: ToolHostOptions): NonNullable<ToolHostOptions['config']> {
  if (!opts.config)
    throw new Error(
      'changing how Tade is set up needs the Tade window open, which is what holds the config',
    )
  return opts.config
}

/** What the watches are, or why there is nothing to ask. */
function watchesOf(opts: ToolHostOptions): NonNullable<ToolHostOptions['watches']> {
  if (!opts.watches)
    throw new Error(
      'watches need the Tade window open: a watch is a schedule, and nothing runs one without it',
    )
  return opts.watches
}

/** The window's queue, or why there is none to use. */
function queueOf(opts: ToolHostOptions): NonNullable<ToolHostOptions['queue']> {
  if (!opts.queue) throw new Error('queued work needs the Tade window open, which starts it')
  return opts.queue
}

/** A plan as the orchestrator sent it, read carefully: anything malformed is said, not guessed. */
function planOf(p: Record<string, unknown>): Plan {
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  if (!Array.isArray(p.agents)) throw new Error('a plan needs agents: a list of them')
  return {
    project: text(p.project),
    said: text(p.said),
    ...(p.effort ? { effort: text(p.effort) } : {}),
    ...(p.context ? { context: text(p.context) } : {}),
    agents: p.agents.map((raw) => {
      const agent = (raw ?? {}) as Record<string, unknown>
      return {
        name: text(agent.name),
        ...(agent.project ? { project: text(agent.project) } : {}),
        said: text(agent.said),
        prompt: text(agent.prompt),
        ...(agent.done ? { done: doneRuleOf(agent.done) } : {}),
        ...(agent.produces ? { produces: text(agent.produces) } : {}),
        after: (Array.isArray(agent.after) ? agent.after : []).map((dep) => {
          const one = (dep ?? {}) as Record<string, unknown>
          const approved = one.approved === true ? { approved: true } : {}
          return { agent: text(one.agent), why: text(one.why), ...approved }
        }),
        touches: (Array.isArray(agent.touches) ? agent.touches : []).map(text).filter(Boolean),
        ...(agent.at ? { at: text(agent.at) } : {}),
        ...(agent.model ? { model: text(agent.model) } : {}),
        ...(agent.thinking ? { thinking: text(agent.thinking) } : {}),
      }
    }),
  }
}

/**
 * Why a task cannot be steered, when the reason is that it is queued and its
 * agent has never run: what does reach it, instead of "no agent running".
 *
 * Told only that, the orchestrator removed queued work to plan it again with
 * the new words — a design task made three times on 2026-10-11 — when a note
 * scoped to the task was already in what its agent is told when it starts
 * (`agentPrompt`). Here and not in `steerAgent`, because the words name the
 * orchestrator's tools and the CLI steers through the workbench too.
 */
async function notStartedYet(tade: Workbench, task: string): Promise<Error | null> {
  const file = await readTaskFile(tade.home, task).catch(() => null)
  if (!file?.start) return null
  const ran = await tade.events({ types: ['run_started'], task, limit: 1 }).catch(() => null)
  // A journal that would not answer cannot say it never ran.
  if (ran === null || ran.length > 0) return null
  return new Error(
    `${task} has not started: tade_queue_change retell changes what it will be told; a note scoped to it (tade_remember about: ${task}) is in what it is told when it starts`,
  )
}

/** Links as a model sent them: only the ones with somewhere to go. */
function linksOf(value: unknown[]): { title: string; url: string }[] {
  return value.flatMap((one) => {
    const link = one as { title?: unknown; url?: unknown }
    return typeof link?.url === 'string' && link.url !== ''
      ? [{ title: typeof link.title === 'string' ? link.title : link.url, url: link.url }]
      : []
  })
}

/** What becomes of what waited on removed work, as a model sent it, or why that is not one. */
function dependentsOf(value: unknown): 'hold' | 'inherit' {
  if (value === 'hold' || value === 'inherit') return value
  throw new Error(
    `dependents is hold, which leaves what waited on it held, or inherit, which has it wait on what the removed work waited on — not ${JSON.stringify(value)}`,
  )
}

/**
 * Waits as a model sent them. A plain name, or `agent` where the tool says
 * `task`, is the plan's spelling of the same thing, so it is read rather than
 * refused; one naming nothing reaches the rule as nothing, and is refused there.
 */
function waitsOf(value: unknown[]): { task: string; why: string; approved?: boolean }[] {
  return value.map((one) => {
    if (typeof one === 'string') return { task: one, why: '' }
    const dep = (one ?? {}) as {
      task?: unknown
      agent?: unknown
      why?: unknown
      approved?: unknown
    }
    const task = typeof dep.task === 'string' ? dep.task : dep.agent
    return {
      task: typeof task === 'string' ? task : '',
      why: typeof dep.why === 'string' ? dep.why : '',
      ...(dep.approved === true ? { approved: true } : {}),
    }
  })
}

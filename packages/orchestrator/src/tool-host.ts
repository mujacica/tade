import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { DONE_RULES, type DoneRule, type LaneId, type Plan, When } from '@tade/core'
import type { PermissionDecision, RunId, WorkerImage } from '@tade/harnesses-core'
import { clipped, type Workbench } from '@tade/workbench'

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
  handOff?: (cwd: string) => Promise<{ note: string; images: readonly WorkerImage[] }>
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
      done?: DoneRule
      missed?: 'once' | 'skip'
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
  /** Runs the orchestrator's extension tools. Without it, it has none. */
  extensions?: (call: {
    tool: string
    input: Record<string, unknown>
    callId: string
  }) => Promise<string>
}

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>

/** Which terminal a call names, as said: an id, a name, a number, or nothing when there is one. */
const said = (p: Record<string, unknown>): string => (p.terminal ? String(p.terminal) : '')
const project = (p: Record<string, unknown>): string | undefined =>
  p.project ? String(p.project) : undefined

export class ToolHost {
  readonly path: string
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private readonly methods: Record<string, Handler>

  private constructor(path: string, server: Server, methods: Record<string, Handler>) {
    this.path = path
    this.server = server
    this.methods = methods
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
          by: 'orchestrator',
        }),
      'task/done': async (p) => {
        await tade.markDone(String(p.task), {
          by: 'orchestrator',
          ...(p.summary ? { summary: String(p.summary) } : {}),
        })
        return `${String(p.task)} is finished`
      },
      'queue/plan': async (p) => queueOf(opts).plan(planOf(p)),
      'queue/list': async () => queueOf(opts).describe(),
      'queue/change': async (p) =>
        queueOf(opts).change({
          ...(p.task ? { task: String(p.task) } : {}),
          ...(p.schedule ? { schedule: String(p.schedule) } : {}),
          ...(p.project ? { project: String(p.project) } : {}),
          ...(p.name ? { name: String(p.name) } : {}),
          ...(Array.isArray(p.order) ? { order: p.order.map(String) } : {}),
          change: String(p.change ?? ''),
        }),
      'queue/schedule': async (p) => {
        // A watch looks as often as it says it should unless told otherwise: an
        // empty rule is no rule, not one that can never be kept.
        const unsaid =
          p.when === undefined ||
          p.when === null ||
          (typeof p.when === 'object' && Object.keys(p.when).length === 0)
        const when = unsaid ? null : When.safeParse(p.when)
        if (when && !when.success) {
          throw new Error(
            `when is not a rule: ${when.error.issues.map((issue) => issue.message).join('; ')}`,
          )
        }
        const text = (value: unknown) => (typeof value === 'string' ? value : '')
        const missed = p.missed === 'skip' ? 'skip' : p.missed === 'once' ? 'once' : undefined
        const found = p.found === 'ask' ? 'ask' : p.found === 'agent' ? 'agent' : undefined
        if (p.input !== undefined && (typeof p.input !== 'object' || p.input === null)) {
          throw new Error('input is what the watch is turned on with: an object')
        }
        return queueOf(opts).schedule({
          name: text(p.name),
          project: text(p.project),
          said: text(p.said),
          ...(when?.success ? { when: when.data } : {}),
          ...(p.agent !== undefined ? { agent: text(p.agent) } : {}),
          ...(p.ask !== undefined ? { ask: text(p.ask) } : {}),
          ...(p.watch !== undefined ? { watch: text(p.watch) } : {}),
          ...(p.input !== undefined ? { input: p.input as Record<string, unknown> } : {}),
          ...(found ? { found } : {}),
          ...(typeof p.most === 'number' ? { most: p.most } : {}),
          ...(p.done ? { done: doneRuleOf(p.done) } : {}),
          ...(missed ? { missed } : {}),
        })
      },
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
      'status/read': async () => {
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
      'task/park': (p) =>
        tade.parkTask(String(p.worktree), p.parked === true, p.task ? String(p.task) : undefined),
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
        const handed = prompt.trim() && opts.handOff ? await opts.handOff(cwd) : null
        return tade.startAgent({
          task: String(p.task) as never,
          cwd,
          prompt: handed?.note ? `${prompt}\n\n${handed.note}` : prompt,
          ...(model ? { model } : {}),
          ...(handed?.images.length ? { images: handed.images } : {}),
        })
      },
      'worker/list': () => tade.runs(),
      'worker/pending': (p) => tade.pendingApprovals(p.task ? String(p.task) : undefined),
      'worker/steer': async (p) => {
        await tade.steerAgent(String(p.task), String(p.message))
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
      'memory/remember': (p) =>
        tade.remember(
          String(p.text),
          p.scope === null || p.scope === undefined ? null : String(p.scope),
          p.by ? String(p.by) : 'tade',
          p.summary ? String(p.summary) : null,
        ),
      'events/read': (p) => tade.events(p as never),
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
    const host = new ToolHost(opts.path, server, methods)
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

  private async dispatch(socket: Socket, body: string): Promise<void> {
    let id: unknown = null
    try {
      const message = JSON.parse(body) as {
        id?: unknown
        method?: string
        params?: Record<string, unknown>
      }
      id = message.id ?? null
      const handler = this.methods[message.method ?? '']
      if (!handler) throw new Error(`no such method: ${message.method}`)
      reply(socket, { jsonrpc: '2.0', id, result: (await handler(message.params ?? {})) ?? null })
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

/** Links as a model sent them: only the ones with somewhere to go. */
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
    agents: p.agents.map((raw) => {
      const agent = (raw ?? {}) as Record<string, unknown>
      return {
        name: text(agent.name),
        ...(agent.project ? { project: text(agent.project) } : {}),
        said: text(agent.said),
        prompt: text(agent.prompt),
        ...(agent.done ? { done: doneRuleOf(agent.done) } : {}),
        after: (Array.isArray(agent.after) ? agent.after : []).map((dep) => {
          const one = (dep ?? {}) as Record<string, unknown>
          return { agent: text(one.agent), why: text(one.why) }
        }),
        touches: (Array.isArray(agent.touches) ? agent.touches : []).map(text).filter(Boolean),
        ...(agent.at ? { at: text(agent.at) } : {}),
        ...(agent.model ? { model: text(agent.model) } : {}),
        ...(agent.thinking ? { thinking: text(agent.thinking) } : {}),
      }
    }),
  }
}

/** A rule for finishing, as asked: one there is, or the reason it is not. */
function doneRuleOf(value: unknown): DoneRule {
  const rule = DONE_RULES.find((one) => one === String(value).trim().toLowerCase())
  if (!rule) throw new Error(`${String(value)} is not a way to finish: ${DONE_RULES.join(', ')}`)
  return rule
}

function linksOf(value: unknown[]): { title: string; url: string }[] {
  return value.flatMap((one) => {
    const link = one as { title?: unknown; url?: unknown }
    return typeof link?.url === 'string' && link.url !== ''
      ? [{ title: typeof link.title === 'string' ? link.title : link.url, url: link.url }]
      : []
  })
}

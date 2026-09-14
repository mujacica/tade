import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'

/** Where proposals are written. Set by the orchestrator that launched us. */
function extensionsRoot(): string {
  const configured = process.env.WILCO_EXTENSIONS
  if (configured) return configured
  return join(process.env.WILCO_HOME ?? process.cwd(), 'extensions')
}

/** The extension tools Wilco listed for this orchestrator, or none. */
function extensionTools(): Array<{
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
}> {
  const path = process.env.WILCO_EXTENSION_TOOLS
  if (!path) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((one) => typeof one?.name === 'string' && typeof one?.parameters === 'object')
      : []
  } catch {
    return []
  }
}

/** Where lessons are written. Set by the orchestrator that launched us. */
function skillsRoot(): string {
  return process.env.WILCO_SKILLS ?? join(process.env.WILCO_HOME ?? process.cwd(), 'skills')
}

// Wilco's tools, as seen by the orchestrator.
//
// pi loads this file directly, so like the supervision extension it is
// SELF-CONTAINED: no imports from the Wilco workspace, and the host's
// JSON-RPC framing is implemented here rather than pulled in.
//
// Tools that change something call back to Wilco. "Where are we" shells out to
// `wilco status`, so there is exactly one implementation of how status is
// derived, and the orchestrator sees precisely what a human would.

interface ToolContext {
  cwd: string
  /** pi's model catalog, for switching this session to a model Wilco found. */
  modelRegistry?: { find?(provider: string, id: string): unknown }
}
/**
 * What a tool hands back: pi reads `content` and nothing else, and counts a
 * call as failed only when it throws. Returning an `output` field instead —
 * as these tools once did — gave the model an empty answer from every one.
 */
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: unknown
}
interface ToolDefinition {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult>
}
interface PiApi {
  registerTool(tool: ToolDefinition): void
  /** Switches this session only; the default for new sessions is left alone. */
  setModel?(model: unknown): Promise<boolean>
}

const SOCKET = process.env.WILCO_SOCKET ?? ''
const CLI = process.env.WILCO_CLI ?? 'wilco'
/** Arguments before the command, so a source checkout can run `node path/to/bin.ts`. */
const CLI_ARGS = (process.env.WILCO_CLI_ARGS ?? '').split(' ').filter((a) => a.length > 0)

/** JSON Schema, which is also what pi's schema type is at runtime. */
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const string = (description: string) => ({ type: 'string', description })

export default function wilcoTools(pi: PiApi): void {
  const tool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    run: (params: Record<string, unknown>, callId: string, ctx: ToolContext) => Promise<unknown>,
    label = name.replace(/^wilco_/, 'wilco: ').replace(/_/g, ' '),
  ): void => {
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      async execute(id, params, _signal, _update, ctx) {
        // A failure is thrown, so pi marks the call failed and the model is
        // told what went wrong in words it can choose another route from.
        const result = await run(params ?? {}, id, ctx)
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        return { content: [{ type: 'text', text }], details: {} }
      },
    })
  }

  tool(
    'wilco_status',
    'Where everything stands: every task, its state, and why. Derived fresh from git, running agents and provider transcripts. Use this for any question about what is happening.',
    object({}),
    async () => runCli(['status', '--json']),
  )

  tool(
    'wilco_propose_extension',
    'Write a new tool for yourself. It is saved as a proposal and does nothing until a human reads it and runs `wilco extensions activate`. Never assume a proposed tool is available.',
    object(
      {
        name: string('short name, lowercase with dashes'),
        source: string('the extension source: a pi extension module'),
        why: string('what it is for, in one sentence'),
      },
      ['name', 'source', 'why'],
    ),
    async (p) => {
      const name = String(p.name)
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
        throw new Error(`${name} is not a usable name: lowercase letters, digits and dashes`)
      }
      const dir = join(extensionsRoot(), 'proposed')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${name}.ts`)
      // The reason it was written goes in the file, because the review happens
      // days later and a tool with no stated purpose gets turned down.
      const header = `// ${String(p.why)}\n// Proposed by Wilco on ${new Date().toISOString()}.\n\n`
      await writeFile(path, header + String(p.source))
      return `Proposed ${name}. It is not running: a human activates it with \`wilco extensions activate ${name}\` after reading ${path}.`
    },
  )

  // What an agent should know before it starts, and where the work came from:
  // written into its worktree, so it finds them however it is started.
  const context = string(
    'what the agent should know before it starts, in markdown: what you found, where to look, what done looks like. Written to .wilco/context.md in its worktree.',
  )
  const links = {
    type: 'array',
    description: 'where the work came from: an issue, a trace, a discussion',
    items: object({ title: string('what it is'), url: string('where it is') }, ['title', 'url']),
  }

  tool(
    'wilco_task_create',
    "Create a task: a branch, a worktree, and the human's intent recorded verbatim. Pass the intent exactly as they said it, never paraphrased. Give it the context and links you gathered, so the agent that works on it starts knowing what you know.",
    object(
      {
        project: string('project name, as configured'),
        name: string('short task name, lowercase with dashes'),
        intent: string('what the human said, word for word'),
        context,
        links,
      },
      ['project', 'name', 'intent'],
    ),
    (p) =>
      rpc('task/create', {
        project: String(p.project),
        slug: String(p.name),
        intent: String(p.intent),
        ...(p.context ? { context: String(p.context) } : {}),
        ...(Array.isArray(p.links) ? { links: p.links } : {}),
      }),
  )

  // Wilco's extensions: listed when Wilco started this orchestrator, run by
  // Wilco, which is where their settings, secrets and window are.
  for (const spec of extensionTools()) {
    tool(
      spec.name,
      spec.description,
      spec.parameters,
      (p, callId) => rpc('extension/call', { tool: spec.name, input: p, callId }),
      spec.label,
    )
  }

  tool(
    'wilco_run_start',
    'Start an agent working on an existing task. The prompt is what the agent is told first; files the human attached to what you are answering go with it. When they named a model for the work ("use opus"), pass it here so the agent starts on it: Wilco finds it before anything starts, and when it cannot tell which model they meant nothing starts and it says what to ask them.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        prompt: string('what to tell the agent first'),
        model: string(
          'the model to start it on, as the human said it: "opus", "kimi k2.6". Only when they named one.',
        ),
      },
      ['task'],
    ),
    async (p) => {
      const task = String(p.task)
      const worktree = await worktreeOf(task)
      if (!worktree) throw new Error(`no such task: ${task}`)
      return rpc('worker/start', {
        task,
        cwd: worktree,
        prompt: String(p.prompt ?? ''),
        ...(p.model ? { model: String(p.model) } : {}),
      })
    },
  )

  tool(
    'wilco_agent_model',
    'Switch the model an agent is running on: "switch refunds to opus 5", "use kimi in agent-1". New agents start on it from then on, until another is chosen; agents already working keep their own. Say the model the way the human did; Wilco finds it among the models they are signed in to, and says which it means when more than one fits. The agent must be running: to start one on a model, give the model to wilco_run_start instead.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        model: string('the model as the human said it: "opus 5", "claude-sonnet-5", "kimi k2.6"'),
      },
      ['task', 'model'],
    ),
    async (p) => {
      const chosen = (await rpc('worker/model', {
        task: String(p.task),
        model: String(p.model),
      })) as {
        provider?: string
        id?: string
      }
      return `${String(p.task)} is switching to ${chosen.provider ? `${chosen.provider}/` : ''}${chosen.id ?? String(p.model)}.`
    },
  )

  tool(
    'wilco_agent_thinking',
    'Set how hard an agent thinks before it answers — off, minimal, low, medium, high, xhigh or max — from its next turn: "think harder on refunds", "less thinking for agent-1". New agents think that hard too, until another level is chosen. A model that cannot think that hard takes the most it can. The agent must be running.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        level: string('off, minimal, low, medium, high, xhigh or max'),
      },
      ['task', 'level'],
    ),
    async (p) => {
      const done = (await rpc('worker/thinking', {
        task: String(p.task),
        level: String(p.level),
      })) as { level: string }
      return `${String(p.task)} thinks at ${done.level} from its next turn, and new agents will too.`
    },
  )

  tool(
    'wilco_agent_harness',
    'Run an agent in another harness — the program that is the agent, such as pi — from its next start on; a running agent is started again in it. Only when the human asks. Wilco says which harnesses exist and which it can run yet.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        harness: string('the harness id: pi'),
      },
      ['task', 'harness'],
    ),
    async (p) => {
      const task = String(p.task)
      const worktree = await worktreeOf(task)
      if (!worktree) throw new Error(`no such task: ${task}`)
      const done = (await rpc('worker/harness', {
        task,
        worktree,
        harness: String(p.harness),
      })) as { harness: string; restarted: boolean }
      return `${task} runs in ${done.harness}${done.restarted ? ', started again there' : ' from its next start'}.`
    },
  )

  tool(
    'wilco_orchestrator_model',
    'Switch the model you — the orchestrator — think with: "use opus 5 yourself", "change your model to sonnet". Say the model the way the human did. It takes effect from your next reply and is kept for the next time Wilco starts. For an agent\'s model use wilco_agent_model; for "both", call each.',
    object({ model: string('the model as the human said it') }, ['model']),
    async (p, _id, ctx) => {
      const chosen = (await rpc('orchestrator/model', { model: String(p.model) })) as {
        provider: string
        id: string
      }
      const found = ctx.modelRegistry?.find?.(chosen.provider, chosen.id)
      if (!found || !pi.setModel) {
        throw new Error(
          `${chosen.provider}/${chosen.id} is saved for the next start, but this session could not switch to it now`,
        )
      }
      await pi.setModel(found)
      return `The orchestrator is on ${chosen.provider}/${chosen.id} from its next reply, and will start on it next time.`
    },
  )

  tool(
    'wilco_agent_rename',
    'Give an agent a name: what its work is called, shown in the window and in its own session. Only when the human asks to rename it. A name they give is never replaced by one Wilco would have chosen.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        name: string('the new name, as they said it'),
      },
      ['task', 'name'],
    ),
    async (p) => {
      const task = String(p.task)
      const worktree = await worktreeOf(task)
      if (!worktree) throw new Error(`no such task: ${task}`)
      const title = await rpc('task/rename', { task, worktree, title: String(p.name) })
      return `${task} is now called ${String(title)}.`
    },
  )

  tool(
    'wilco_run_list',
    'The agents working right now, and the task each is on. One agent per task at most.',
    object({}),
    () => rpc('worker/list', {}),
  )

  tool(
    'wilco_steer',
    'Tell the agent working on a task something, without stopping it.',
    object({ task: string('task id, like checkout/refunds'), message: string('what to tell it') }, [
      'task',
      'message',
    ]),
    (p) => rpc('worker/steer', { task: String(p.task), message: String(p.message) }),
  )

  tool(
    'wilco_run_stop',
    'Stop the agent working on a task. The task and its worktree stay; only the agent ends.',
    object({ task: string('task id, like checkout/refunds') }, ['task']),
    (p) => rpc('worker/stop', { task: String(p.task) }),
  )

  tool(
    'wilco_run_cleanup',
    'Stop agents that match a state filter: idle (not actively working), done (ready to merge, in review state), failed, or all (any non-working agent). Use when the human asks to clean up finished or failed agents.',
    object({ filter: string('which agents to stop: idle, done, failed, or all') }, ['filter']),
    async (p) => {
      const filter = String(p.filter).toLowerCase()
      const status = JSON.parse(await runCli(['status', '--json'])) as {
        projects: Array<{ tasks: Array<{ id: string; state: string }> }>
      }
      const toStop: string[] = []
      for (const project of status.projects) {
        for (const task of project.tasks) {
          const matches =
            filter === 'all'
              ? task.state !== 'working'
              : filter === 'idle'
                ? task.state !== 'working'
                : filter === 'done'
                  ? task.state === 'review'
                  : filter === 'failed'
                    ? task.state === 'failed'
                    : false
          if (matches) toStop.push(task.id)
        }
      }
      const stopped: string[] = []
      for (const task of toStop) {
        try {
          await rpc('worker/stop', { task })
          stopped.push(task)
        } catch {
          // skip ones that could not be stopped
        }
      }
      return stopped.length === 0
        ? `No agents matched filter "${filter}"`
        : `Stopped ${stopped.length} agent${stopped.length === 1 ? '' : 's'}: ${stopped.join(', ')}`
    },
  )

  for (const [name, parked, what] of [
    [
      'wilco_park',
      true,
      'Set a task aside. Nothing is lost: the worktree stays and it can be picked back up.',
    ],
    ['wilco_resume', false, 'Pick a parked task back up, so it counts as work again.'],
  ] as const) {
    tool(
      name,
      what,
      object({ task: string('task id, like checkout/refunds') }, ['task']),
      async (p) => {
        const task = String(p.task)
        const worktree = await worktreeOf(task)
        if (!worktree) throw new Error(`no such task: ${task}`)
        return rpc('task/park', { worktree, parked, task })
      },
    )
  }

  tool(
    'wilco_remember',
    'Write down something the human told you, in their words. Scope it to a task or project when it is about one; leave it off when it is about everything.',
    object(
      {
        text: string('exactly what they said, never a tidier version of it'),
        about: string('task or project it is about, if any'),
      },
      ['text'],
    ),
    (p) =>
      rpc('memory/remember', {
        text: String(p.text),
        scope: p.about ? String(p.about) : null,
        by: 'orchestrator',
      }),
  )

  tool(
    'wilco_propose_skill',
    'Write down a lesson about working here — something you noticed that would have helped you earlier. It is saved as a proposal and does nothing until a human reads it and activates it. Propose one only when you have actually learned something, not to be helpful.',
    object(
      {
        name: string('short name, lowercase with dashes'),
        text: string('the lesson, in markdown, in your own words'),
        about: string(
          'the project or task it is about, like checkout or checkout/refunds. Leave it off only when the lesson is about working here in general: a lesson scoped to something stops being mentioned once that thing goes quiet, and an unscoped one is repeated forever.',
        ),
      },
      ['name', 'text'],
    ),
    async (p) => {
      const name = String(p.name)
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
        throw new Error(`${name} is not a usable name: lowercase letters, digits and dashes`)
      }
      const about = p.about ? String(p.about).trim().toLowerCase() : ''
      const dir = join(skillsRoot(), 'proposed')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${name}.md`)
      // The subject goes on its own line at the top, which is where it is read
      // back from: a lesson is written by a model and reviewed by a human, so
      // the file has to stay something a person can read.
      const header = about ? `about: ${about}\n\n` : ''
      await writeFile(path, `${header}${String(p.text).trim()}\n`)
      return `Proposed ${name}. It is not in use: a human activates it with \`wilco skills activate ${name}\` after reading ${path}.`
    },
  )

  // Terminals: shells along the bottom of the window that belong to a project.
  // The human sees everything typed into one, as it is typed.
  const terminal = string(
    'which terminal: its name ("tests"), its number, or its id; leave it out when there is only one',
  )
  const inProject = string('project name, as configured, when it is not obvious')

  tool(
    'wilco_terminal_list',
    'The terminals open along the bottom of the window, with their names, projects and folders.',
    object({ project: inProject }),
    (p) => rpc('terminal/list', p.project ? { project: String(p.project) } : {}),
  )

  tool(
    'wilco_terminal_open',
    "Open a terminal: a shell in the project's folder, or in the folder given (an agent's worktree, say). It appears along the bottom of the window.",
    object(
      {
        project: string('project name, as configured'),
        name: string('what to call it, like "tests" or "server"'),
        cwd: string('folder to start in, when not the project itself'),
      },
      ['project'],
    ),
    (p) => rpc('terminal/open', p),
  )

  tool(
    'wilco_terminal_run',
    'Run a command in a terminal, exactly as if the human typed it and pressed enter. They see it happen. Read the terminal afterwards to see what it printed.',
    object(
      {
        terminal,
        command: string('the command line, exactly'),
        submit: { type: 'boolean', description: 'false to type it without running it' },
        project: inProject,
      },
      ['command'],
    ),
    (p) => rpc('terminal/run', p),
  )

  tool(
    'wilco_terminal_read',
    'What a terminal shows, with some of its scrollback: how to see what a command printed.',
    object({
      terminal,
      lines: { type: 'number', description: 'how many lines back, 200 unless said' },
      project: inProject,
    }),
    (p) => rpc('terminal/read', p),
  )

  tool(
    'wilco_terminal_search',
    "Find lines in a terminal's scrollback containing some text, any case.",
    object({ terminal, text: string('what to look for'), project: inProject }, ['text']),
    (p) => rpc('terminal/search', p),
  )

  tool(
    'wilco_terminal_rename',
    'Rename a terminal, so it can be found by what it is for: "tests", "server".',
    object({ terminal, name: string('its new name'), project: inProject }, ['name']),
    (p) => rpc('terminal/rename', p),
  )

  tool(
    'wilco_terminal_close',
    'Close a terminal, ending whatever is running in it. Only when the human asked for that.',
    object({ terminal, project: inProject }),
    (p) => rpc('terminal/close', p),
  )

  tool(
    'wilco_logs',
    'What has happened recently, from the journal: tool calls, approvals, failures and turns. Use it to answer questions about the past rather than guessing.',
    object({
      task: string('only this task'),
      limit: { type: 'number', description: 'how many events, newest last' },
    }),
    (p) =>
      rpc('events/read', {
        ...(p.task ? { task: String(p.task) } : {}),
        limit: Number(p.limit) > 0 ? Number(p.limit) : 50,
      }),
  )

  tool(
    'wilco_approvals',
    'Commands agents are waiting for permission to run.',
    object({ task: string('only this task') }),
    (p) => rpc('worker/pending', p.task ? { task: String(p.task) } : {}),
  )

  tool(
    'wilco_approve',
    'Let a waiting command run. Only after the human has agreed to that exact command.',
    object({ run: string('run id'), request: string('request id') }, ['run', 'request']),
    (p) =>
      rpc('worker/decide', {
        run: String(p.run),
        requestId: String(p.request),
        decision: { allow: true },
      }),
  )

  tool(
    'wilco_deny',
    'Refuse a waiting command, telling the agent why.',
    object({ run: string('run id'), request: string('request id'), reason: string('why not') }, [
      'run',
      'request',
    ]),
    (p) =>
      rpc('worker/decide', {
        run: String(p.run),
        requestId: String(p.request),
        decision: { allow: false, reason: String(p.reason ?? 'denied') },
      }),
  )
}

async function worktreeOf(task: string): Promise<string | null> {
  const status = JSON.parse(await runCli(['status', '--json'])) as {
    projects: Array<{ tasks: Array<{ id: string; worktree: string }> }>
  }
  for (const project of status.projects) {
    const found = project.tasks.find((t) => t.id === task)
    if (found) return found.worktree
  }
  return null
}

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const argv = [...CLI_ARGS, ...args, '--no-pr']
    execFile(CLI, argv, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout)
    })
  })
}

/** Minimal JSON-RPC 2.0 client: one connection per call, Content-Length framed. */
function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!SOCKET) return Promise.reject(new Error('WILCO_SOCKET is not set: no way back to Wilco'))
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET)
    let buffer = Buffer.alloc(0)
    const fail = (err: Error) => {
      socket.destroy()
      reject(err)
    }
    socket.on('error', fail)
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), 'utf8')
      socket.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
      socket.write(body)
    })
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const split = buffer.indexOf('\r\n\r\n')
      if (split < 0) return
      const header = buffer.subarray(0, split).toString('utf8')
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0)
      const start = split + 4
      if (buffer.byteLength < start + length) return
      const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8')) as {
        result?: unknown
        error?: { message?: string }
      }
      socket.end()
      if (message.error) reject(new Error(message.error.message ?? 'Wilco rejected the request'))
      else resolve(message.result ?? { ok: true })
    })
  })
}

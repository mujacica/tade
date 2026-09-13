import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'

/** Where proposals are written. Set by the orchestrator that launched us. */
function extensionsRoot(): string {
  const configured = process.env.WILCO_EXTENSIONS
  if (configured) return configured
  return join(process.env.WILCO_HOME ?? process.cwd(), 'extensions')
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
}
interface ToolResult {
  output: string
  details?: unknown
  isError?: boolean
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
    run: (params: Record<string, unknown>) => Promise<unknown>,
  ): void => {
    pi.registerTool({
      name,
      label: name.replace(/^wilco_/, 'wilco: ').replace(/_/g, ' '),
      description,
      parameters,
      async execute(_id, params) {
        try {
          const result = await run(params ?? {})
          return { output: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }
        } catch (err) {
          // The model is told what went wrong so it can choose another route.
          return { output: err instanceof Error ? err.message : String(err), isError: true }
        }
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

  tool(
    'wilco_task_create',
    "Create a task: a branch, a worktree, and the human's intent recorded verbatim. Pass the intent exactly as they said it, never paraphrased.",
    object(
      {
        project: string('project name, as configured'),
        name: string('short task name, lowercase with dashes'),
        intent: string('what the human said, word for word'),
      },
      ['project', 'name', 'intent'],
    ),
    (p) =>
      rpc('task/create', {
        project: String(p.project),
        slug: String(p.name),
        intent: String(p.intent),
      }),
  )

  tool(
    'wilco_run_start',
    'Start an agent working on an existing task. The prompt is what the agent is told first.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        prompt: string('what to tell the agent first'),
      },
      ['task'],
    ),
    async (p) => {
      const task = String(p.task)
      const worktree = await worktreeOf(task)
      if (!worktree) throw new Error(`no such task: ${task}`)
      return rpc('worker/start', { task, cwd: worktree, prompt: String(p.prompt ?? '') })
    },
  )

  tool(
    'wilco_run_list',
    'The agents running right now, with the task each is working on and its run id. Steering or stopping one needs the run id from here.',
    object({}),
    () => rpc('worker/list', {}),
  )

  tool(
    'wilco_steer',
    'Tell a running agent something without stopping it.',
    object({ run: string('run id'), message: string('what to tell it') }, ['run', 'message']),
    (p) => rpc('worker/steer', { run: String(p.run), message: String(p.message) }),
  )

  tool(
    'wilco_run_stop',
    'Stop a running agent. The task and its worktree stay; only the agent ends.',
    object({ run: string('run id') }, ['run']),
    (p) => rpc('worker/stop', { run: String(p.run) }),
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
        return rpc('task/park', { worktree, parked })
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
      },
      ['name', 'text'],
    ),
    async (p) => {
      const name = String(p.name)
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
        throw new Error(`${name} is not a usable name: lowercase letters, digits and dashes`)
      }
      const dir = join(skillsRoot(), 'proposed')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${name}.md`)
      await writeFile(path, `${String(p.text).trim()}\n`)
      return `Proposed ${name}. It is not in use: a human activates it with \`wilco skills activate ${name}\` after reading ${path}.`
    },
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

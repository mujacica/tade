import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import {
  DONE_CALL_MS,
  LEFTOVER_ITEMS,
  LEFTOVERS_TOOL,
  TOOL_CALL_MS,
} from '@tade/harnesses-core/agent-tools'
import { reach, SOCKET } from './ask.ts'
import { stillWaiting } from './still.ts'

// Tade's tools, lent to a Grok agent as an MCP server over stdio.
//
// Grok starts this for the life of the session from the account folder's own
// `config.toml` (`[mcp_servers.tade]`, written by `home.ts`), which is the only
// place Grok takes a server from: it has no flag that hands one over for one
// run, and its per-run overlay (`GROK_CONFIG`) refuses `mcp_servers` by design.
// The server inherits the agent's environment, so `TADE_RUN_SOCKET` and the
// rest reach it from the lane without being written into the config. Grok
// names its tools `tade__<name>` and the model reaches them through its
// `search_tool` / `use_tool`.
//
// Each call is passed to Tade, which runs the tool in the window's own process
// — where the extension's settings and credentials are — and the answer comes
// back as the tool's result. `tade_done` is always here: it is how an agent
// says its task is finished, which is what starts the work that waits on it —
// and so are `tade_document_ready` and `tade_leftovers`, answered by Tade like
// an extension's tool.
//
// One account folder serves every run, so one entry has to serve the run that
// is not a lane too: a headless turn of the orchestrator's is handed its tools
// as a server of their own (`WorkerExtras.mcp`), and names that file in
// `TADE_GROK_MCP`. Then this becomes that server — the same program, its
// arguments and its environment — and is nothing of its own.

interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const DONE: ToolSpec = {
  name: 'tade_done',
  description:
    'Say that your task is finished: the work is done, and committed if you commit. Tade then starts whatever was waiting on it. Call it once, at the end, with leftovers for anything you found wrong and did not fix. If you need the person — a question, a decision, something you could not do — ask them instead, and do not call this.',
  parameters: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'One line saying what you did, for whoever looks at the task next.',
      },
      leftovers: LEFTOVER_ITEMS,
    },
    required: ['summary'],
    additionalProperties: false,
  },
}

/**
 * How an agent hands the person its document before it has finished: the one
 * moment a plan or an analysis most often goes back to somebody is a question.
 * Run in Tade like any of its tools, so a refusal comes back as one.
 */
const DOCUMENT_READY: ToolSpec = {
  name: 'tade_document_ready',
  description:
    'Hand the person the document your task produces, when it is written or updated and something needs their decision before the work goes on — which option, whether the plan is right, what to do next. Tade tells the orchestrator at once: it reads your document, sums up where things stand for the person and puts your question to them. Then stop and wait: their answer comes to you as a message. Pass wait: false only to say a draft is there to read while you carry on. When the work is finished and nothing needs deciding, call tade_done instead — that hands the document over too.',
  parameters: {
    type: 'object',
    properties: {
      ask: {
        type: 'string',
        description:
          'The one thing the person needs to decide, in a line: the question, with the options if there are some.',
      },
      wait: {
        type: 'boolean',
        description:
          'Whether you have stopped until they answer: leave it out when you need their decision, false only when you carry on regardless.',
      },
    },
    required: ['ask'],
    additionalProperties: false,
  },
}

/**
 * The extension tools Tade listed for this agent. A list that cannot be read
 * still leaves Tade's own tools, so the server goes on without them, and says
 * so on stderr, which is where Grok keeps what a server it started says.
 */
function listed(path: string | undefined): ToolSpec[] {
  if (!path) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) {
      process.stderr.write(`tade: ${path} is not a list of tools, so none of them is offered\n`)
      return []
    }
    return parsed.filter(
      (one): one is ToolSpec =>
        typeof one?.name === 'string' &&
        typeof one?.description === 'string' &&
        typeof one?.parameters === 'object',
    )
  } catch (err) {
    process.stderr.write(
      `tade: could not read the extension tools in ${path}, so none of them is offered: ${(err as Error).message}\n`,
    )
    return []
  }
}

/** What a headless run's server is started as. */
interface Server {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * The server a headless run was handed, out of the file `TADE_GROK_MCP` names:
 * the first in it. Throws, saying why, when there is none this can start.
 */
function handed(path: string): Server {
  let parsed: { mcpServers?: unknown }
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown }
  } catch (err) {
    throw new Error(`could not read ${path}: ${(err as Error).message}`)
  }
  const servers = parsed?.mcpServers
  const first =
    typeof servers === 'object' && servers !== null
      ? (Object.values(servers as Record<string, unknown>)[0] as
          | { command?: unknown; args?: unknown; env?: unknown }
          | undefined)
      : undefined
  if (typeof first?.command !== 'string') {
    throw new Error(`${path} names no MCP server this can start`)
  }
  const args = Array.isArray(first.args) ? first.args.map(String) : []
  const env =
    typeof first.env === 'object' && first.env !== null
      ? Object.fromEntries(
          Object.entries(first.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        )
      : {}
  return { command: first.command, args, env }
}

const elsewhere = process.env.TADE_GROK_MCP
if (elsewhere) {
  let server: Server
  try {
    server = handed(elsewhere)
  } catch (err) {
    process.stderr.write(`tade: ${(err as Error).message}\n`)
    process.exit(1)
  }
  const child = spawn(server.command, server.args, {
    stdio: 'inherit',
    env: { ...process.env, ...server.env, TADE_GROK_MCP: '' },
  })
  child.on('error', (err) => {
    process.stderr.write(`tade: could not start ${server.command}: ${err.message}\n`)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 1))
} else {
  serve()
}

const tools = [...listed(process.env.TADE_EXTENSION_TOOLS), DOCUMENT_READY, LEFTOVERS_TOOL, DONE]

/** A call Grok is waiting on: what Tade is running for it now, and its word every minute. */
interface Open {
  asking: string | null
  stop: () => void
}

/** The calls Grok is still waiting on, by its own request id. */
const open = new Map<unknown, Open>()

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const text = (id: unknown, said: string, isError = false): void =>
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: said }], isError } })

function serve(): void {
  createInterface({ input: process.stdin }).on('line', (line) => {
    let message: { id?: unknown; method?: unknown; params?: Record<string, unknown> }
    try {
      message = JSON.parse(line)
    } catch (err) {
      // JSON-RPC's own answer to a line that is not JSON: there is no id to answer on.
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${(err as Error).message}` },
      })
      return
    }
    const { id, method, params } = message
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'tade', version: '1' },
        },
      })
    } else if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
        },
      })
    } else if (method === 'tools/call') {
      void call(id, params ?? {})
    } else if (method === 'notifications/cancelled') {
      cancel(params?.requestId)
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, result: {} })
    }
  })
}

async function call(id: unknown, params: Record<string, unknown>): Promise<void> {
  const name = String(params.name ?? '')
  const input = (params.arguments ?? {}) as Record<string, unknown>
  if (!SOCKET) return text(id, `Tade is not supervising this agent, so ${name} cannot run`, true)
  const meta = params._meta as Record<string, unknown> | undefined
  const callId = String(meta?.toolCallId ?? meta?.['x.ai/toolCallId'] ?? `${Date.now()}-${name}`)
  // Said once a minute until Tade answers (`still.ts`).
  let waitingOn = `Tade is still running ${name}`
  const mine: Open = {
    asking: null,
    stop: stillWaiting(meta?.progressToken, () => waitingOn, send),
  }
  open.set(id, mine)
  try {
    await answer(name, input, callId, {
      waiting: (now) => {
        waitingOn = now
      },
      asking: (call) => {
        mine.asking = call
      },
      // A call Grok gave up on is answered by nobody: it reads no
      // answer to a request it cancelled.
      say: (said, isError) => {
        if (open.get(id) === mine) text(id, said, isError)
      },
    })
  } finally {
    mine.stop()
    if (open.get(id) === mine) open.delete(id)
  }
}

/**
 * Grok gave a call up: the person cut the turn short, or it waited as long as
 * it would. Tade is told, so what it started for the call stops rather than
 * running on for nobody — a related `checks_run` given up at 10:32 went on
 * until 10:46.
 */
function cancel(requestId: unknown): void {
  const mine = open.get(requestId)
  if (!mine) return
  open.delete(requestId)
  mine.stop()
  if (mine.asking) void reach({ kind: 'cancel', callId: mine.asking })
}

/** What a call says while it waits, what it is asking Tade, and its answer. */
interface Saying {
  waiting: (on: string) => void
  asking: (callId: string) => void
  say: (said: string, isError?: boolean) => void
}

async function answer(
  name: string,
  input: Record<string, unknown>,
  callId: string,
  { waiting, asking, say }: Saying,
): Promise<void> {
  if (name === DONE.name) {
    // What it left goes first, to the door `tade_leftovers` goes to: a report
    // that is refused is said while nothing is finished yet.
    let left = ''
    if (Array.isArray(input.leftovers) && input.leftovers.length > 0) {
      const items = { items: input.leftovers, finishing: true }
      waiting(
        `nothing is finished yet: Tade is still making what you left into parked work (${input.leftovers.length} ${input.leftovers.length === 1 ? 'item' : 'items'})`,
      )
      asking(`${callId}-leftovers`)
      const { reply, reached } = await tade(`${callId}-leftovers`, LEFTOVERS_TOOL.name, items)
      if (!reply) {
        const why = reached
          ? `Nothing is finished yet: ${unanswered(LEFTOVERS_TOOL.name)}`
          : 'Tade is not open, so it cannot be told yet: say so instead'
        return say(why, true)
      }
      if (reply.ok !== true) {
        const why = String(reply.text ?? '')
        return say(`Nothing is finished yet: what you left was not taken. ${why}`, true)
      }
      left = ` ${String(reply.text ?? '')}`
    }
    const summary = String(input.summary ?? '').trim()
    waiting('Tade has not yet said it heard this task is finished')
    const { reply, reached } = await reach({ kind: 'done', summary }, DONE_CALL_MS)
    if (reply) return say(`Tade has it: this task is finished.${left}`)
    const why = reached
      ? `Tade took ${name} and no answer came back, so it may have heard you or its window may have closed. Say so in your last message; calling ${name} again does no harm.${left}`
      : 'Tade is not open, so it cannot be told yet: say so instead'
    return say(why, true)
  }
  asking(callId)
  const { reply, reached } = await tade(callId, name, input)
  if (!reply) {
    const why = reached ? unanswered(name) : `Tade is not open, so ${name} cannot run right now`
    return say(why, true)
  }
  say(String(reply.text ?? ''), reply.ok !== true)
}

/** What a call that Tade took and never answered was: not a Tade that is closed. */
const unanswered = (tool: string): string =>
  `Tade took ${tool} and no answer came back: its window may have closed. What it started may still be going, so look before running it again.`

/**
 * A tool Tade runs, asked over the run's socket: its answer, or null where none
 * came, and whether the question got there at all.
 */
async function tade(
  callId: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<{ reply: { ok?: unknown; text?: unknown } | null; reached: boolean }> {
  const { reply, reached } = await reach({ kind: 'call', callId, tool, input }, TOOL_CALL_MS)
  return { reply: reply as { ok?: unknown; text?: unknown } | null, reached }
}

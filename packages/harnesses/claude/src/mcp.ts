import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { LEFTOVER_ITEMS, LEFTOVERS_TOOL } from '@tade/harnesses-core/agent-tools'
import { ask, SOCKET } from './ask.ts'

// Tade's tools, lent to a Claude Code agent as an MCP server over stdio.
//
// Claude Code starts this for the life of the session. Each call is passed to
// Tade, which runs the tool in the window's own process — where the
// extension's settings and credentials are — and the answer comes back as
// the tool's result. `tade_done` is always here: it is how an agent says its
// task is finished, which is what starts the work that waits on it — and so are
// `tade_document_ready` and `tade_leftovers`, answered by Tade like an
// extension's tool.

interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** How long a tool Tade runs may take: a dependency update, a Seer analysis. */
const CALL_MS = 10 * 60_000

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

function listed(path: string | undefined): ToolSpec[] {
  if (!path) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (one): one is ToolSpec =>
        typeof one?.name === 'string' &&
        typeof one?.description === 'string' &&
        typeof one?.parameters === 'object',
    )
  } catch {
    return []
  }
}

const tools = [...listed(process.env.TADE_EXTENSION_TOOLS), DOCUMENT_READY, LEFTOVERS_TOOL, DONE]

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const text = (id: unknown, said: string, isError = false): void =>
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: said }], isError } })

createInterface({ input: process.stdin }).on('line', (line) => {
  let message: { id?: unknown; method?: unknown; params?: Record<string, unknown> }
  try {
    message = JSON.parse(line)
  } catch {
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
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: {} })
  }
})

async function call(id: unknown, params: Record<string, unknown>): Promise<void> {
  const name = String(params.name ?? '')
  const input = (params.arguments ?? {}) as Record<string, unknown>
  if (!SOCKET) return text(id, `Tade is not supervising this agent, so ${name} cannot run`, true)
  const meta = params._meta as Record<string, unknown> | undefined
  const callId = String(meta?.['claudecode/toolUseId'] ?? `${Date.now()}-${name}`)
  if (name === DONE.name) {
    // What it left goes first, to the door `tade_leftovers` goes to: a report
    // that is refused is said while nothing is finished yet.
    let left = ''
    if (Array.isArray(input.leftovers) && input.leftovers.length > 0) {
      const items = { items: input.leftovers, finishing: true }
      const reply = await tade(`${callId}-leftovers`, LEFTOVERS_TOOL.name, items)
      if (!reply)
        return text(id, 'Tade is not open, so it cannot be told yet: say so instead', true)
      if (reply.ok !== true) {
        const why = String(reply.text ?? '')
        return text(id, `Nothing is finished yet: what you left was not taken. ${why}`, true)
      }
      left = ` ${String(reply.text ?? '')}`
    }
    const reply = await ask({ kind: 'done', summary: String(input.summary ?? '').trim() })
    return reply
      ? text(id, `Tade has it: this task is finished.${left}`)
      : text(id, 'Tade is not open, so it cannot be told yet: say so instead', true)
  }
  const reply = await tade(callId, name, input)
  if (!reply) return text(id, `Tade is not open, so ${name} cannot run right now`, true)
  text(id, String(reply.text ?? ''), reply.ok !== true)
}

/** A tool Tade runs, asked over the run's socket: its answer, or null where it could not be asked. */
async function tade(
  callId: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<{ ok?: unknown; text?: unknown } | null> {
  return (await ask({ kind: 'call', callId, tool, input }, CALL_MS)) as {
    ok?: unknown
    text?: unknown
  } | null
}

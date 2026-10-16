import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { WORKER_ENV } from '@tade/harnesses-core'
import { LEFTOVER_ITEMS, LEFTOVERS_TOOL } from '@tade/harnesses-core/agent-tools'
import { Link } from './link.ts'

// Tade's tools, lent to an ACP agent as an MCP server over stdio.
//
// ACP hands a session the MCP servers its client names (`session/new`'s
// `mcpServers`), and every agent takes one over stdio — so this is how an ACP
// agent reaches `tade_done`, `checks_run` and the rest: started by the agent
// for the life of its session, it passes each call to Tade over the run's own
// supervision socket, where the window runs the tool with the extension's
// settings and credentials, and hands back what it answered.

interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** How long a tool Tade runs may take: a dependency update, a check suite. */
const CALL_MS = 10 * 60_000
/** How long a call waits for the socket to Tade to come up. */
const CONNECT_MS = 3_000

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

const SOCKET = process.env[WORKER_ENV.socket]
const RUN = process.env[WORKER_ENV.run] ?? ''
const tools = [...listed(process.env[WORKER_ENV.tools]), DOCUMENT_READY, LEFTOVERS_TOOL, DONE]

/** Calls waiting on Tade's answer, by id. */
const waiting = new Map<string, (answer: { ok: boolean; text: string }) => void>()

const link = SOCKET
  ? new Link({
      path: SOCKET,
      onCommand: (command) => {
        if (command.type !== 'extension_result') return
        waiting.get(command.callId)?.({ ok: command.ok, text: command.text })
        waiting.delete(command.callId)
      },
      onConnect: () => {},
      onDisconnect: () => {
        for (const [, answer] of waiting)
          answer({ ok: false, text: 'Tade closed before it answered' })
        waiting.clear()
      },
    })
  : null

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

// The agent ending its session closes this server's input, and that is the end of it.
process.stdin.on('end', () => {
  link?.close()
  process.exit(0)
})

let calls = 0

async function call(id: unknown, params: Record<string, unknown>): Promise<void> {
  const name = String(params.name ?? '')
  const input = (params.arguments ?? {}) as Record<string, unknown>
  if (!link) return text(id, `Tade is not supervising this agent, so ${name} cannot run`, true)
  // Started with the session, so the first call can come before the socket is up.
  for (let waited = 0; !link.connected && waited < CONNECT_MS; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!link.connected) return text(id, `Tade is not open, so ${name} cannot run right now`, true)
  if (name === DONE.name) {
    // What it left goes first, to the door `tade_leftovers` goes to: a report
    // that is refused is said while nothing is finished yet.
    let left = ''
    if (Array.isArray(input.leftovers) && input.leftovers.length > 0) {
      const items = { items: input.leftovers, finishing: true }
      const answer = await tade(link, LEFTOVERS_TOOL.name, items)
      if (!answer.ok) {
        return text(
          id,
          `Nothing is finished yet: what you left was not taken. ${answer.text}`,
          true,
        )
      }
      left = ` ${answer.text}`
    }
    link.send({
      type: 'done',
      run: RUN,
      at: Date.now(),
      summary: String(input.summary ?? '').trim(),
    })
    return text(id, `Tade has it: this task is finished.${left}`)
  }
  const answer = await tade(link, name, input)
  text(id, answer.text, !answer.ok)
}

/** A tool Tade runs, asked over the run's socket, and its answer — a refusal, if it never came. */
function tade(
  link: Link,
  name: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; text: string }> {
  const callId = `${process.pid}-${++calls}-${name}`
  return new Promise((resolve) => {
    waiting.set(callId, resolve)
    const timer = setTimeout(() => {
      waiting.delete(callId)
      resolve({ ok: false, text: `${name} did not answer in time` })
    }, CALL_MS)
    timer.unref?.()
    link.send({ type: 'extension_call', run: RUN, at: Date.now(), callId, tool: name, input })
  })
}

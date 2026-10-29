import { enableCompileCache } from 'node:module'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import type { OrchestratorTool } from './tools-extension.ts'

// Tade's own tools, served to a harness that speaks MCP — the orchestrator
// running in Claude Code, today.
//
// The tools themselves are the same list pi is given (`orchestratorTools`),
// declared once: two lists would be two tool surfaces, and the golden file
// would only ever protect one of them. This file is the other half of what
// `tools-extension.ts` does for pi — a harness is handed Tade's tools in its
// own terms, and what those tools are is neither harness's business.
//
// Started by the harness, so like everything loaded into an agent it is
// SELF-CONTAINED: node built-ins and its own package's files, nothing from
// the Tade workspace.

// **`initialize` is answered before the tools are loaded.** Claude Code gives
// a server a deadline to answer it (`MCP_WAITS` in the Claude harness) and,
// missed once, gives up on it for the whole session: every Tade tool missing
// until the orchestrator starts again. The tools are 130 kB of TypeScript in a
// dozen files, stripped of their types on every start — a quarter of what this
// process took to answer on an idle machine, and on one at a load average of
// a hundred and more the whole of it took 41 to 54 seconds. So nothing here
// waits on them but the requests that need them, and they start loading the
// moment the handshake has been answered.
//
// Compiled once and kept (`enableCompileCache`, Node's own, in the system's
// temporary folder): a later start reads the compiled code rather than
// stripping and compiling it again, which is most of what loading them costs.
enableCompileCache()

let loading: Promise<OrchestratorTool[] | Error> | null = null
/**
 * The tools, loaded once, the first time anything needs them — or why they
 * could not be, which every request that needed them says.
 */
const loaded = (): Promise<OrchestratorTool[] | Error> => {
  // The model is switched by starting the orchestrator again on the same
  // conversation, which Tade does when it is told — so nothing to do here.
  loading ??= import('./tools-extension.ts').then(
    (module) => module.orchestratorTools(),
    (err: unknown) => {
      const doing = "Tade's own tools could not be loaded"
      void report(err, doing)
      return new Error(`${doing}: ${err instanceof Error ? err.message : String(err)}`)
    },
  )
  return loading
}

/**
 * This process's own trouble, told to the window that started the
 * orchestrator, which writes it down as a `warning` — the journal, and so
 * Tade's reporter — and to stderr, which Claude Code keeps in its MCP log.
 *
 * Its own small client rather than `tools-extension.ts`'s, because what broke
 * may be that file. One try, with a deadline, and never a throw: reporting a
 * failure must not be a second one.
 */
function report(err: unknown, doing = ''): Promise<void> {
  const said = err instanceof Error ? err.message : String(err)
  const message = (doing ? `${doing}: ${said}` : said).slice(0, 300)
  const where = err instanceof Error ? (err.stack?.split('\n')[1]?.trim() ?? '') : ''
  process.stderr.write(`tade tools: ${err instanceof Error ? (err.stack ?? message) : message}\n`)
  const path = process.env.TADE_SOCKET
  if (!path) return Promise.resolve()
  return new Promise((resolve) => {
    const socket = connect(path)
    const done = () => {
      clearTimeout(deadline)
      socket.destroy()
      resolve()
    }
    const deadline = setTimeout(done, 2_000)
    socket.on('error', done)
    socket.on('data', done)
    socket.on('connect', () => {
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'trouble/report',
          params: { message, where },
        }),
        'utf8',
      )
      socket.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
      socket.write(body)
    })
  })
}

// Node's two handovers, answered the way the window answers them
// (`watchProcess`): an exception nobody caught is reported and ends this
// process — Claude Code then reads the server as failed, which Tade says in
// the conversation — and a promise nobody awaited is reported and nothing else.
process.on('uncaughtException', (err) => {
  void report(err).finally(() => process.exit(1))
})
process.on('unhandledRejection', (reason) => {
  void report(reason)
})
// The harness gone: there is nobody left to answer, which is not trouble.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
  else void report(err)
})

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const answer = (id: unknown, text: string, isError = false): void =>
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } })

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
    // Answered, so now the rest: by the time it asks for the list, the list
    // is most of the way there.
    void loaded()
  } else if (method === 'tools/list') {
    void list(id)
  } else if (method === 'tools/call') {
    void call(id, params ?? {})
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: {} })
  }
})

/**
 * Every tool, or the reason there are none — said as an error on the request,
 * because an empty list is a server with no tools, which reads as success.
 */
async function list(id: unknown): Promise<void> {
  const tools = await loaded()
  if (tools instanceof Error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: tools.message } })
    return
  }
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
}

async function call(id: unknown, params: Record<string, unknown>): Promise<void> {
  const name = String(params.name ?? '')
  const tools = await loaded()
  if (tools instanceof Error) return answer(id, tools.message, true)
  const tool = tools.find((one) => one.name === name)
  if (!tool) return answer(id, `Tade has no tool called ${name}`, true)
  const input = (params.arguments ?? {}) as Record<string, unknown>
  const meta = params._meta as Record<string, unknown> | undefined
  const callId = String(meta?.['claudecode/toolUseId'] ?? `${Date.now()}-${name}`)
  try {
    const result = await tool.run(input, callId, { cwd: process.cwd() })
    answer(id, typeof result === 'string' ? result : JSON.stringify(result, null, 2))
  } catch (err) {
    // Said as the tool's failure, which is what the model reads and chooses
    // another route from: an error nobody sees is a conversation gone quiet.
    answer(id, (err as Error).message, true)
  }
}

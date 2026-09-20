import { createInterface } from 'node:readline'
import { orchestratorTools } from './tools-extension.ts'

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

// The model is switched by starting the orchestrator again on the same
// conversation, which Tade does when it is told — so nothing to do here.
const tools = orchestratorTools()

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

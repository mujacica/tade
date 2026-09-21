// A tool server, as a program on this machine: what the stdio transport's
// tests run against.
//
// Real, rather than a fake: a transport that starts processes is the one
// place where "it works" has to mean an actual program, an actual pipe and an
// actual exit. It answers the protocol badly on purpose in some of its modes,
// because a server that writes a banner before it speaks, or offers a tool
// nothing can register, is what a real one does on a Tuesday.
//
// Modes, as the first argument: `works` (the default), `noisy`, `hangs`,
// `dies`. Anything after them is handed back by the `told` tool, which is how
// the tests see what the program was actually started with.

const mode = process.argv[2] ?? 'works'
const rest = process.argv.slice(3)

if (mode === 'dies') {
  process.stderr.write('no database url, and nothing to do without one\n')
  process.exit(1)
}

interface Message {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

const say = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

const TOOLS: Record<string, unknown>[] = [
  {
    name: 'echo',
    description: 'Say something back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  {
    name: 'fails',
    description: 'A tool that calls itself a failure.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lingers',
    description: 'A tool that takes a while, and says how it is going.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'told',
    description: 'What this program was started with: where, with what, and knowing what.',
    inputSchema: { type: 'object', properties: {} },
  },
]

if (mode === 'noisy') {
  // Things a real server does that nothing may die over.
  TOOLS.push({ description: 'a tool with no name at all', inputSchema: { type: 'object' } })
  TOOLS.push({
    name: 'stringy',
    description: 'parameters that are not an object',
    inputSchema: 'nope',
  })
  process.stdout.write('listening on stdio\n')
  process.stdout.write('{not json at all\n')
}

let rest_ = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  rest_ += chunk
  let at = rest_.indexOf('\n')
  while (at !== -1) {
    const line = rest_.slice(0, at).trim()
    rest_ = rest_.slice(at + 1)
    if (line !== '') took(line)
    at = rest_.indexOf('\n')
  }
})

function took(line: string): void {
  let message: Message
  try {
    message = JSON.parse(line) as Message
  } catch {
    return
  }
  if (mode === 'hangs') return
  const id = message.id
  switch (message.method) {
    case 'initialize':
      say({
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: `a ${mode} server`, version: '1.2.3' },
        },
      })
      return
    case 'tools/list':
      say({ id, result: { tools: TOOLS } })
      return
    case 'tools/call':
      call(id, message.params ?? {})
      return
    case 'notifications/cancelled': {
      const asked = message.params?.requestId
      if (typeof asked === 'number') cancelled.add(asked)
      return
    }
    default:
      return
  }
}

const cancelled = new Set<number>()

function call(id: number | string | undefined, params: Record<string, unknown>): void {
  const name = String(params.name ?? '')
  const input = (params.arguments ?? {}) as Record<string, unknown>
  if (!TOOLS.some((tool) => tool.name === name)) {
    say({ id, error: { code: -32602, message: `there is no tool called ${name}` } })
    return
  }
  if (name === 'fails') {
    say({ id, result: { content: [{ type: 'text', text: 'it did not work' }], isError: true } })
    return
  }
  if (name === 'told') {
    say({
      id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              pid: process.pid,
              cwd: process.cwd(),
              args: rest,
              env: process.env,
            }),
          },
        ],
      },
    })
    return
  }
  if (name === 'lingers') {
    const token = (params._meta as { progressToken?: unknown } | undefined)?.progressToken
    if (typeof token === 'number') {
      say({
        method: 'notifications/progress',
        params: { progressToken: token, message: 'working' },
      })
    }
    const timer = setTimeout(() => {
      if (typeof id === 'number' && cancelled.has(id)) return
      say({ id, result: { content: [{ type: 'text', text: 'done, eventually' }] } })
    }, 2_000)
    timer.unref?.()
    return
  }
  say({ id, result: { content: [{ type: 'text', text: String(input.text ?? 'echo') }] } })
}

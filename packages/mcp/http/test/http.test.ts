import { McpError, type ServerDeclaration, type TransportContext } from '@tade/mcp-core'
import { testTransport } from '@tade/mcp-core/conformance'
import { describe, expect, it } from 'vitest'
import { eventsIn } from '../src/events.ts'
import { makeHttpTransport } from '../src/index.ts'

// A server that is already running, without one running: every answer here is
// written down, and `fetch` is the seam. Nothing in this file reaches the
// network — the conformance suite fails a test that does.

const TOOLS = [
  { name: 'search', description: 'Find something.', inputSchema: { type: 'object' } },
  {
    name: 'fails',
    description: 'A tool that calls itself a failure.',
    inputSchema: { type: 'object' },
  },
  { name: 'lingers', description: 'A tool that takes a while.', inputSchema: { type: 'object' } },
]

const NOISY = [
  ...TOOLS,
  { description: 'no name at all', inputSchema: { type: 'object' } },
  { name: 'stringy', description: 'parameters that are not an object', inputSchema: 'nope' },
]

interface Asked {
  id?: number
  method?: string
  params?: { name?: string; _meta?: { progressToken?: number } }
}

/** What a server answers one message with, or null for one that wants no answer. */
function answer(asked: Asked, tools: unknown[]): Record<string, unknown> | null {
  if (asked.method === 'initialize') {
    return {
      id: asked.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'a written-down server', version: '1' },
      },
    }
  }
  if (asked.method === 'tools/list') return { id: asked.id, result: { tools } }
  if (asked.method === 'tools/call') {
    const name = asked.params?.name ?? ''
    if (!tools.some((tool) => (tool as { name?: string }).name === name)) {
      return { id: asked.id, error: { code: -32602, message: `there is no tool called ${name}` } }
    }
    if (name === 'fails') {
      return {
        id: asked.id,
        result: { content: [{ type: 'text', text: 'it did not work' }], isError: true },
      }
    }
    return { id: asked.id, result: { content: [{ type: 'text', text: `ran ${name}` }] } }
  }
  return null
}

/** A `fetch` that answers from the table above, by the address it was asked at. */
function answering(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const where = url.hostname
    if (where === 'missing.invalid') throw new Error('getaddrinfo ENOTFOUND')
    if (where === 'refuses.invalid') {
      return new Response('that token is not one of ours', { status: 401 })
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    const asked = JSON.parse(String(init?.body ?? '{}')) as Asked
    // A server that restarted and no longer knows the session it handed out:
    // 404 to whoever is still holding one, which is a session to open again
    // rather than a server to stop asking.
    if (where === 'forgets.invalid' && asked.method === 'tools/call') {
      return new Response(JSON.stringify({ error: 'no such session' }), { status: 404 })
    }
    if (where === 'hangs.invalid') {
      // It took the request and says nothing, ever: the deadline is what ends it.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    const tools = where === 'noisy.invalid' ? NOISY : TOOLS
    if (asked.method === 'tools/call' && asked.params?.name === 'lingers') {
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(said(answer(asked, tools))), 2_000)
        timer.unref?.()
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        })
      })
    }
    const replied = answer(asked, tools)
    if (!replied) return new Response(null, { status: 202 })
    // Half the servers in the world answer a POST with a stream of one event,
    // so half the tests here do too.
    return where === 'streaming.invalid' ? streamed(replied) : said(replied)
  }) as typeof fetch
}

function said(message: Record<string, unknown> | null): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', ...message }), {
    headers: { 'content-type': 'application/json', 'mcp-session-id': 'a-session' },
  })
}

function streamed(message: Record<string, unknown>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', ...message })}\n\n`,
        ),
      )
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

/** The older shape: a stream that stays open, and a post-box it names. */
function overStream(): typeof fetch {
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
  const write = (session: string, message: Record<string, unknown>) => {
    streams
      .get(session)
      ?.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', ...message })}\n\n`),
      )
  }
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === 'quiet.invalid') {
      // It opens a stream and never says where to post: the deadline ends it.
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    if ((init?.method ?? 'GET') === 'GET') {
      const session = 'one'
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.set(session, controller)
          controller.enqueue(
            new TextEncoder().encode(`event: endpoint\ndata: /messages?session=${session}\n\n`),
          )
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    const session = url.searchParams.get('session') ?? 'one'
    const asked = JSON.parse(String(init?.body ?? '{}')) as Asked
    const replied = answer(asked, TOOLS)
    if (replied) setTimeout(() => write(session, replied), 0)
    return new Response(null, { status: 202 })
  }) as typeof fetch
}

function declare(host: string, over: Partial<ServerDeclaration> = {}): ServerDeclaration {
  return {
    name: host.replace('.invalid', ''),
    transport: 'http',
    enabled: true,
    about: '',
    command: null,
    args: [],
    url: `https://${host}/mcp`,
    env: {},
    header: {},
    auth: 'none',
    authName: null,
    variables: [],
    tools: [],
    scope: 'window',
    install: null,
    ...over,
  }
}

function context(reach: typeof fetch, over: Partial<TransportContext> = {}): TransportContext {
  return {
    home: '/nonexistent',
    credential: null,
    env: {},
    fetch: reach,
    now: () => 0,
    deadlineMs: 1_000,
    ...over,
  }
}

testTransport('http', () => makeHttpTransport(), {
  works: declare('works.invalid'),
  fails: 'fails',
  lingers: 'lingers',
  hangs: declare('hangs.invalid'),
  noisy: declare('noisy.invalid'),
  missing: declare('nowhere', { url: 'not an address at all' }),
  dies: { server: declare('forgets.invalid'), tool: 'search' },
  deadlineMs: 1_000,
  context: () => context(answering()),
})

testTransport('sse', () => makeHttpTransport({ legacy: true }), {
  works: declare('works.invalid'),
  fails: 'fails',
  lingers: 'lingers',
  hangs: declare('quiet.invalid'),
  deadlineMs: 1_000,
  context: () => context(overStream()),
})

describe('a server reached over HTTP', () => {
  const open = (server: ServerDeclaration, ctx = context(answering())) =>
    makeHttpTransport().open(server, ctx)

  it('takes an answer that came back as a stream exactly as one that came back as JSON', async () => {
    const session = await open(declare('streaming.invalid'))
    try {
      expect((await session.listTools()).map((tool) => tool.name)).toContain('search')
    } finally {
      await session.close()
    }
  })

  it('puts the credential in the header the declaration names, and in no other', async () => {
    const seen: Record<string, string>[] = []
    const watching: typeof fetch = async (input, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()))
      return answering()(input, init)
    }
    const session = await open(
      declare('works.invalid', { auth: 'header', authName: 'X-Api-Key' }),
      context(watching, { credential: 'a-key' }),
    )
    await session.close()
    expect(seen[0]?.['x-api-key']).toBe('a-key')
    expect(seen[0]?.authorization).toBeUndefined()
  })

  it('says a bearer token the way a bearer token is said', async () => {
    const seen: Record<string, string>[] = []
    const watching: typeof fetch = async (input, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()))
      return answering()(input, init)
    }
    const session = await open(
      declare('works.invalid', { auth: 'bearer' }),
      context(watching, { credential: 'a-key' }),
    )
    await session.close()
    expect(seen[0]?.authorization).toBe('Bearer a-key')
  })

  it('sends the one copy of the credential it was given, and puts it nowhere else', async () => {
    // Over HTTP the credential travels and nothing else does: not into the
    // address, not into a message, not into a file of its own.
    const seen: { url: string; headers: Record<string, string>; body: string }[] = []
    const watching: typeof fetch = async (input, init) => {
      seen.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body ?? ''),
      })
      return answering()(input, init)
    }
    const session = await open(
      declare('works.invalid', { auth: 'bearer' }),
      context(watching, { credential: 'a-very-secret-key' }),
    )
    await session.listTools()
    await session.callTool('search', {}, { signal: new AbortController().signal, progress() {} })
    await session.close()
    expect(seen.length).toBeGreaterThan(2)
    for (const one of seen) {
      expect(one.url).not.toContain('a-very-secret-key')
      expect(one.body).not.toContain('a-very-secret-key')
      const carrying = Object.entries(one.headers).filter(([, value]) =>
        value.includes('a-very-secret-key'),
      )
      expect(carrying.map(([name]) => name)).toEqual(['authorization'])
    }
  })

  it('says a credential it would not take as exactly that, not as a number', async () => {
    await expect(open(declare('refuses.invalid'))).rejects.toMatchObject({
      trouble: 'refused',
      message: expect.stringContaining('would not take that credential'),
    })
  })

  it('says a server that is not there as one that could not be reached', async () => {
    await expect(open(declare('missing.invalid'))).rejects.toBeInstanceOf(McpError)
  })

  it('answers whether it could reach one at all without reaching for it', async () => {
    const transport = makeHttpTransport()
    const never: typeof fetch = async () => {
      throw new Error('ready() dialled the server')
    }
    await expect(transport.ready(declare('works.invalid'), context(never))).resolves.toBeNull()
    expect(await transport.ready(declare('x', { url: 'wat' }), context(never))).toContain(
      'not an address',
    )
    expect(await transport.ready(declare('x', { url: null }), context(never))).toContain(
      'nothing says where',
    )
    expect(
      await transport.ready(declare('x', { auth: 'header', authName: null }), context(never)),
    ).toContain('nothing says which')
  })

  it('only says it can be told the list changed where there is a stream to be told on', () => {
    // A streamable server is asked when somebody asks it; the older shape has
    // a stream that stays open, and only that one can be told.
    expect(makeHttpTransport().capabilities.announces).toBe(false)
    expect(makeHttpTransport({ legacy: true }).capabilities.announces).toBe(true)
  })
})

describe('reading a stream of events', () => {
  it('holds an event that arrived in pieces until the rest of it does', () => {
    const first = eventsIn('event: message\ndata: {"a":')
    expect(first.said).toEqual([])
    const then = eventsIn(`${first.rest}1}\n\nevent: message\ndata: {"b":2}\n\n`)
    expect(then.said).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: 'message', data: '{"b":2}' },
    ])
    expect(then.rest).toBe('')
  })

  it('reads both line endings, because a server may write either', () => {
    expect(eventsIn('data: one\r\n\r\n').said).toEqual([{ event: 'message', data: 'one' }])
  })

  it('joins data written over several lines, and leaves out what it does not read', () => {
    const read = eventsIn(': a comment\ndata: one\ndata: two\nid: 7\nretry: 50\nwhat: ever\n\n')
    expect(read.said).toEqual([{ event: 'message', data: 'one\ntwo' }])
  })

  it('drops an event with nothing in it rather than answering with an empty one', () => {
    expect(eventsIn('event: ping\n\n').said).toEqual([])
  })
})

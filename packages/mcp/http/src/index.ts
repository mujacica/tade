import {
  type CallContext,
  McpError,
  type McpTransport,
  type OfferedTool,
  type ServerAbout,
  type ServerDeclaration,
  type ServerSession,
  type TransportContext,
  type TransportOptions,
} from '@tade/mcp-core'
import * as wire from '@tade/mcp-core/protocol'
import { eventsIn, type Said } from './events.ts'

// A server that is already running, reached over HTTP.
//
// Two shapes of the same conversation, because servers in the world are both:
//
//   **Streamable** — every request is a POST, and the answer comes back as
//   JSON or as a short stream of events. This is what a server written in the
//   last year does, and it is the default.
//
//   **A stream and a post-box** (`sse`) — a GET that stays open and says
//   where to post, and every answer arrives back on that stream. Older, still
//   deployed, and one flag away from the same code: the messages are
//   identical and only how they travel differs.
//
// What this transport never does: start anything, write anything, or keep a
// credential. The one copy it is given goes into the header `auth` names and
// nowhere else — not into a file of its own, not into a log, not into what it
// says came back. `ready()` answers from the declaration and the credential it
// was handed: it never dials, because it is asked on every look at the page.

/** How much of a body is read back when a server answers with something that is not a message. */
const SAID_CAP = 400

/** How many pages of a tool list are read before Tade stops asking. */
const PAGES = 20

export interface HttpTransportOptions extends TransportOptions {
  /**
   * The older shape: a stream that stays open, and a post-box it names. Off
   * by default — which is what the `http` transport is — and registered under
   * its own name, `sse`, rather than sniffed from anything.
   */
  legacy?: boolean
}

export function makeHttpTransport(options: HttpTransportOptions = {}): McpTransport {
  const cap = options.cap ?? 20_000
  const legacy = options.legacy === true
  return {
    id: legacy ? 'sse' : 'http',
    capabilities: {
      spawns: false,
      network: true,
      // Only where there is a stream that stays open to be told on. A
      // streamable server is asked when somebody asks it.
      announces: legacy,
      cancel: true,
    },
    async ready(server) {
      return readiness(server)
    },
    async open(server, ctx) {
      const said = readiness(server)
      if (said) throw new McpError('unavailable', said)
      return legacy ? overStream(server, ctx, cap) : overPosts(server, ctx, cap)
    },
  }
}

/** Whether Tade could reach it at all: the declaration, and nothing dialled. */
function readiness(server: ServerDeclaration): string | null {
  if (!server.url) return `${server.name} answers somewhere, and nothing says where`
  try {
    const url = new URL(server.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return `${server.name} is at ${server.url}, which is not something Tade can reach over HTTP`
    }
  } catch {
    return `${server.name} is at ${server.url}, which is not an address`
  }
  if ((server.auth === 'header' || server.auth === 'env') && !server.authName) {
    return `${server.name} takes its credential in a header, and nothing says which`
  }
  return null
}

/**
 * What every request carries: what the declaration names, and the credential
 * exactly where `auth` says to put it. The one copy, and nowhere else.
 */
function headersFor(server: ServerDeclaration, ctx: TransportContext): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': wire.PROTOCOL_VERSION,
    ...server.header,
  }
  if (ctx.credential) {
    if (server.auth === 'bearer') headers.authorization = `Bearer ${ctx.credential}`
    // `env` is a program's way of being given one and means nothing here, so
    // a server declared that way is read as naming a header: it is the only
    // thing `auth_name` could mean over HTTP.
    else if (server.auth === 'header' || server.auth === 'env') {
      if (server.authName) headers[server.authName.toLowerCase()] = ctx.credential
    }
  }
  return headers
}

interface Waiting {
  resolve: (result: Record<string, unknown>) => void
  reject: (err: unknown) => void
}

/** What both shapes have: who is waiting for what, and what to do with a message. */
function conversation(name: string) {
  const waiting = new Map<number, Waiting>()
  const progressing = new Map<number, (text: string) => void>()
  const changed = new Set<() => void>()
  /** Whoever wants to hear that the server went away without being asked. */
  const going = new Set<(err: McpError) => void>()
  /** Whether the ending was asked for, so nobody is told it was a drop. */
  let shut = false
  let over: McpError | null = null

  const ended = (err: McpError) => {
    const first = over === null
    over ??= err
    for (const one of [...waiting.values()]) one.reject(err)
    waiting.clear()
    progressing.clear()
    // Said once, with what it went on. A session ended by `close()` calls
    // `quiet()` first, so a shutdown Tade asked for is never reported as a
    // server that went away.
    if (first) for (const listener of [...going]) listener(over)
  }

  const took = (message: wire.Message): void => {
    if (typeof message.id === 'number' && (message.result || message.error)) {
      const one = waiting.get(message.id)
      waiting.delete(message.id)
      progressing.delete(message.id)
      if (!one) return
      if (message.error) {
        one.reject(new McpError('refused', message.error.message ?? 'it would not say why'))
        return
      }
      one.resolve(message.result ?? {})
      return
    }
    if (message.method === 'notifications/progress') {
      const id = wire.progressFor(message.params)
      const text = wire.progress(message.params)
      if (id !== null && text !== null) progressing.get(id)?.(text)
      return
    }
    if (message.method === 'notifications/tools/list_changed') {
      for (const listener of [...changed]) listener()
    }
    // Anything else a server asks of a client — to run a model, to ask a
    // person a question — is left unanswered, because none of it was offered.
  }

  return {
    waiting,
    progressing,
    changed,
    took,
    ended,
    onGone(listener: (err: McpError) => void) {
      // One that has already gone — a stream that ended before anybody
      // subscribed — is said now rather than never.
      if (over && !shut) listener(over)
      else going.add(listener)
      return () => going.delete(listener)
    },
    /** Nobody is to be told about the ending that is about to be asked for. */
    quiet: () => {
      shut = true
      going.clear()
    },
    gone: () => over,
    closedError: () => over ?? new McpError('gone', `${name} was closed`),
  }
}

/** What a server answered that was not a message, as much of it as is worth reading. */
async function bodySaid(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, SAID_CAP)
  } catch {
    return ''
  }
}

/**
 * A refusal, in the words of whatever refused.
 *
 * A credential it would not take is said as that rather than as a number,
 * because it is the one of these somebody can do something about.
 */
function refusal(name: string, response: Response, said: string): McpError {
  const turned = response.status === 401 || response.status === 403
  return new McpError(
    'refused',
    turned
      ? `${name} would not take that credential (${response.status})`
      : `${name} answered ${response.status}`,
    said,
  )
}

/**
 * The streamable shape: every message is a POST, and the answer is whatever
 * comes back on it.
 */
async function overPosts(
  server: ServerDeclaration,
  ctx: TransportContext,
  cap: number,
): Promise<ServerSession> {
  const name = server.name
  const talk = conversation(name)
  const url = server.url ?? ''
  let session: string | null = null
  let closed = false
  let next = 1

  const post = async (message: wire.Message, signal?: AbortSignal): Promise<Response> => {
    const headers = headersFor(server, ctx)
    if (session) headers['mcp-session-id'] = session
    try {
      return await ctx.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      throw new McpError(
        signal?.aborted ? 'refused' : 'gone',
        signal?.aborted
          ? `${name} was given up on`
          : `${name} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * A server that has gone is gone for this session, not for this one call: it
   * is ended here, so whoever is holding one is told once rather than finding
   * out again on every call they make — and so there is something to tell at
   * all over a shape nobody is listening on. Reopening is the caller's, and the
   * broker's one retry does exactly that.
   */
  const departed = (err: McpError): McpError => {
    if (err.trouble === 'gone') talk.ended(err)
    return err
  }

  /** Ask, and read the answer out of whichever shape it came back in. */
  const ask = async (
    message: wire.Asked,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const already = talk.gone()
    if (already) throw already
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      talk.waiting.set(message.id, { resolve, reject })
    })
    const response = await post(message, signal).catch((err: unknown) => {
      talk.waiting.delete(message.id)
      throw err instanceof McpError ? departed(err) : err
    })
    // A session the server has forgotten is a session to open again, which is
    // what `gone` means to whoever is holding one.
    if (response.status === 404 && session) {
      talk.waiting.delete(message.id)
      throw departed(new McpError('gone', `${name} does not know this session any more`))
    }
    if (!response.ok) {
      const said = await bodySaid(response)
      talk.waiting.delete(message.id)
      throw refusal(name, response, said)
    }
    const heard = response.headers.get('mcp-session-id')
    if (heard) session = heard
    void read(response)
      .catch(() => {
        // A body that could not be read is a request nobody will answer.
        const gone = departed(new McpError('gone', `${name} stopped mid-answer`))
        talk.waiting.get(message.id)?.reject(gone)
        talk.waiting.delete(message.id)
      })
      .finally(() => {
        // The answer came back on the request that asked, so once the body is
        // read there is nothing else coming: a call still waiting here is one
        // the server never answered, and it is told so rather than left to
        // sit until somebody's deadline.
        const one = talk.waiting.get(message.id)
        if (!one) return
        talk.waiting.delete(message.id)
        one.reject(new McpError('refused', `${name} said nothing about what it was asked`))
      })
    return answer
  }

  /** Whatever came back on one response: one message, or a short stream of them. */
  const read = async (response: Response): Promise<void> => {
    const kind = response.headers.get('content-type') ?? ''
    if (!kind.includes('text/event-stream')) {
      const text = await response.text()
      // A server may answer a batch; both shapes read the same way.
      for (const one of many(text)) talk.took(one)
      return
    }
    await stream(response, (said) => {
      const message = wire.parse(said.data)
      if (message) talk.took(message)
    })
  }

  const hello = await Promise.race([
    ask(wire.initialize(next++)),
    deadline(name, ctx.deadlineMs),
  ]).catch((err: unknown) => {
    throw err instanceof McpError ? err : new McpError('unavailable', `${name} would not answer`)
  })
  const about: ServerAbout = wire.about(hello)
  // Said and not waited on: a server that answers 202 and one that answers
  // nothing at all are the same thing to a client that asked nothing.
  await post(wire.initialized()).catch(() => {})

  return {
    about,
    async listTools(signal?: AbortSignal) {
      return pages((cursor) => ask(wire.listTools(next++, cursor), signal), talk.closedError)
    },
    async callTool(tool: string, input: Readonly<Record<string, unknown>>, call: CallContext) {
      if (closed) throw talk.closedError()
      const mine = next++
      talk.progressing.set(mine, (text) => call.progress(text))
      try {
        const result = await ask(wire.callTool(mine, tool, input), call.signal)
        const outcome = wire.outcome(result)
        return { text: outcome.text.slice(0, cap), failed: outcome.failed }
      } finally {
        talk.progressing.delete(mine)
      }
    },
    onGone: talk.onGone,
    onToolsChanged(listener: () => void) {
      talk.changed.add(listener)
      return () => talk.changed.delete(listener)
    },
    async close() {
      if (closed) return
      closed = true
      talk.quiet()
      talk.ended(new McpError('gone', `${name} was closed`))
      // Telling it we are done is a courtesy it may not offer; whether it
      // took it changes nothing here.
      if (session) {
        await ctx
          .fetch(url, {
            method: 'DELETE',
            headers: { ...headersFor(server, ctx), 'mcp-session-id': session },
          })
          .catch(() => {})
      }
    },
  }
}

/**
 * The older shape: a stream that stays open and names a post-box, and every
 * answer arrives back on the stream rather than on the request that asked.
 */
async function overStream(
  server: ServerDeclaration,
  ctx: TransportContext,
  cap: number,
): Promise<ServerSession> {
  const name = server.name
  const talk = conversation(name)
  const url = server.url ?? ''
  const stop = new AbortController()
  let closed = false
  let next = 1

  const opened = await ctx
    .fetch(url, {
      method: 'GET',
      headers: { ...headersFor(server, ctx), accept: 'text/event-stream' },
      signal: stop.signal,
    })
    .catch((err: unknown) => {
      throw new McpError(
        'gone',
        `${name} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  if (!opened.ok) throw refusal(name, opened, await bodySaid(opened))

  // Where messages are posted, as the server says on its own stream — which
  // is the first thing it says. Listened for before the stream is read, so a
  // server that says it at once is not a lost address.
  let listening: (where: string) => void = () => {}
  const named = new Promise<string>((resolve) => {
    listening = resolve
  })

  void stream(opened, (said: Said) => {
    if (said.event === 'endpoint') {
      listening(new URL(said.data, url).toString())
      return
    }
    const message = wire.parse(said.data)
    if (message) talk.took(message)
  })
    .catch(() => {})
    .finally(() => {
      talk.ended(new McpError('gone', `${name} stopped answering`))
    })

  const where = await Promise.race([named, deadline(name, ctx.deadlineMs)]).catch(
    (err: unknown) => {
      stop.abort()
      throw err
    },
  )

  const ask = async (
    message: wire.Asked,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const already = talk.gone()
    if (already) throw already
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      talk.waiting.set(message.id, { resolve, reject })
    })
    const response = await ctx
      .fetch(where, {
        method: 'POST',
        headers: headersFor(server, ctx),
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
        ...(signal ? { signal } : {}),
      })
      .catch((err: unknown) => {
        talk.waiting.delete(message.id)
        throw new McpError(
          signal?.aborted ? 'refused' : 'gone',
          signal?.aborted
            ? `${name} was given up on`
            : `${name} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    if (!response.ok) {
      const said = await bodySaid(response)
      talk.waiting.delete(message.id)
      throw refusal(name, response, said)
    }
    return answer
  }

  const tell = async (message: wire.Told): Promise<void> => {
    await ctx
      .fetch(where, {
        method: 'POST',
        headers: headersFor(server, ctx),
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      })
      .catch(() => {})
  }

  const hello = await Promise.race([ask(wire.initialize(next++)), deadline(name, ctx.deadlineMs)])
  const about: ServerAbout = wire.about(hello)
  await tell(wire.initialized())

  return {
    about,
    async listTools(signal?: AbortSignal) {
      return pages((cursor) => ask(wire.listTools(next++, cursor), signal), talk.closedError)
    },
    async callTool(tool: string, input: Readonly<Record<string, unknown>>, call: CallContext) {
      if (closed) throw talk.closedError()
      const mine = next++
      talk.progressing.set(mine, (text) => call.progress(text))
      const stopping = () => {
        void tell(wire.cancelled(mine, 'Tade gave up on it'))
        const one = talk.waiting.get(mine)
        talk.waiting.delete(mine)
        one?.reject(new McpError('refused', `${name} was given up on`))
      }
      call.signal.addEventListener('abort', stopping, { once: true })
      try {
        const result = await ask(wire.callTool(mine, tool, input), call.signal)
        const outcome = wire.outcome(result)
        return { text: outcome.text.slice(0, cap), failed: outcome.failed }
      } finally {
        call.signal.removeEventListener('abort', stopping)
        talk.progressing.delete(mine)
      }
    },
    onGone: talk.onGone,
    onToolsChanged(listener: () => void) {
      talk.changed.add(listener)
      return () => talk.changed.delete(listener)
    },
    async close() {
      if (closed) return
      closed = true
      talk.quiet()
      talk.ended(new McpError('gone', `${name} was closed`))
      stop.abort()
    },
  }
}

/** Every page of a tool list, with a ceiling: a server that never stops is not asked for ever. */
async function pages(
  ask: (cursor: string | null) => Promise<Record<string, unknown>>,
  closed: () => McpError,
): Promise<readonly OfferedTool[]> {
  const out: OfferedTool[] = []
  let cursor: string | null = null
  for (let page = 0; page < PAGES; page++) {
    const result = await ask(cursor).catch((err: unknown) => {
      throw err instanceof McpError ? err : closed()
    })
    out.push(...wire.tools(result))
    cursor = wire.more(result)
    if (!cursor) break
  }
  return out
}

/** One or many messages in a body, read the same way either way. */
function many(text: string): wire.Message[] {
  let read: unknown
  try {
    read = JSON.parse(text)
  } catch {
    return []
  }
  const each = Array.isArray(read) ? read : [read]
  return each
    .map((one) => wire.parse(JSON.stringify(one)))
    .filter((one): one is wire.Message => one !== null)
}

/** Whatever arrives on a stream, as whole events, until it ends. */
async function stream(response: Response, each: (said: Said) => void): Promise<void> {
  const body = response.body
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let rest = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    rest += decoder.decode(value, { stream: true })
    const read = eventsIn(rest)
    rest = read.rest
    for (const said of read.said) each(said)
  }
}

/** Nothing waits without one. */
function deadline(name: string, ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new McpError('timeout', `${name} did not answer in ${Math.round(ms / 1000)}s`)),
      ms,
    )
    timer.unref?.()
  })
}

export { eventsIn } from './events.ts'

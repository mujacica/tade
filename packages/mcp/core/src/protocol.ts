import type { JsonSchema, OfferedTool, ServerAbout, ToolOutcome } from './port.ts'

// What every transport that actually talks to a server has to say, and how to
// read what comes back. Pure: a message in, a shape out, and nothing that
// touches a process, a socket or a clock.
//
// It lives here rather than in one of the transports because `stdio` and
// `http` say exactly the same things — only how the bytes travel differs —
// and two hand-written copies of "what a tool list looks like" drift apart
// the first time a server answers something neither of them expected. The
// port itself stays clean of it (R2): nothing in `port.ts` knows there is
// such a thing as JSON-RPC, and `scripted` never imports this file.
//
// The rule underneath every reader here: **anything unfamiliar is left out,
// never thrown over.** A server is a third party, its answers are
// attacker-controlled text, and one tool Tade cannot make sense of may not
// cost a person the other nine.

/** The version of the protocol Tade asks for. A server that answers another is taken at its word. */
export const PROTOCOL_VERSION = '2025-06-18'

/** Who Tade says it is. One client, in the window, for every harness there is. */
export const CLIENT_INFO = { name: 'tade', version: '0' } as const

/**
 * What Tade declares it can do — which is deliberately nothing.
 *
 * No `sampling`: a server that can ask the client to run a model spends the
 * person's money outside `spendFrom`'s accounting. No `elicitation`: a server
 * that can ask the client a question is asking an agent's tool call at 3am.
 * No `roots`: a server does not get told where the person's code is. Refused
 * by not being offered, which is the only refusal that cannot be argued with.
 */
export const CLIENT_CAPABILITIES: Readonly<Record<string, unknown>> = {}

/** A message on the wire, as far as anything here cares. */
export interface Message {
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

/** A message that expects an answer: it has an id, and something is waiting on it. */
export interface Asked extends Message {
  id: number
  method: string
}

/** A message that expects none. Saying it is the whole of it. */
export interface Told extends Message {
  method: string
}

/** What Tade says to open a conversation. */
export function initialize(id: number): Asked {
  return {
    id,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    },
  }
}

/** Said once the server has answered, before anything is asked of it. */
export function initialized(): Told {
  return { method: 'notifications/initialized', params: {} }
}

/** Ask what it offers. A cursor asks for the rest of a list it said had more. */
export function listTools(id: number, cursor?: string | null): Asked {
  return { id, method: 'tools/list', params: cursor ? { cursor } : {} }
}

/**
 * Ask it to run one, by the server's own name for it.
 *
 * The progress token is how a server says how it is going while it works,
 * which the window draws on the running tool's row. It is the request's own
 * id, so nothing has to keep a second table to know which call a progress
 * notification belongs to.
 */
export function callTool(
  id: number,
  name: string,
  input: Readonly<Record<string, unknown>>,
): Asked {
  return {
    id,
    method: 'tools/call',
    params: { name, arguments: input, _meta: { progressToken: id } },
  }
}

/** Told to stop: an agent that was given up on is not one left waiting out there. */
export function cancelled(id: number, reason: string): Told {
  return { method: 'notifications/cancelled', params: { requestId: id, reason } }
}

/**
 * One message read back, or null for anything that is not one.
 *
 * A frame that is not JSON, or is JSON that is not an object, is dropped:
 * plenty of servers write a banner to their own output before they start
 * speaking, and a window that died over one is a window that cannot be used.
 */
export function parse(text: string): Message | null {
  let read: unknown
  try {
    read = JSON.parse(text)
  } catch {
    return null
  }
  if (!read || typeof read !== 'object' || Array.isArray(read)) return null
  const one = read as Record<string, unknown>
  // A reply has an id and one of the two answers; a notification has a
  // method and no id. Anything else is not a message this understands.
  const hasId = 'id' in one && (typeof one.id === 'number' || typeof one.id === 'string')
  const isReply = hasId && ('result' in one || 'error' in one)
  const isCall = typeof one.method === 'string'
  if (!isReply && !isCall) return null
  const message: Message = {}
  if (hasId) message.id = one.id as number | string
  if (typeof one.method === 'string') message.method = one.method
  if (one.params && typeof one.params === 'object') {
    message.params = one.params as Record<string, unknown>
  }
  if (one.result && typeof one.result === 'object') {
    message.result = one.result as Record<string, unknown>
  }
  if (one.error && typeof one.error === 'object') {
    const error = one.error as Record<string, unknown>
    message.error = {
      ...(typeof error.code === 'number' ? { code: error.code } : {}),
      message: typeof error.message === 'string' ? error.message : 'it would not say why',
    }
  }
  return message
}

/** What a server said it is, in its own words. Shown as its own, never as Tade's. */
export function about(result: Record<string, unknown> | undefined): ServerAbout {
  const info = (result?.serverInfo ?? {}) as Record<string, unknown>
  return {
    title: typeof info.name === 'string' && info.name !== '' ? info.name : 'a server',
    version: typeof info.version === 'string' ? info.version : '',
  }
}

/**
 * The tools in a `tools/list` answer, with anything that is not one left out.
 *
 * A tool with no name, or whose parameters are not an object, cannot be
 * registered by any harness — pi, Claude Code and Codex all hand a model JSON
 * Schema parameters — so it never becomes an offer. What Tade calls each of
 * them, and which it will not name at all, is `namesFor`'s to say.
 */
export function tools(result: Record<string, unknown> | undefined): OfferedTool[] {
  const said = result?.tools
  if (!Array.isArray(said)) return []
  const out: OfferedTool[] = []
  for (const one of said) {
    if (!one || typeof one !== 'object') continue
    const tool = one as Record<string, unknown>
    if (typeof tool.name !== 'string' || tool.name === '') continue
    const description =
      typeof tool.description === 'string'
        ? tool.description
        : typeof tool.title === 'string'
          ? tool.title
          : ''
    const schema = tool.inputSchema
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) continue
    out.push({ name: tool.name, description, input: schema as JsonSchema })
  }
  return out
}

/** Where the rest of a long list is, when the server said there is more. */
export function more(result: Record<string, unknown> | undefined): string | null {
  return typeof result?.nextCursor === 'string' && result.nextCursor !== ''
    ? result.nextCursor
    : null
}

/**
 * What a call came to, as text.
 *
 * A server calling its own call a failure (`isError`) is an answer, not a
 * throw: a model reads it and picks another route. Content that is not text —
 * an image, a resource — is said as what it is rather than dropped silently,
 * because an answer that arrives as an empty string looks like success.
 */
export function outcome(result: Record<string, unknown> | undefined): ToolOutcome {
  const failed = result?.isError === true
  const content = Array.isArray(result?.content) ? result.content : []
  const parts: string[] = []
  for (const one of content) {
    if (!one || typeof one !== 'object') continue
    const part = one as Record<string, unknown>
    if (typeof part.text === 'string') {
      parts.push(part.text)
    } else if (typeof part.type === 'string') {
      parts.push(`[${part.type}]`)
    }
  }
  if (
    parts.length === 0 &&
    result?.structuredContent &&
    typeof result.structuredContent === 'object'
  ) {
    parts.push(JSON.stringify(result.structuredContent))
  }
  return { text: parts.join('\n'), failed }
}

/** What a progress notification says, in the server's own words. Null when it says nothing. */
export function progress(params: Record<string, unknown> | undefined): string | null {
  if (!params) return null
  if (typeof params.message === 'string' && params.message.trim() !== '') return params.message
  if (typeof params.progress === 'number') {
    const total = typeof params.total === 'number' && params.total > 0 ? ` of ${params.total}` : ''
    return `${params.progress}${total}`
  }
  return null
}

/** Which call a progress notification is about. Null when it is about none Tade knows. */
export function progressFor(params: Record<string, unknown> | undefined): number | null {
  const token = params?.progressToken
  return typeof token === 'number' ? token : null
}

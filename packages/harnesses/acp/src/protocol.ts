// The Agent Client Protocol, as much of it as Tade speaks: the client side.
//
// ACP is JSON-RPC 2.0, one message per line, over the agent's standard input
// and output. The agent is the server for `initialize`, `session/*`; the
// client — Tade's lane, here — answers `session/request_permission` and is
// told everything else in `session/update` notifications.
//
// Pinned: protocol version 1, as `schema/v1/schema.json` is at the tag
// `schema-v1.25.0` of github.com/agentclientprotocol/agent-client-protocol
// (2026-10-09). What is read here is read leniently — every field the schema
// marks `x-deserialize-default-on-error` is optional to us too — and anything
// in a shape this file does not know is null, never a throw: an agent a
// version ahead says more than this reads, and what it says that this does
// not know is skipped rather than taken for an error. Unstable methods
// (`schema.unstable.json`) are not used.

/** The protocol version Tade asks for in `initialize`. */
export const PROTOCOL_VERSION = 1

/** The schema release this file was written against, for whoever updates it. */
export const SCHEMA_RELEASE = 'schema-v1.25.0'

/** Methods Tade calls on an agent. */
export const AGENT = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  newSession: 'session/new',
  loadSession: 'session/load',
  resumeSession: 'session/resume',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  setConfigOption: 'session/set_config_option',
} as const

/** Methods an agent calls on Tade. */
export const CLIENT = {
  requestPermission: 'session/request_permission',
  update: 'session/update',
} as const

/** JSON-RPC error codes the protocol gives a meaning. */
export const ERRORS = {
  methodNotFound: -32601,
  authRequired: -32000,
} as const

export type Json = Record<string, unknown>

const obj = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** What `initialize` answered that Tade acts on. */
export interface AgentInfo {
  protocolVersion: number
  /** `session/load` works: the conversation is replayed and carried on. */
  loadSession: boolean
  /** `session/resume` works: carried on without the replay. */
  resumeSession: boolean
  /** Pictures can go with a prompt as image blocks. */
  images: boolean
  /** MCP servers over HTTP, besides stdio, which every agent takes. */
  mcpHttp: boolean
  authMethods: AuthMethod[]
  /** What the agent calls itself, and its version, where it says. */
  name: string | null
  version: string | null
}

export type AuthMethod =
  | { type: 'terminal'; id: string; name: string; args: string[]; env: Record<string, string> }
  | { type: 'agent'; id: string; name: string; description: string | null }

export function agentInfoOf(result: unknown): AgentInfo | null {
  const said = obj(result)
  if (!said || typeof said.protocolVersion !== 'number') return null
  const caps = obj(said.agentCapabilities) ?? {}
  const prompt = obj(caps.promptCapabilities) ?? {}
  const mcp = obj(caps.mcpCapabilities) ?? {}
  const session = obj(caps.sessionCapabilities) ?? {}
  const info = obj(said.agentInfo) ?? {}
  const methods: AuthMethod[] = []
  for (const raw of Array.isArray(said.authMethods) ? said.authMethods : []) {
    const one = obj(raw)
    const id = str(one?.id)
    const name = str(one?.name)
    if (!one || !id || !name) continue
    if (one.type === 'terminal') {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(obj(one.env) ?? {})) {
        if (typeof value === 'string') env[key] = value
      }
      const args = Array.isArray(one.args) ? one.args.filter((a) => typeof a === 'string') : []
      methods.push({ type: 'terminal', id, name, args, env })
    } else if (one.type === undefined || one.type === 'agent') {
      methods.push({ type: 'agent', id, name, description: str(one.description) })
    }
  }
  return {
    protocolVersion: said.protocolVersion,
    loadSession: caps.loadSession === true,
    resumeSession: obj(session.resume) !== null,
    images: prompt.image === true,
    mcpHttp: mcp.http === true,
    authMethods: methods,
    name: str(info.title) ?? str(info.name),
    version: str(info.version),
  }
}

/** A choice the agent offers for a session: its model, its reasoning level, its mode. */
export interface ConfigOption {
  id: string
  name: string
  /** `model`, `thought_level`, `mode`, … — a hint, never needed for correctness. */
  category: string | null
  current: string
  /** The values it may be set to, by id, with their names. */
  values: { value: string; name: string }[]
}

/** The select options a session offers; boolean ones are not Tade's to set. */
export function configOptionsOf(value: unknown): ConfigOption[] | null {
  if (!Array.isArray(value)) return null
  const out: ConfigOption[] = []
  for (const raw of value) {
    const one = obj(raw)
    const id = str(one?.id)
    if (!one || !id || one.type !== 'select' || typeof one.currentValue !== 'string') continue
    const values: { value: string; name: string }[] = []
    for (const entry of Array.isArray(one.options) ? one.options : []) {
      const option = obj(entry)
      // Grouped options carry theirs one level down.
      const inside = Array.isArray(option?.options) ? option.options : [option]
      for (const item of inside) {
        const it = obj(item)
        const v = str(it?.value)
        if (v) values.push({ value: v, name: str(it?.name) ?? v })
      }
    }
    out.push({
      id,
      name: str(one.name) ?? id,
      category: str(one.category),
      current: one.currentValue,
      values,
    })
  }
  return out
}

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

const KINDS: readonly string[] = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]

/** A tool call as `tool_call`, `tool_call_update` or a permission request carries it. */
export interface ToolCall {
  id: string
  title: string | null
  kind: ToolKind | null
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | null
  /** The paths it touches, where the agent said. */
  paths: string[]
  rawInput: unknown
  /** What it answered, in words, where the agent sent text back. */
  output: string
}

export function toolCallOf(value: unknown): ToolCall | null {
  const said = obj(value)
  const id = str(said?.toolCallId)
  if (!said || !id) return null
  const kind = str(said.kind)
  const status = str(said.status)
  const paths: string[] = []
  for (const raw of Array.isArray(said.locations) ? said.locations : []) {
    const path = str(obj(raw)?.path)
    if (path) paths.push(path)
  }
  const words: string[] = []
  for (const raw of Array.isArray(said.content) ? said.content : []) {
    const one = obj(raw)
    if (one?.type === 'content') {
      const text = textOf(one.content)
      if (text) words.push(text)
    } else if (one?.type === 'diff') {
      const path = str(one.path)
      if (path) {
        words.push(`edited ${path}`)
        if (!paths.includes(path)) paths.push(path)
      }
    }
  }
  if (words.length === 0 && typeof said.rawOutput === 'string') words.push(said.rawOutput)
  return {
    id,
    title: str(said.title),
    kind: kind && KINDS.includes(kind) ? (kind as ToolKind) : null,
    status:
      status === 'pending' ||
      status === 'in_progress' ||
      status === 'completed' ||
      status === 'failed'
        ? status
        : null,
    paths,
    rawInput: said.rawInput,
    output: words.join('\n'),
  }
}

/** The words in a content block, or null for a picture, a sound or a link. */
export function textOf(block: unknown): string | null {
  const one = obj(block)
  if (one?.type === 'text') return str(one.text)
  if (one?.type === 'resource_link') return str(one.uri)
  return null
}

/** What a `session/update` says, in the cases Tade does something with. */
export type Update =
  | { kind: 'you'; text: string }
  | { kind: 'said'; text: string; messageId: string | null }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'tool_update'; call: ToolCall }
  | { kind: 'plan'; entries: { content: string; status: string }[] }
  | { kind: 'titled'; title: string }
  | { kind: 'usage'; used: number; size: number; cost: { amount: number; currency: string } | null }
  | { kind: 'notice'; severity: string; title: string }
  | { kind: 'config'; options: ConfigOption[] }
  | { kind: 'compaction'; status: string; error: string | null }

/** One `session/update` notification's params, or null for a shape this does not know. */
export function updateOf(params: unknown): { sessionId: string; update: Update } | null {
  const said = obj(params)
  const sessionId = str(said?.sessionId)
  const update = obj(said?.update)
  if (!sessionId || !update) return null
  const read = readUpdate(update)
  return read ? { sessionId, update: read } : null
}

function readUpdate(update: Json): Update | null {
  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      const text = textOf(update.content)
      return text === null ? null : { kind: 'you', text }
    }
    case 'agent_message_chunk': {
      const text = textOf(update.content)
      return text === null ? null : { kind: 'said', text, messageId: str(update.messageId) }
    }
    case 'agent_thought_chunk': {
      const text = textOf(update.content)
      return text === null ? null : { kind: 'thought', text }
    }
    case 'tool_call': {
      const call = toolCallOf(update)
      return call ? { kind: 'tool', call } : null
    }
    case 'tool_call_update': {
      const call = toolCallOf(update)
      return call ? { kind: 'tool_update', call } : null
    }
    case 'plan': {
      const entries: { content: string; status: string }[] = []
      for (const raw of Array.isArray(update.entries) ? update.entries : []) {
        const one = obj(raw)
        const content = str(one?.content)
        if (content) entries.push({ content, status: str(one?.status) ?? 'pending' })
      }
      return { kind: 'plan', entries }
    }
    case 'session_info_update': {
      const title = str(update.title)
      return title ? { kind: 'titled', title } : null
    }
    case 'usage_update': {
      if (typeof update.used !== 'number' || typeof update.size !== 'number') return null
      const cost = obj(update.cost)
      return {
        kind: 'usage',
        used: update.used,
        size: update.size,
        cost:
          cost && typeof cost.amount === 'number' && typeof cost.currency === 'string'
            ? { amount: cost.amount, currency: cost.currency }
            : null,
      }
    }
    case 'notice': {
      const title = str(update.title)
      return title ? { kind: 'notice', severity: str(update.severity) ?? 'info', title } : null
    }
    case 'config_option_update': {
      const options = configOptionsOf(update.configOptions)
      return options ? { kind: 'config', options } : null
    }
    case 'compaction_update': {
      const status = str(update.status)
      return status ? { kind: 'compaction', status, error: str(update.error) } : null
    }
    default:
      return null
  }
}

/** Why a turn ended, as `session/prompt` answered. */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export function stopReasonOf(result: unknown): StopReason | null {
  const reason = str(obj(result)?.stopReason)
  switch (reason) {
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
    case 'cancelled':
      return reason
    default:
      return null
  }
}

/** One choice an agent offers when it asks permission. */
export interface PermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
}

export function permissionAskOf(
  params: unknown,
): { sessionId: string; call: ToolCall; options: PermissionOption[] } | null {
  const said = obj(params)
  const sessionId = str(said?.sessionId)
  const call = toolCallOf(said?.toolCall)
  if (!sessionId || !call) return null
  const options: PermissionOption[] = []
  for (const raw of Array.isArray(said?.options) ? said.options : []) {
    const one = obj(raw)
    const optionId = str(one?.optionId)
    if (optionId)
      options.push({ optionId, name: str(one?.name) ?? optionId, kind: str(one?.kind) ?? '' })
  }
  return { sessionId, call, options }
}

/**
 * The answer to a permission request: the agent's own option for once, and
 * for always only where it offers nothing else — what Tade decided is about
 * this call, and a standing yes would be the agent deciding the next one
 * without asking. Nothing that fits is `cancelled`, which the agent reads as
 * not allowed.
 */
export function permissionAnswer(options: readonly PermissionOption[], allow: boolean): Json {
  const order = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const kind of order) {
    const option = options.find((one) => one.kind === kind)
    if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

/** An MCP server as `session/new` takes one. */
export type McpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] }

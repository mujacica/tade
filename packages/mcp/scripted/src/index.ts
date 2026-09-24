import {
  type CallContext,
  McpError,
  type McpTransport,
  type OfferedTool,
  type ServerAbout,
  type ServerDeclaration,
  type ServerSession,
  type ToolOutcome,
  type TransportCapabilities,
  type TransportOptions,
} from '@tade/mcp-core'

// A transport that answers from a table.
//
// It is what the conformance suite runs on, what makes the broker and every
// harness test provable with no program and no network, and the second
// implementation the port needs to stay honest. It starts nothing and reaches
// nothing — which is exactly why the tests that assert a fake server's tools
// reach pi, Claude Code and the orchestrator stay offline and quick.
//
// It is registered and chosen for nobody: a server that answers whatever you
// scripted is not a server, so whoever wants one names it.

/** What one scripted server is and does. */
export interface ScriptedServer {
  /** What it says it is. */
  about?: ServerAbout
  /**
   * What it offers. Anything in here that is not shaped like a tool is what a
   * server answering with things nothing recognises looks like: it is left
   * out, and the rest of the list still works.
   */
  tools?: readonly OfferedTool[]
  /** What a call answers, by the server's own name for the tool. */
  answers?: Readonly<
    Record<string, ToolOutcome | ((input: Readonly<Record<string, unknown>>) => ToolOutcome)>
  >
  /** It is not here, and this is what to do about it: what `ready()` says. */
  problem?: string | null
  /** Its open never answers, so the deadline is what ends it. */
  hangs?: boolean
  /** Opening it fails, and this is what it said. */
  refuses?: string
  /** How long a call takes, so an ordering bug has somewhere to show. */
  ms?: number
  /** It says its tool list changed, this long after it was opened. */
  changesAfterMs?: number
  /**
   * It goes away after this many calls on one session, the way a program
   * that crashed or a session a server forgot does: every call from then on
   * is `gone`, and opening it again gets a session that works.
   *
   * `0` is one that never survives a call at all, which is how a server that
   * dies twice in a row is written down.
   */
  diesAfter?: number
}

export interface ScriptedTransportOptions extends TransportOptions {
  /** What each server is, by the name it is declared under. */
  servers?: Readonly<Record<string, ScriptedServer>>
  capabilities?: Partial<TransportCapabilities>
}

const ABOUT: ServerAbout = { title: 'a scripted server', version: '0' }

export function makeScriptedTransport(options: ScriptedTransportOptions = {}): McpTransport {
  const servers = options.servers ?? {}
  const cap = options.cap ?? 20_000
  const capabilities: TransportCapabilities = {
    spawns: false,
    network: false,
    announces: true,
    cancel: true,
    ...options.capabilities,
  }

  const scripted = (server: ServerDeclaration): ScriptedServer =>
    servers[server.name] ?? { tools: [], answers: {} }

  return {
    id: 'scripted',
    capabilities,
    async ready(server) {
      return scripted(server).problem ?? null
    },
    async open(server, ctx) {
      const one = scripted(server)
      if (one.problem) throw new McpError('unavailable', one.problem)
      if (one.hangs) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, ctx.deadlineMs)
          timer.unref?.()
        })
        throw new McpError(
          'timeout',
          `${server.name} did not answer in ${Math.round(ctx.deadlineMs / 1000)}s`,
        )
      }
      if (one.refuses) throw new McpError('refused', `${server.name} would not start`, one.refuses)
      return session(server.name, one, cap)
    },
  }
}

function session(name: string, one: ScriptedServer, cap: number): ServerSession {
  let open = true
  // Per session, not per server: a server that died is opened again, and what
  // comes back is a session that works. Anything else would make the broker's
  // one retry untestable, because it would never have anything to retry onto.
  let calls = 0
  const listeners = new Set<() => void>()
  if (one.changesAfterMs !== undefined) {
    const timer = setTimeout(() => {
      for (const listener of listeners) listener()
    }, one.changesAfterMs)
    timer.unref?.()
  }
  const shaped = (): OfferedTool[] => [
    // Noise is what a server that answers with things nothing here recognises
    // looks like: it is left out, the rest of the list works, and nothing
    // throws over it.
    ...(one.tools ?? []).filter(
      (tool): tool is OfferedTool =>
        !!tool && typeof tool.name === 'string' && typeof tool.description === 'string',
    ),
  ]
  return {
    about: one.about ?? ABOUT,
    async listTools() {
      if (!open) throw new McpError('gone', `${name} was closed`)
      return shaped()
    },
    async callTool(tool: string, input: Readonly<Record<string, unknown>>, ctx: CallContext) {
      if (!open) throw new McpError('gone', `${name} was closed`)
      if (one.diesAfter !== undefined && calls >= one.diesAfter) {
        open = false
        throw new McpError('gone', `${name} stopped`)
      }
      calls += 1
      if (!shaped().some((offered) => offered.name === tool)) {
        throw new McpError('refused', `${name} has no tool called ${tool}`)
      }
      if (one.ms) {
        ctx.progress(`asking ${name}`)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, one.ms)
          timer.unref?.()
          // An agent is waiting on this, so being told to stop is being told
          // to stop: it comes back refused rather than staying out there.
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          })
        })
        if (ctx.signal.aborted) throw new McpError('refused', `${name} was given up on`)
      }
      const answer = one.answers?.[tool]
      const outcome =
        typeof answer === 'function'
          ? answer(input)
          : (answer ?? { text: `${name} ran ${tool}`, failed: false })
      return { text: outcome.text.slice(0, cap), failed: outcome.failed }
    },
    onToolsChanged(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      open = false
      listeners.clear()
    },
  }
}

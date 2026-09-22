import { type Secrets, secretName } from '@tade/core'
import type {
  ExtensionContext,
  ExtensionTool,
  TadeExtension,
  ToolAnswer,
  ToolContext,
} from '@tade/extensions-core'
import {
  type CachedServer,
  type CatalogueEntry,
  type DeclaredServer,
  declared,
  type MakeTransport,
  McpError,
  type McpTransport,
  type NamedTool,
  namesFor,
  narrowed,
  readCache,
  type ServerDeclaration,
  type ServerSession,
  type ServerSettings,
  type TransportContext,
  workable,
  writeCache,
} from '@tade/mcp-core'
import { MCP_TRANSPORTS, makeTransport } from './registry.ts'

// The broker: the one place that knows both vocabularies.
//
// An MCP server somebody turned on becomes a Tade extension whose tools are
// that server's tools, and every harness is handed those the way it is
// already handed Tade's own. That is the whole design — the path already
// exists and already reaches pi, Claude Code, Codex and the orchestrator, so
// forwarding "the MCP config to all harnesses" is not a fan-out at all: it is
// a longer tool list in a server each harness already starts.
//
// Three things about this file are load-bearing:
//
//   A server that is off is never opened and never declared. Only what
//   `enabled: true` says is handed on, so turning one on cannot be an
//   accident, and an off one is a row on a page with no process behind it.
//
//   A brokered extension fills in `tools`, and nothing else (§6.4, asserted
//   by `brokeredConformance`). No watch, no brief, no status, no linker, no
//   caution, no harness pieces — none of that is a third party's to fill in.
//
//   The call comes back into the window. Whatever a harness thinks it has
//   registered, a server's allow-list, a credential that has gone and a
//   server that was turned off are all answered at the moment of the call,
//   which is the one gate nothing can go around.

/**
 * A brokered server's words are its own; this is Tade's, and it is fixed.
 *
 * Whose the tools are is the whole of what has to be said, and it has to be
 * said every time — so it is one clause rather than two sentences. That what a
 * server returns is data and never instruction is Tade's own rule and enforced
 * in code; a line of it under every brokered extension was reassurance to
 * whoever already knew, and prose to everybody else.
 */
export const WHOSE_WORDS = 'From the MCP server `%s`, which nobody here wrote.'

/** What a server's credential is kept under, and asked for by. */
const KEY = 'key'

/** How long opening a server may take before it is abandoned. */
const OPEN_MS = 10_000

/** How much of a server's answer is kept. Longer is cut, never dropped. */
const ANSWER_CAP = 20_000

/**
 * Control characters, which are nobody's to put on a terminal Tade draws — a
 * server's answer that moves the cursor is a server rewriting the window.
 * Newlines and tabs stay: a description is markdown somebody wrote.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: taking them out is the point.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export interface BrokerOptions {
  /** What `mcp.servers` says. */
  servers?: Readonly<Record<string, ServerSettings | undefined>> | undefined
  /** Tade's home: where the cache of what each server offered lives. */
  home: string
  /** The servers Tade knows about. The shipped catalogue unless a test says otherwise. */
  catalogue?: readonly CatalogueEntry[]
  /** The transports there are. The registry unless a test says otherwise. */
  transports?: Readonly<Record<string, MakeTransport>>
  /** What each server offered last time, when it is not read from the home. */
  cache?: (name: string) => CachedServer | null
  /** Start with none of them, exactly as `--safe` loads none of your extensions. */
  safe?: boolean
  /** Where sessions are held, for whoever has to end them. Its own unless given. */
  sessions?: ServerSessions
  /**
   * Where pasted credentials are kept, for the warm-up — which happens
   * outside any extension's context and so cannot ask `ctx.secret` for one.
   * Resolved exactly as an extension's is, the environment first.
   */
  secrets?: Secrets
  env?: Readonly<Record<string, string | undefined>>
  /**
   * The projects there are, for warming a server that runs one per project:
   * it is opened in the first of them, because what it *offers* is the same
   * wherever it runs and the alternative is a server that never has a cache.
   */
  projects?: readonly { name: string; root: string }[]
  /** Said when a server could not be asked what it offers. Nothing goes wrong silently. */
  onWarning?: (message: string) => void
  now?: () => number
}

/** What the broker was told, and what it made of it. */
export interface Brokered {
  /** One per server that is on and workable: what the extension host is handed. */
  extensions: readonly TadeExtension[]
  /** Every server Tade has been told about, with what is wrong with each. */
  servers: readonly DeclaredServer[]
  /**
   * Ask each server that is on what it offers, once, and write it down. Off
   * the draw path and never on the way up: what an agent launching right now
   * gets is the cache, which is what makes the first agent after a restart
   * have the tools at all.
   */
  warm(signal?: AbortSignal): Promise<void>
  /** End every session. Safe to call twice. */
  close(): Promise<void>
}

/**
 * The sessions a window has open, so whoever started them can end them.
 *
 * A session is opened at the first call that needs it and kept: opening one
 * per call would be a process per call under a transport that starts
 * programs. One that has gone is dropped and opened again once — a dead
 * server is not a dead window — and a second failure is an answer with why.
 */
export class ServerSessions {
  private readonly open = new Map<string, Promise<ServerSession>>()

  async of(name: string, start: () => Promise<ServerSession>): Promise<ServerSession> {
    const already = this.open.get(name)
    if (already) return already
    const opening = start().catch((err: unknown) => {
      this.open.delete(name)
      throw err
    })
    this.open.set(name, opening)
    return opening
  }

  /** Forget one, ending it if it is still there. */
  async drop(name: string): Promise<void> {
    const held = this.open.get(name)
    this.open.delete(name)
    await held?.then((session) => session.close()).catch(() => {})
  }

  async close(): Promise<void> {
    await Promise.all([...this.open.keys()].map((name) => this.drop(name)))
  }
}

/**
 * Every enabled server as an extension, and what Tade was told about all of
 * them. The whole of the wiring: whoever loads extensions appends these, and
 * every harness and the orchestrator are reached without an adapter changing.
 */
export function brokered(options: BrokerOptions): Brokered {
  const transports = options.transports ?? MCP_TRANSPORTS
  const servers = declared({
    servers: options.servers,
    ...(options.catalogue ? { catalogue: options.catalogue } : {}),
    // What each transport says it can do, rather than a list of names kept
    // here: which of them start a program is theirs to declare (R3).
    transports: kindsOf(transports),
  })
  const sessions = options.sessions ?? new ServerSessions()
  const cached = options.cache ?? ((name: string) => readCache(options.home, name))
  // `--safe` loads none of yours and must keep working with a broken server
  // sitting in the config: safe mode that only works when nothing is wrong is
  // not a recovery path.
  const on = options.safe ? [] : workable(servers)

  const environment = options.env ?? process.env
  // What went wrong the last time anybody talked to one, so the page can say
  // it was broken rather than say nothing has asked it yet. Remembered here
  // and never dialled for: `ready()` is asked on every look at the page.
  const troubles = new Map<string, string>()
  const made = on.map((server) =>
    extensionFor({
      server,
      home: options.home,
      transport: () => transportFor(server.declaration, transports),
      cached,
      sessions,
      troubles,
    }),
  )
  const said = options.onWarning ?? (() => {})

  return {
    extensions: made,
    servers,
    async warm(signal?: AbortSignal) {
      for (const server of on) {
        if (signal?.aborted) return
        const declaration = server.declaration
        // A server that runs one per project is warmed in the first of them:
        // what it *offers* is the same wherever it runs, and the alternative
        // is a server whose tools nobody ever has.
        const where = declaration.scope === 'project' ? options.projects?.[0]?.root : undefined
        if (declaration.scope === 'project' && !where) {
          said(
            `${declaration.name} runs one per project and there are none here yet, so nothing has asked it what it offers`,
          )
          continue
        }
        const key = sessionKey(declaration.name, where)
        try {
          const transport = transportFor(declaration, transports)
          const session = await sessions.of(key, () =>
            transport.open(declaration, {
              ...contextFor(declaration, credentialOf(declaration, options), options.home, {
                env: environment,
              }),
              ...(where ? { cwd: where } : {}),
            }),
          )
          const write = async () => {
            const tools = await session.listTools(signal)
            writeCache(options.home, declaration.name, {
              about: session.about,
              tools,
              asked: new Date(options.now?.() ?? Date.now()).toISOString(),
            })
          }
          await write()
          troubles.delete(declaration.name)
          // A server that says its list changed is written down again, and
          // that is as far as it goes: agents are given their tools when they
          // launch, so a new list reaches the next window — the same rule as
          // turning a server on, and for the same reason.
          if (transport.capabilities.announces) {
            session.onToolsChanged(() => {
              void write().catch(() => {
                // What was written down last time still stands.
              })
            })
          }
        } catch (err) {
          // A server that will not answer is a server listed as broken, not a
          // window that refuses to open. Nothing here throws — and nothing
          // goes wrong silently either, so it is said once, in its own words.
          await sessions.drop(key)
          troubles.set(declaration.name, trouble(err))
          said(`${declaration.name} could not be asked what it offers: ${why(err)}`)
        }
      }
    },
    close: () => sessions.close(),
  }
}

/**
 * Which session a call uses: one for the window, or one per project for a
 * server scoped to one. Never one per agent — that is a process per agent,
 * and a third party's handle on a worktree Tade's gate cannot see into.
 */
function sessionKey(name: string, project: string | undefined): string {
  return project ? `${name} in ${project}` : name
}

/**
 * The credential, for the warm-up, found exactly as an extension's is: the
 * environment first — a machine that works today goes on working — then
 * wherever Tade keeps what was pasted. Never from the config.
 */
function credentialOf(server: ServerDeclaration, options: BrokerOptions): string | null {
  if (server.auth === 'none') return null
  const env = options.env ?? process.env
  const name = secretName(`mcp-${server.name}`, KEY)
  if (options.secrets) {
    return options.secrets.find(name, { env, variables: server.variables })?.value ?? null
  }
  for (const variable of server.variables) {
    const value = env[variable]
    if (value?.trim()) return value.trim()
  }
  return null
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * What went wrong, with what the server itself said on its way out — which is
 * the part somebody reading the page can actually act on, and is the server's
 * own words rather than Tade's guess at them.
 */
function trouble(err: unknown): string {
  const tail = err instanceof McpError && err.said ? readable(err.said, 400) : ''
  return tail ? `${why(err)}: ${tail}` : why(err)
}

/** The transports there are, as a declaration can be judged against them. */
export function kindsOf(
  transports: Readonly<Record<string, MakeTransport>>,
): { id: string; spawns: boolean; network: boolean }[] {
  return Object.entries(transports).map(([id, make]) => {
    const { spawns, network } = make().capabilities
    return { id, spawns, network }
  })
}

function transportFor(
  server: ServerDeclaration,
  transports: Readonly<Record<string, MakeTransport>>,
): McpTransport {
  return makeTransport(server.transport, { cap: ANSWER_CAP }, transports)
}

/** What a transport is given: never the window's whole environment. */
function contextFor(
  server: ServerDeclaration,
  credential: string | null,
  home: string,
  ctx?: Pick<ExtensionContext, 'env'> & Partial<Pick<ExtensionContext, 'fetch' | 'now'>>,
  cwd?: string,
): TransportContext {
  return {
    home,
    credential,
    // `PATH`, `HOME`, `TMPDIR` and what the declaration itself names — not
    // the window's environment, which holds everybody's tokens.
    env: scrubbed(ctx?.env ?? {}, server.env),
    fetch: ctx?.fetch ?? fetch,
    now: () => ctx?.now?.() ?? Date.now(),
    deadlineMs: OPEN_MS,
    ...(cwd ? { cwd } : {}),
  }
}

/**
 * The environment a server's program gets: three variables it cannot work
 * without, and what its own declaration names. Never the window's own, which
 * holds everybody's tokens — the credential travels the one way `auth` says.
 */
function scrubbed(
  env: Readonly<Record<string, string | undefined>>,
  declared: Readonly<Record<string, string>>,
): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR']) {
    const value = env[key]
    if (typeof value === 'string') kept[key] = value
  }
  return { ...kept, ...declared }
}

function extensionFor(opts: {
  server: DeclaredServer
  home: string
  transport: () => McpTransport
  cached: (name: string) => CachedServer | null
  sessions: ServerSessions
  /** What went wrong the last time anybody talked to one, by server name. */
  troubles: Map<string, string>
}): TadeExtension {
  const { declaration } = opts.server
  const name = declaration.name
  const whose = WHOSE_WORDS.replace('%s', name)
  const tools = offered(opts.server, opts.cached(name))

  /** The credential, found the way every extension's is: the environment first. */
  const credential = (ctx: ExtensionContext): string | null =>
    declaration.auth === 'none' ? null : (ctx.secret(KEY)?.value ?? null)

  const call = async (
    tool: NamedTool,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolAnswer> => {
    // Enforced here and not only when the list was built: whatever a harness
    // thinks it has registered, the call has to come back into the window.
    if (declaration.tools.length > 0 && tool.name && !declaration.tools.includes(tool.name)) {
      throw new Error(`${tool.name} is not one of the tools ${name} was turned on for`)
    }
    const where = placeFor(declaration, ctx)
    const outcome = await withOneRetry(
      sessionKey(name, where),
      opts.sessions,
      () => start(ctx, where),
      (session) =>
        session.callTool(tool.offered.name, input, {
          signal: ctx.signal,
          progress: ctx.progress,
        }),
    ).then(
      (answered) => {
        // It answered, so whatever was wrong with it before is not now.
        opts.troubles.delete(name)
        return answered
      },
      (err: unknown) => {
        // Not being able to ask at all is what the page has to say about it;
        // a call the server itself refused is about the call, not the server.
        if (err instanceof McpError) opts.troubles.set(name, trouble(err))
        throw err
      },
    )
    const text = readable(outcome.text)
    // A tool fails by throwing: pi marks a call failed only then, and
    // anything else reaches the model as an answer that looks like success.
    if (outcome.failed) throw new Error(text === '' ? `${name} said no, and said nothing` : text)
    // No `said`: a brokered answer is never what a voice reads out, and what
    // is spoken is `speakable` of its first line rather than a wall of
    // somebody else's text.
    return { text }
  }

  const start = (ctx: ExtensionContext, where?: string) => {
    const transport = opts.transport()
    return transport.open(
      declaration,
      contextFor(declaration, credential(ctx), opts.home, ctx, where),
    )
  }

  return {
    name: `mcp-${name}`,
    title: opts.server.title,
    description: `${opts.server.description || `Tools from the MCP server ${name}.`} ${whose}`,
    workflow: [...opts.server.workflow, whose],
    ...(declaration.auth === 'none'
      ? {}
      : {
          settings: [
            {
              key: KEY,
              kind: 'secret' as const,
              means: `The credential ${name} is reached with. Kept where credentials are kept, never in the config, and whatever the environment says wins.`,
              ...(declaration.variables.length > 0 ? { env: declaration.variables } : {}),
            },
          ],
        }),
    async ready(ctx: ExtensionContext) {
      if (declaration.auth !== 'none' && !credential(ctx)) {
        const where =
          declaration.variables.length > 0
            ? `, or set ${declaration.variables.map((one) => `$${one}`).join(' or ')}`
            : ''
        return `${name} needs a credential: paste one${where}`
      }
      const said = await opts
        .transport()
        .ready(declaration, contextFor(declaration, credential(ctx), opts.home, ctx))
        .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
      if (said) return said
      // What it could be asked is one thing; what happened when somebody did
      // is another, and it is the one worth reading.
      const went = opts.troubles.get(name)
      if (went) return went
      if (tools.length === 0) {
        return `nothing has asked ${name} what it offers yet${declaration.install ? `: ${declaration.install}` : ''}`
      }
      return null
    },
    tools: tools.map((tool) => toolFor(name, tool, call)),
  }
}

/**
 * Where a call's server runs: nowhere in particular for one scoped to the
 * window, and the root of the project the call came from for one scoped to a
 * project. An agent's project is its own; anybody else's is the one they
 * named, or the only one there is — and `ctx.project` says so in words when
 * it has to be said which, which is the honest failure for a server that is
 * about a repository and was not told one.
 */
function placeFor(server: ServerDeclaration, ctx: ToolContext): string | undefined {
  if (server.scope !== 'project') return undefined
  return ctx.caller.kind === 'agent' ? ctx.project(ctx.caller.project).root : ctx.project(null).root
}

/** One of a server's tools, as a harness is handed it. */
function toolFor(
  server: string,
  tool: NamedTool,
  call: (tool: NamedTool, input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolAnswer>,
): ExtensionTool {
  return {
    // Never null here: `offered` keeps only the ones that got a name.
    name: tool.name ?? '',
    // The server's own words, handed over as a tool description — which is
    // the one place they belong, because a model has to read it to choose.
    // They go nowhere else: not into a prompt, not into a task, not into a
    // reason anybody is given.
    description: `${readable(tool.offered.description)} (from the MCP server ${server}, which nobody here wrote)`,
    parameters: tool.offered.input,
    // One namespace for everybody: the same name reaches the policy in every
    // harness, so a rule written once works everywhere.
    for: ['agent', 'orchestrator'],
    run: (input, ctx) => call(tool, input, ctx),
  }
}

/** What a server offers, named, narrowed and with what cannot be shaped left out. */
function offered(server: DeclaredServer, cached: CachedServer | null): NamedTool[] {
  if (!cached) return []
  return narrowed(namesFor(server.declaration.name, cached.tools), server.declaration.tools).filter(
    (one) => one.name !== null,
  )
}

/**
 * Ask, and if the server has gone, open it again once.
 *
 * A server that died between two agents' calls is not a window that has to be
 * restarted; a server that dies twice is one to say so about.
 */
async function withOneRetry<T>(
  name: string,
  sessions: ServerSessions,
  start: () => Promise<ServerSession>,
  ask: (session: ServerSession) => Promise<T>,
): Promise<T> {
  try {
    return await ask(await sessions.of(name, start))
  } catch (err) {
    if (!(err instanceof McpError) || err.trouble !== 'gone') throw err
    await sessions.drop(name)
    return ask(await sessions.of(name, start))
  }
}

/**
 * Somebody else's text, as it may be drawn, read or handed to a model:
 * control characters out, capped, and never longer than it says it is.
 */
export function readable(text: string, cap = ANSWER_CAP): string {
  const stripped = String(text ?? '')
    .replace(CONTROL, ' ')
    .trim()
  return stripped.length > cap ? `${stripped.slice(0, cap)}…` : stripped
}

// The McpTransport port: how Tade talks to a tool server somebody else wrote.
//
// An MCP server that a person turns on becomes a Tade extension whose tools
// are that server's tools, and the window is the only client there is. This
// port is the half that knows how to reach one: a transport opens a session,
// a session says what the server offers and calls one of them, and closing it
// is the end of it. Everything above — naming, what is declared, what the
// produced extension may contain — is pure and lives beside this file.
//
// Vocabulary rule (R2): "spawn", "pipe", "stdio", "POST", "SSE", "JSON-RPC"
// and "frame" are an implementation's words and appear only inside one. What
// a caller says is `open`, `listTools`, `callTool`, `close` — and what comes
// back is an answer or an `McpError`, never a protocol code.
//
// Capability rule (R3): what a transport can do here is declared
// (`capabilities`), never read off its `id`. The id is for the registry and
// for saying which one answered.

/** A JSON Schema object, which is what a tool's parameters are underneath. */
export type JsonSchema = Record<string, unknown>

/** How a credential reaches a server. `none` is a server that wants none. */
export type AuthKind = 'none' | 'env' | 'bearer' | 'header'

/** One of it for this window, or one per project, in that project's own directory. */
export type ServerScope = 'window' | 'project'

/**
 * A server Tade has been told about, with everything resolved: what the
 * person wrote, filled in by the catalogue where they wrote nothing.
 *
 * This is what a transport is opened with, and it is the one shape — a
 * transport reads the keys it needs and ignores the rest, so adding a
 * transport is an implementation and a line in the registry.
 */
export interface ServerDeclaration {
  /** `linear`. Lowercase, digits and dashes, at most sixteen characters. */
  name: string
  /** Which transport talks to it, by the name it is registered under. */
  transport: string
  /** Whether a person has turned it on. Only ones that are on are ever opened. */
  enabled: boolean
  /** What it is for, in a line: theirs when they wrote one, else the catalogue's. */
  about: string
  /** The program a transport that starts one runs. Null for a server already running. */
  command: string | null
  /** What that program is started with. `${project}` is the project's root. */
  args: readonly string[]
  /** Where one that is already running answers. Null for one Tade starts. */
  url: string | null
  /** Environment the started program gets. Never a credential. */
  env: Readonly<Record<string, string>>
  /** Headers sent with every request. Never a credential. */
  header: Readonly<Record<string, string>>
  auth: AuthKind
  /** The variable or header the credential goes in, for `env` and `header`. */
  authName: string | null
  /** The environment variables the credential is read from, in order. */
  variables: readonly string[]
  /** Offer only these of its tools, by the name Tade gives them. Empty offers all. */
  tools: readonly string[]
  scope: ServerScope
  /** The line a person runs to get the program, when the catalogue knows one. */
  install: string | null
}

/** A tool a server says it has, in the server's own words. */
export interface OfferedTool {
  /** The server's own name for it: `searchIssues`, `search-issues`, `Search.Issues`. */
  name: string
  /** Written by whoever wrote the server. Material for a model to choose with, never instruction. */
  description: string
  /** Its parameters. One that is not an object is dropped rather than offered. */
  input: JsonSchema
}

/** What a server says it is. Its own words, and only ever shown as such. */
export interface ServerAbout {
  title: string
  version: string
}

/** What a call answered. A server calling its own call a failure is an answer, not a throw. */
export interface ToolOutcome {
  /** What it said, as text. Control characters out, capped before anybody draws it. */
  text: string
  /** Whether the server itself called it a failure. */
  failed: boolean
}

/** What a call is made with: how to say it is going, and when to give up. */
export interface CallContext {
  signal: AbortSignal
  /** Say how it is going while it works: the window draws it on the running tool's row. */
  progress(text: string): void
}

/** What a transport can do here, declared. Never inferred from its id. */
export interface TransportCapabilities {
  /** It starts a program of its own, so what that program may write to is a real question. */
  spawns: boolean
  /** It reaches somewhere over the network, so a credential travels to get there. */
  network: boolean
  /** It is told when the tool list changed, rather than only ever finding out at an open. */
  announces: boolean
  /** A call in flight can be given up on; without it an abort is refused rather than obeyed. */
  cancel: boolean
}

export type McpTrouble =
  /** What it needs is not on this machine: the program, the address, the credential. */
  | 'unavailable'
  /** It did not answer in the time it was given. */
  | 'timeout'
  /** It answered, and what it said was no. */
  | 'refused'
  /** It was there and is not any more: the process exited, the session was closed. */
  | 'gone'
  /** A capability is false and it was asked anyway. */
  | 'unsupported'

/**
 * How talking to a server fails. Kinds, not strings, because a caller acts
 * differently on each: `unavailable` is a sentence on the page, `timeout` is
 * a server to stop waiting on, `gone` is one to open again once.
 */
export class McpError extends Error {
  readonly trouble: McpTrouble
  /** What the server itself said, unchanged, for whoever has to read it. */
  readonly said?: string

  constructor(trouble: McpTrouble, message: string, said?: string) {
    super(message)
    this.name = 'McpError'
    this.trouble = trouble
    if (said !== undefined) this.said = said
  }
}

/** An open conversation with one server. */
export interface ServerSession {
  /** What the server said it is. Its own words: shown as its own, never as Tade's. */
  readonly about: ServerAbout
  /** What it offers. Never throws for one bad tool: what cannot be shaped is left out. */
  listTools(signal?: AbortSignal): Promise<readonly OfferedTool[]>
  /**
   * Call one, by the server's own name for it. A server that calls it a
   * failure is a `ToolOutcome` with `failed`; only not being able to ask at
   * all is an `McpError`.
   */
  callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    ctx: CallContext,
  ): Promise<ToolOutcome>
  /**
   * Called when the server says its tool list changed. Only ever called where
   * `capabilities.announces`; the returned function stops listening.
   */
  onToolsChanged(listener: () => void): () => void
  /**
   * Called when the server went away without being asked to: the program
   * exited, the stream ended, the session a server was keeping is gone.
   *
   * **Never for a `close()`** — whoever ends a session knows they ended it,
   * and a drop reported for a shutdown is a report nobody can act on. Called
   * at most once, with the `gone` that every call after it will get.
   *
   * How soon is the transport's own: one talking to a program hears the exit
   * the moment it happens, and one that only speaks when spoken to finds out
   * at the call that fails. Neither is branched on — a caller reports what it
   * learns when it learns it — so this is a contract rather than a capability.
   * The returned function stops listening.
   */
  onGone(listener: (err: McpError) => void): () => void
  /** End it. Safe to call twice, and safe to call on one that already died. */
  close(): Promise<void>
}

/** What a transport is given to reach a server: never the window's whole environment. */
export interface TransportContext {
  /** Tade's home, for a scratch directory of the server's own. */
  home: string
  /**
   * The credential, already found — the environment first, then where Tade
   * keeps what was pasted. Null when the server declared none or there is
   * none. This is the only copy a transport is given, and where it puts it is
   * what `auth` says.
   */
  credential: string | null
  /** The environment a started program gets, already scrubbed. */
  env: Readonly<Record<string, string>>
  /** Where a project-scoped server runs, when the call came from one. */
  cwd?: string
  fetch: typeof fetch
  now(): number
  /** How long an open may take before it is abandoned. */
  deadlineMs: number
}

export interface McpTransport {
  /** Registered under this: `stdio`, `http`, `scripted`. */
  readonly id: string
  readonly capabilities: TransportCapabilities
  /**
   * Whether it could talk to this server at all, and if not, what to do about
   * it — "linear-mcp is not on this machine: npm i -g …". Null when it could.
   *
   * Never throws, and **never touches the network**: it answers from the
   * declaration, the filesystem and the credential it was given. What a
   * server actually offers is only knowable by opening one.
   */
  ready(server: ServerDeclaration, ctx: TransportContext): Promise<string | null>
  /**
   * Open a session, or throw an `McpError` saying why not. An open that does
   * not answer inside `ctx.deadlineMs` is abandoned rather than waited on.
   */
  open(server: ServerDeclaration, ctx: TransportContext): Promise<ServerSession>
}

/** What a transport is made with. */
export interface TransportOptions {
  /** Characters of a server's answer kept. What is longer is cut, never dropped. */
  cap?: number
  now?: () => number
}

/** How a transport is made, by name, in the one registry every call site goes through. */
export type MakeTransport = (options?: TransportOptions) => McpTransport

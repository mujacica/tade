import {
  type CachedServer,
  type DeclaredFrom,
  type DeclaredServer,
  namesFor,
  narrowed,
  readCache,
  type ServerSettings,
} from '@tade/mcp-core'

// A server as a page says it.
//
// Here rather than in the window because it is the answer to "what is true
// about this server", and what is true is the broker's: what was declared,
// what is wrong with it, what it offered when anybody last asked, and what of
// that Tade will not hand on. The window draws it and decides nothing.
//
// It says only what is true. A server that is off was never connected, so
// there is nothing to say about it beyond what it is and what turning it on
// would need — no tools, no version, no "last asked". A credential is a place
// and never a value, and it is not here at all: that is `host.secrets()`, the
// same field every extension's key gets.

/** One server, as the Extensions page shows it. */
export interface ServerShown {
  name: string
  title: string
  description: string
  /** What somebody is doing when they reach for it: the catalogue's words. */
  workflow: readonly string[]
  /** Whether a person has turned it on. */
  on: boolean
  /** Whether anybody has decided about it at all, either way. */
  decided: boolean
  /** What is wrong with it, or what has to happen first. Null when nothing is. */
  problem: string | null
  /** How Tade talks to it, as somebody would read it: the command, or the address. */
  how: string
  /** The line a person runs to get the program. Shown, and never run behind a spinner. */
  install: string | null
  /** What is true about it that nobody would guess. */
  note: string | null
  /** When anybody last asked it what it offers. Null when nobody has. */
  asked: string | null
  /** What it offered, by the name agents use, with the server's own beside it. */
  tools: readonly { name: string; from: string; summary: string }[]
  /** What it offered that Tade will not hand on, and why. */
  dropped: readonly { name: string; why: string }[]
  /**
   * Its command fetches code from the network every time it starts, so the
   * page says so beside it. A command somebody wrote is theirs, `npx -y …`
   * included — this is a reading of what they wrote, not a refusal.
   */
  fetches: boolean
  /** Whose words these are: the catalogue's, yours, or both. */
  from: DeclaredFrom
}

/**
 * Whether starting it downloads somebody's code first.
 *
 * A reading of a command, the way `classifyCommand` reads one — never a
 * capability, never a refusal. The catalogue ships none of these (a test
 * holds it to that); a person may write one, and then they are told what it
 * does rather than stopped from doing it.
 */
export function fetchesCode(command: string | null): boolean {
  return /^(npx|uvx|pipx|bunx|dlx)\b/.test((command ?? '').trim().split(/[\\/]/).pop() ?? '')
}

export interface ShownOptions {
  /** Where what each server offered was written down. */
  home: string
  /** What `mcp.servers` says, so a server somebody decided about is known to be one. */
  servers?: Readonly<Record<string, ServerSettings | undefined>> | undefined
  /** What each offered, when it is not read from the home. */
  cache?: (name: string) => CachedServer | null
}

/** Every server Tade has been told about, as a page says it. In the order it was given them. */
export function shownServers(
  servers: readonly DeclaredServer[],
  options: ShownOptions,
): ServerShown[] {
  const cached = options.cache ?? ((name: string) => readCache(options.home, name))
  return servers.map((server) => one(server, cached(server.declaration.name), options.servers))
}

function one(
  server: DeclaredServer,
  cache: CachedServer | null,
  written: Readonly<Record<string, ServerSettings | undefined>> | undefined,
): ServerShown {
  const { declaration } = server
  // Only what came back from a real answer, and only for a server somebody
  // turned on: one that is off was never connected, and a list of tools
  // beside "off" reads as a promise Tade did not make.
  const named = declaration.enabled && cache ? namesFor(declaration.name, cache.tools) : []
  const narrow = narrowed(named, declaration.tools)
  return {
    name: declaration.name,
    title: server.title,
    description: server.description,
    workflow: server.workflow,
    on: declaration.enabled,
    decided: written?.[declaration.name] !== undefined,
    problem: server.problem,
    how: howOf(server),
    install: declaration.install,
    note: server.note,
    asked: declaration.enabled && cache ? cache.asked : null,
    tools: narrow
      .filter((tool) => tool.name !== null)
      .map((tool) => ({
        name: tool.name ?? '',
        from: tool.offered.name,
        summary: tool.offered.description,
      })),
    dropped: narrow
      .filter((tool) => tool.dropped !== null)
      .map((tool) => ({ name: tool.offered.name, why: tool.dropped ?? '' })),
    fetches: fetchesCode(declaration.command),
    from: server.from,
  }
}

/**
 * How Tade talks to it, in a line somebody can check: the command it starts
 * with what it is started with, or the address it answers at. Never the
 * credential, which is said as a place wherever it is said at all.
 */
function howOf(server: DeclaredServer): string {
  const { declaration } = server
  if (declaration.url) return declaration.url
  if (declaration.command) return [declaration.command, ...declaration.args].join(' ')
  return declaration.transport === '' ? 'nothing says' : declaration.transport
}

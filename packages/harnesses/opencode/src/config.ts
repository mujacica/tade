import { readFileSync } from 'node:fs'

// What one OpenCode run is handed, all of it in `OPENCODE_CONFIG_CONTENT`.
//
// OpenCode V2 reads that variable in the server process and nowhere else, and
// ranks it above every config file but an organization's managed ones. So it
// reaches a `--standalone` server — the private one a lane's TUI starts as its
// own child — and never the shared background service, which keeps the
// environment it was started with: a lane that let OpenCode use the service
// would silently get none of this. Seen in OpenCode 2.4.1: the plugin loads,
// the MCP server starts with the lane's environment, and the instructions
// file is in the system prompt.

/** An MCP server as OpenCode's config says one. */
export type OpenCodeServer =
  | {
      type: 'local'
      command: string[]
      environment?: Record<string, string>
      codemode?: boolean
    }
  | { type: 'remote'; url: string; headers?: Record<string, string>; codemode?: boolean }

export interface RunConfig {
  /** The folder Tade's plugin is in: OpenCode loads a local plugin only from a folder. */
  plugin: string
  /** Tade's own tool server. */
  tools: { command: string; args: string[] }
  /** MCP servers the run's extensions give it, in the standard's own files. */
  servers?: readonly string[]
  /** A file of instructions appended to OpenCode's own. */
  instructions?: string | null
  /** Folders of skills to find beside OpenCode's own. */
  skills?: readonly string[]
  /** Whether Tade gates its tool calls. */
  gated: boolean
  onWarning?: (message: string) => void
}

/**
 * The config for one run.
 *
 * Tade's tool server is listed outside Code Mode (`codemode: false`), so its
 * tools are tools the model can see and call by name rather than functions
 * inside OpenCode's `execute`. Under approvals every action asks
 * (`permissions`): Tade's plugin answers each one for Tade, so the person is
 * never asked twice — and if the plugin could not load, OpenCode asks in its
 * own terminal rather than running anything unasked, which is the gate failing
 * closed. Without approvals nothing is said about permissions here, and the
 * lane's `--auto` approves whatever a rule does not deny.
 */
export function configFor(run: RunConfig): Record<string, unknown> {
  const servers: Record<string, OpenCodeServer> = {}
  for (const file of run.servers ?? []) {
    for (const [name, server] of Object.entries(serversIn(file, run.onWarning))) {
      // Tade's own is named `tade`, and a server of an extension's never
      // takes its place.
      if (name !== 'tade') servers[name] = server
    }
  }
  servers.tade = {
    type: 'local',
    command: [run.tools.command, ...run.tools.args],
    codemode: false,
  }
  return {
    plugins: [run.plugin],
    mcp: { servers },
    ...(run.instructions ? { instructions: [run.instructions] } : {}),
    ...(run.skills && run.skills.length > 0 ? { skills: [...run.skills] } : {}),
    ...(run.gated ? { permissions: [{ action: '*', resource: '*', effect: 'ask' }] } : {}),
  }
}

/**
 * The MCP servers in one of the standard's files (`{ "mcpServers": { … } }`),
 * as OpenCode takes them: a command and its arguments as one list, its
 * environment by that name, and a URL as a remote server.
 */
export function serversIn(
  file: string,
  warn: (message: string) => void = () => {},
): Record<string, OpenCodeServer> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    warn(`could not read the MCP servers in ${file} for OpenCode: ${(err as Error).message}`)
    return {}
  }
  const said = (parsed as { mcpServers?: unknown } | null)?.mcpServers
  if (typeof said !== 'object' || said === null) return {}
  const out: Record<string, OpenCodeServer> = {}
  for (const [name, raw] of Object.entries(said as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const one = raw as Record<string, unknown>
    const strings = (value: unknown) =>
      typeof value === 'object' && value !== null
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {}
    if (typeof one.command === 'string') {
      const environment = strings(one.env)
      out[name] = {
        type: 'local',
        command: [one.command, ...(Array.isArray(one.args) ? one.args.map(String) : [])],
        ...(Object.keys(environment).length > 0 ? { environment } : {}),
      }
    } else if (typeof one.url === 'string') {
      const headers = strings(one.headers)
      out[name] = {
        type: 'remote',
        url: one.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      }
    } else {
      warn(`the MCP server ${name} in ${file} is said in a shape OpenCode has no place for`)
    }
  }
  return out
}

/** A model as OpenCode's session takes one: `provider/model`, with `#variant` where one is said. */
export function modelRef(
  said: string,
): { providerID: string; id: string; variant?: string } | null {
  const [name, variant] = said.split('#', 2)
  const at = name?.indexOf('/') ?? -1
  if (!name || at <= 0 || at === name.length - 1) return null
  return {
    providerID: name.slice(0, at),
    id: name.slice(at + 1),
    ...(variant ? { variant } : {}),
  }
}

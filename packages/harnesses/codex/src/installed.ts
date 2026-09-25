import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// What Codex loads by itself: the MCP servers in `~/.codex/config.toml`,
// which is the user's file and is never written by Tade.
//
// Read, never adopted — the same rule as Claude Code's own: the window says
// they are there so nobody takes an agent's tools for Tade's, and that is the
// whole of it.
//
// A TOML file read for one thing: the table headers under `mcp_servers`. A
// line nothing here recognises is left out, which is what a file that grew a
// new shape looks like.

export interface HarnessPiece {
  name: string
  where: string
}

/** The names of the tables under `[mcp_servers.<name>]`, in the order they appear. */
export function serversIn(toml: string): string[] {
  const out: string[] = []
  for (const line of toml.split(/\r?\n/)) {
    const said = line.trim()
    // `[mcp_servers.linear]` and `[mcp_servers.linear.env]` name the same
    // server; the first segment after the prefix is the name.
    const head = /^\[+mcp_servers\.([^\].]+)/.exec(said)
    const name = head?.[1]?.trim().replace(/^["']|["']$/g, '')
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/** The MCP servers Codex loads by itself. Never throws: no file is none. */
export function installedServers(home = homedir()): HarnessPiece[] {
  try {
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    return serversIn(toml).map((name) => ({ name, where: '~/.codex/config.toml (Codex)' }))
  } catch {
    return []
  }
}

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProgram } from '@tade/core'

// What Claude Code loads by itself, whoever runs it: the MCP servers a person
// added with `claude mcp add`, and the ones a project ships in its own
// `.mcp.json`. Tade does not run these — Claude Code does, in every agent it
// starts — but they change what an agent can do, so the window lists them
// beside Tade's own.
//
// **Reading what a harness loads is not adopting it.** Their tools are not
// Tade's, are not named by Tade, are not in Tade's tool list and are not
// counted as Tade's; nothing here turns one on, off or configures it. This is
// `readFromCi` again, for the same reason: a list somebody can see beats a
// surprise, and adopting is a separate act nobody has asked for.
//
// The files are somebody else's and may change shape; anything unfamiliar is
// left out rather than guessed at. So is what the binary itself takes on its
// command line (`optionsOf`), asked of it rather than assumed from a version.

export interface HarnessPiece {
  name: string
  /** Where it comes from, as you would look for it. */
  where: string
}

/** The names under `mcpServers` in a file of that shape, or none. Never throws. */
function servers(path: string): string[] {
  try {
    const read = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown }
    const said = read?.mcpServers
    if (!said || typeof said !== 'object' || Array.isArray(said)) return []
    return Object.keys(said as Record<string, unknown>)
  } catch {
    // No file, or not one we can read: nothing to list, and nothing wrong.
    return []
  }
}

/** The MCP servers Claude Code loads by itself: yours, and the project's own. */
export function installedServers(home = homedir(), project?: string): HarnessPiece[] {
  const out: HarnessPiece[] = []
  for (const name of servers(join(home, '.claude.json'))) {
    out.push({ name, where: '~/.claude.json (Claude Code)' })
  }
  if (project) {
    for (const name of servers(join(project, '.mcp.json'))) {
      out.push({ name, where: `${project}/.mcp.json (Claude Code)` })
    }
  }
  return out
}

/**
 * Every long option the installed Claude Code lists in `--help`, or null when
 * it could not be asked — which is not the same as it offering none.
 *
 * Asked rather than worked out from a version, because a flag is a promise of
 * the binary that is actually here: Claude Code refuses an option it does not
 * know and exits before it reads a word, so a flag passed to an older one is a
 * launch that never happens. Only an option where commander puts one counts,
 * two spaces in: one named inside another's description, forty spaces in on
 * a line of its own, is not one it takes.
 */
export async function optionsOf(bin: string, env: NodeJS.ProcessEnv): Promise<Set<string> | null> {
  const said = await runProgram(bin, ['--help'], { timeoutMs: 10_000, env })
  if (said.code !== 0) return null
  const options = new Set<string>()
  for (const line of said.stdout.split('\n')) {
    const option = /^ {2}(?:-\w, )?(--[a-z][\w-]*)/.exec(line)?.[1]
    if (option) options.add(option)
  }
  return options
}

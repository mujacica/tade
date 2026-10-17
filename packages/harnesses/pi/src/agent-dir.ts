import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * pi's agent directory: where it keeps what is yours rather than a project's —
 * its sign-ins, its model catalog, its settings, extensions and skills, and its
 * sessions. It is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` moves it (pi's
 * `getAgentDir`, a leading `~` expanded). `env` is the environment pi is
 * launched with, since that is the one it reads; a relative value is pi's from
 * its own working directory. A test holds this to pi's own.
 */
export function agentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const moved = env.PI_CODING_AGENT_DIR
  return moved ? homeExpanded(moved, home) : join(home, '.pi', 'agent')
}

/** A path as pi reads one it is told: a leading `~` is the home (pi's `normalizePath`). */
export function homeExpanded(path: string, home = homedir()): string {
  return path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : path
}

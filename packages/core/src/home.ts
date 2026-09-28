import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Where Tade's own files are, which is a different question from what is in
// them. Four answers, and nothing here reads or writes anything: they are the
// paths the rest of the house joins onto, and `TADE_HOME` is the one override,
// so a test can point the whole of Tade at a temp directory by setting it.

/**
 * Where sockets for this home go.
 *
 * Not in the home itself: a Unix socket path is capped near 104 bytes, and a
 * home under a temp directory or a deep checkout blows that — which shows up as
 * an agent that will not start, for a reason no user could act on. These are
 * runtime files with no value after a restart, so somewhere short and
 * disposable is also the honest place for them.
 */
export function runtimeDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR || tmpdir()
  return join(base, `tade-${createHash('sha1').update(home).digest('hex').slice(0, 8)}`)
}

/** Root of Tade's per-user state. `TADE_HOME` overrides for tests. */
export function tadeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TADE_HOME ?? join(homedir(), '.tade')
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(tadeHome(env), 'config.yaml')
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

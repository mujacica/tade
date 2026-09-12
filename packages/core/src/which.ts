import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * Resolve a command the way exec would, so a missing binary is discovered
 * before anything is started. Both drivers need this for the same reason: a
 * backend that reports a failed launch asynchronously would otherwise leave a
 * phantom lane behind.
 */
export function resolveCommand(command: string, env: Record<string, string>): string | null {
  const executable = (p: string) => {
    try {
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (command.includes('/')) {
    const abs = isAbsolute(command) ? command : join(process.cwd(), command)
    return executable(abs) ? abs : null
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, command)
    if (executable(candidate)) return candidate
  }
  return null
}

/** Environment as exec wants it: test runners inject non-string values. */
export function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v
  return out
}

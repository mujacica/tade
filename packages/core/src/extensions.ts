import { join } from 'node:path'

// Tools Tade wrote for itself.
//
// Self-extension is the point, but a half-broken tool loaded into a running
// orchestrator is an evening lost, so the rails are: everything lives in one
// directory and nothing there runs until somebody turns it on; turning one on
// takes effect the next time Tade starts, never as a hot reload; and `--safe`
// boots with none of them, which is the way back when one of them is what
// broke.
//
// Pure: a listing in, the files that load out.

/**
 * Which of a directory's files are extensions, in a stable order.
 *
 * Sorted because load order decides which tool wins a name clash, and a load
 * order that depends on what the filesystem feels like returning is a bug that
 * only shows up on someone else's machine.
 */
export function loadable(files: readonly string[]): string[] {
  return (
    files
      .filter((name) => /\.(ts|js|mjs)$/.test(name))
      // Editor leftovers and partial writes: `.foo.ts.swp` is not a tool.
      .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
      .sort((a, b) => a.localeCompare(b))
  )
}

/** A name that is safe to write to disk and to read in a review. */
export function isExtensionName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
}

/**
 * The file a tool Tade writes for itself goes in, or null when the name is
 * unusable. Beside every other extension: there is one place they live, and
 * being there is not being on.
 */
export function extensionPath(root: string, name: string): string | null {
  return isExtensionName(name) ? join(root, `${name}.ts`) : null
}

/**
 * Whether an extension may load at all.
 *
 * Tade's own ship with it and are on unless turned off. Yours — anything in
 * the extensions directory, whoever wrote it — are off until somebody says
 * otherwise, so a tool Tade wrote for itself is listed, readable and inert
 * until a human turns it on. That is the rail that used to be a directory
 * nobody loaded from.
 */
export function extensionEnabled(
  settings: Readonly<Record<string, unknown>> | undefined,
  source: 'built-in' | 'yours',
): boolean {
  const said = settings?.enabled
  return source === 'built-in' ? said !== false : said === true
}

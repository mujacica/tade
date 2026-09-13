import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { extensionDirs, loadable } from '@wilco/core'

// Finding the tools Wilco wrote for itself. The rules about which files count
// are in core and tested there; this is the part that touches the disk.

/**
 * Absolute paths of the extensions that should load, in a stable order.
 * Never throws: no extensions directory is the normal case, not an error.
 */
export function activeExtensions(root: string): string[] {
  const dirs = extensionDirs(root)
  try {
    return loadable(readdirSync(dirs.active)).map((name) => join(dirs.active, name))
  } catch {
    return []
  }
}

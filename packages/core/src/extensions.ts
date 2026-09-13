import { join } from 'node:path'

// Tools Wilco wrote for itself.
//
// Self-extension is the point, but a half-broken tool loaded into a running
// orchestrator is an evening lost, so the rails are: written extensions land
// in `proposed/` and do nothing until a human moves them; activating one needs
// a daemon restart, never a hot reload; and `--safe` boots with none of them,
// which is the way back when one of them is what broke.
//
// Pure: a listing in, the files that load out.

export interface ExtensionDirs {
  root: string
  /** Loaded at startup. */
  active: string
  /** Written by the orchestrator, inert until moved. */
  proposed: string
  /** Turned down. Kept, so the same idea is not proposed twice. */
  rejected: string
}

export function extensionDirs(root: string): ExtensionDirs {
  return {
    root,
    active: join(root, 'active'),
    proposed: join(root, 'proposed'),
    rejected: join(root, 'rejected'),
  }
}

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

/** The file a proposal is written to, or null when the name is unusable. */
export function proposalPath(dirs: ExtensionDirs, name: string): string | null {
  return isExtensionName(name) ? join(dirs.proposed, `${name}.ts`) : null
}

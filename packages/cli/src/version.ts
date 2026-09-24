import { readFileSync } from 'node:fs'

// What the manifest says about this copy of Tade: which version it is, and
// which Node it was written for. Both out of the same file and the same read,
// so the sentence at the door quotes the number npm warned about rather than a
// second one somebody has to remember to move.

interface Manifest {
  version?: string
  engines?: { node?: string }
}

/**
 * The root manifest, which is not this package's own.
 *
 * The same three levels up in both layouts: in a checkout that is the
 * workspace root, and in the published package it is `tade-sh`'s own manifest,
 * because the tarball keeps the `packages/cli/src` shape it has here.
 */
function manifest(): Manifest {
  return JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as Manifest
}

/** The version in `package.json`, which is what an issue says it happened in. */
export function version(): string {
  return manifest().version ?? '0.0.0'
}

/**
 * `>=22.19`, as `engines` declares it, or null where nothing does.
 *
 * A manifest that will not open is null too, and deliberately: this is read at
 * the door, before anything else is loaded, and what it decides is whether to
 * stop somebody. A file nobody can read is not a reason to refuse to start —
 * it is `version()`'s business, where it is still a throw.
 */
export function needsNode(): string | null {
  try {
    return manifest().engines?.node ?? null
  } catch {
    return null
  }
}

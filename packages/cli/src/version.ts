import { readFileSync } from 'node:fs'

/**
 * The version in `package.json`, which is what an issue says it happened in.
 *
 * The root manifest and not this package's own, and the same three levels up
 * in both places it is ever read from: in a checkout that is the workspace
 * root, and in the published package it is `tade-sh`'s own manifest, because
 * the tarball keeps the `packages/cli/src` shape it has here.
 */
export function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { version?: string }
  return pkg.version ?? '0.0.0'
}

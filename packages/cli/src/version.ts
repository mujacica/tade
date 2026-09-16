import { readFileSync } from 'node:fs'

/** The version in `package.json`, which is what an issue says it happened in. */
export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version?: string
  }
  return pkg.version ?? '0.0.0'
}

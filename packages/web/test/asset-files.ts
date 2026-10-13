import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every file under the assets folder, as the path it is served at
 * (`pages/checks.js`), walked the way `readAssets` walks it.
 *
 * One walk for every test that reads the folder, because a test that listed
 * only the top level stopped seeing a page the day the pages moved into
 * `pages/` — and a check that silently reads fewer files is one that passes.
 */
export function assetFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const at = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...assetFiles(dir, at))
    else out.push(at)
  }
  return out.sort()
}

/** Every module in the folder, by served path. */
export function scripts(dir: string): string[] {
  return assetFiles(dir).filter((name) => name.endsWith('.js'))
}

/** Every stylesheet in the folder, by served path. */
export function sheets(dir: string): string[] {
  return assetFiles(dir).filter((name) => name.endsWith('.css'))
}

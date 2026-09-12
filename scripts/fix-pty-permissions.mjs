// node-pty ships a prebuilt `spawn-helper` binary, and package extraction can
// drop its executable bit. Without it every PTY spawn fails with the
// singularly unhelpful "posix_spawnp failed". Restore it after install.
import { chmodSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function* find(dir, name, depth = 6) {
  if (depth === 0) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* find(full, name, depth - 1)
    else if (entry.name === name) yield full
  }
}

let fixed = 0
for (const base of [join(root, 'node_modules', '.pnpm'), join(root, 'node_modules')]) {
  for (const helper of find(base, 'spawn-helper')) {
    try {
      const mode = statSync(helper).mode
      if ((mode & 0o111) === 0) {
        chmodSync(helper, 0o755)
        fixed++
      }
    } catch {
      // best effort: never fail an install over this
    }
  }
}
if (fixed > 0) console.log(`fixed executable bit on ${fixed} spawn-helper binary(ies)`)

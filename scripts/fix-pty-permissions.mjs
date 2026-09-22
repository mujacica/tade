// node-pty ships a prebuilt `spawn-helper` binary, and package extraction can
// drop its executable bit. Without it every PTY spawn fails with the
// singularly unhelpful "posix_spawnp failed". Restore it after install.
//
// Run from two homes, so it looks in both. In this repository that is
// `node_modules/.pnpm/node-pty@…`, one level down from the root. In the
// published package it is wherever the person's package manager put node-pty
// — beside `tade-sh` under a global prefix, or nested inside it — so the walk
// goes up from here, which finds either.
//
// It fixes only node-pty's own folders: `node_modules` under a global prefix
// holds everything anybody ever installed, and a recursive hunt through that
// for a file name is a hunt nobody asked for.
import { chmodSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function* find(dir, name, depth = 4) {
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

/** Every folder node-pty could be in, reachable from here. */
function* homes() {
  let dir = root
  for (let up = 0; up < 8; up++) {
    const modules = join(dir, 'node_modules')
    yield join(modules, 'node-pty')
    // pnpm keeps the real package under a versioned folder and links to it.
    const store = join(modules, '.pnpm')
    let entries = []
    try {
      entries = readdirSync(store)
    } catch {
      // No pnpm store here, which is the ordinary case.
    }
    for (const entry of entries) {
      if (entry.startsWith('node-pty@')) yield join(store, entry, 'node_modules', 'node-pty')
    }
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
}

let fixed = 0
for (const home of homes()) {
  for (const helper of find(home, 'spawn-helper')) {
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

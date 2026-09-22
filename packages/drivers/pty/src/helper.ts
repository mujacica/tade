import { accessSync, constants, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Why a lane can fail with `posix_spawnp failed.` and nothing else.
//
// node-pty execs every lane through a small program of its own, `spawn-helper`,
// which it ships prebuilt in its npm tarball for macOS and Windows. A tarball
// carries no executable bit, so node-pty's own install script is what puts it
// back — and a package manager that holds a dependency's install scripts until
// somebody approves them (pnpm 10 by default, npm 11 with `allowScripts`)
// leaves the file sitting there unrunnable. `pty.fork` then fails in the
// native layer with five words that name neither the file nor the reason, and
// Tade looks broken rather than un-approved.
//
// Nothing here fixes it: chmod-ing a file inside somebody's `node_modules` at
// run time is a surprise, and the two commands that fix it properly are the
// ones they will want next time as well. What this does is say which file,
// and what to type.

/**
 * The helper node-pty would exec through, or null where it uses none.
 *
 * Looked for the way node-pty looks for it — a build first, then the prebuild
 * for this platform — because a copy in the other place is not the copy that
 * will be run. Windows spawns through ConPTY and has no helper at all.
 */
export function helperAt(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === 'win32') return null
  let lib: string
  try {
    lib = createRequire(import.meta.url).resolve('node-pty')
  } catch {
    // Not installed at all is a different sentence, said by whoever imported it.
    return null
  }
  const root = dirname(dirname(lib))
  for (const dir of ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]) {
    const helper = join(root, dir, 'spawn-helper')
    if (existsSync(helper)) return helper
  }
  return null
}

/** What is wrong with it, in words somebody can act on, or null when nothing is. */
export function helperProblem(helper: string | null): string | null {
  if (helper === null) return null
  try {
    accessSync(helper, constants.X_OK)
    return null
  } catch {
    return (
      `node-pty's spawn-helper is not executable, so every terminal Tade opens fails with\n` +
      '"posix_spawnp failed." and nothing else. It comes out of the npm tarball without the\n' +
      'bit, and the install script that puts it back was held — pnpm 10 and npm 11 do not run\n' +
      "a dependency's install scripts until you approve them.\n" +
      '\n' +
      `  chmod +x ${helper}\n` +
      '\n' +
      'or approve the install script, which also fixes it for the next update:\n' +
      '\n' +
      '  pnpm   pnpm approve-builds -g\n' +
      '  npm    npm install -g --allow-scripts=tade-sh,node-pty tade-sh\n'
    )
  }
}

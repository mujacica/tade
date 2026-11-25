import { accessSync, constants, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { npxKeyOf } from '@tade/core'

// Why a lane can fail with `posix_spawnp failed.` and nothing else.
//
// node-pty execs every lane on macOS through a small program of its own,
// `spawn-helper`. Tade's node-pty is `@lydell/node-pty`: microsoft/node-pty's
// own prebuilds, one package per platform, with the helper packed executable
// and no install script — so npm 12, pnpm and bun, which hold a dependency's
// scripts until somebody approves them, have nothing to hold. (It used to
// be microsoft/node-pty, whose tarball carries the helper without the bit and
// whose install script puts it back; a held script was the usual way here.)
//
// What is left is a copy that lost the bit after the install: a `node_modules`
// copied, synced or unpacked by something that keeps no file modes. `pty.fork`
// then fails in the native layer with five words that name neither the file
// nor the reason, and Tade looks broken.
//
// Nothing here fixes it: chmod-ing a file inside somebody's `node_modules` at
// run time is a surprise. What this does is say which file, and what to type.

/** The node-pty Tade runs: microsoft/node-pty's prebuilds, one package per platform. */
const PTY = '@lydell/node-pty'

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
    // `@lydell/node-pty` is a wrapper whose binary is in a package of its own
    // per platform, an optional dependency of the wrapper's — so it is found
    // from the wrapper, which is the only one that depends on it.
    const wrapper = createRequire(import.meta.url).resolve(PTY)
    lib = createRequire(wrapper).resolve(`${PTY}-${platform}-${arch}`)
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
    // Run out of npx's cache, the install is that cache entry, and `npx` puts
    // back only one it no longer has: the same version is answered from it.
    // A global command there would be a second copy nothing runs.
    const key = npxKeyOf(helper)
    const again =
      key !== null
        ? [`  npx    npm cache npx rm ${key} && npx tade-sh`]
        : [
            '  npm    npm install -g tade-sh',
            '  pnpm   pnpm add -g tade-sh',
            '  bun    bun add -g tade-sh',
          ]
    return [
      "node-pty's spawn-helper is not executable, so every terminal Tade opens fails with",
      '"posix_spawnp failed." and nothing else. It is installed executable and needs no',
      'install script, so this copy lost the bit afterwards — copied, synced or unpacked by',
      'something that keeps no file modes.',
      '',
      `  chmod +x ${helper}`,
      '',
      'or install Tade again, which puts it back:',
      '',
      ...again,
      '',
    ].join('\n')
  }
}

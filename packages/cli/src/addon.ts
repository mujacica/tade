import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// What to say when node-pty was compiled for a Node that is not this one.
//
// node-pty has no Linux prebuild, so every Linux install compiles it, against
// the headers of whichever Node the install ran under. Debian and Ubuntu's
// Node is built shared — its runtime is `libnode.so.127` — and their node-gyp
// links an addon to that library. Run the same install under an official,
// static Node of the same ABI and the addon still loads: it pulls a second
// copy of Node into the process, nothing throws, the command does its work,
// and then the process aborts on the way out. Exit 134 and a core dump after
// every command, `--version` included, with nothing to catch and nothing said.
//
// So it is looked for at the door, before the addon is loaded, because after
// that there is no catching it. The test is the one that decides the crash:
// an addon that names `libnode.so`, loaded by a Node that is not shared. The
// other way round — an addon built by a static Node, loaded by Ubuntu's — is
// fine, and an ABI that differs is a NODE_MODULE_VERSION throw `nativeTrouble`
// already answers.
//
// It may only ever stop somebody, so nothing there to read is null: no
// node-pty to find, no binary. A file that is there and will not open throws.

/** Where node-pty looks for its binary, in its own order (`lib/utils.js`). */
function candidates(root: string): string[] {
  return ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`].map(
    (dir) => join(root, dir, 'pty.node'),
  )
}

/** Whether a compiled addon asks the dynamic linker for a shared Node runtime. */
export function linksLibnode(binary: Uint8Array): boolean {
  return Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength).includes('libnode.so')
}

export interface Addon {
  /** The binary node-pty will load. */
  path: string
  bytes: Uint8Array
  /** node-pty's own directory, where its install script runs. */
  root: string
}

/**
 * What to tell somebody whose node-pty would take this Node down on exit, or
 * null. `shared` is whether this Node's runtime is itself `libnode`, and `npm`
 * the npm that came with it — its node-gyp builds against this Node's headers,
 * where Debian's builds against the system's whatever Node runs it.
 */
export function builtForAnotherNode(
  addon: Addon | null,
  shared: boolean,
  node: string,
  npm: string,
): string | null {
  if (addon === null || shared || !linksLibnode(addon.bytes)) return null
  return `${[
    'Tade cannot start: node-pty was compiled for another Node.',
    '',
    `  ${addon.path}`,
    '',
    `It needs libnode, a system Node's shared runtime, and this Node is ${node},`,
    'which is not one. Loading it would work and then abort every command on exit,',
    'with a core dump. That happens when Node is swapped under an installed Tade.',
    '',
    'Rebuild it with the npm that came with this Node:',
    '',
    `  cd ${addon.root} && ${npm} run install`,
  ].join('\n')}\n`
}

/** node-pty's binary as this copy of Tade would load it, or null where there is none. */
export function ptyAddon(): Addon | null {
  try {
    // From the pty driver, which is what depends on it, in both layouts: the
    // published package keeps the `packages/` shape and hoists node-pty above it.
    const from = createRequire(new URL('../../drivers/pty/src/index.ts', import.meta.url))
    const root = dirname(dirname(from.resolve('node-pty')))
    const path = candidates(root).find((one) => existsSync(one))
    if (path === undefined) return null
    return { path, bytes: readFileSync(path), root }
  } catch (error) {
    // No node-pty to find, or a binary gone between looking and reading, is
    // nothing to check. Anything else is a real failure and is said as one.
    if (isMissing(error)) return null
    throw error
  }
}

/** The npm beside this Node, or plain `npm` where none is. */
export function npmBeside(execPath: string): string {
  try {
    const npm = join(dirname(realpathSync(execPath)), 'npm')
    return existsSync(npm) ? npm : 'npm'
  } catch (error) {
    if (isMissing(error)) return 'npm'
    throw error
  }
}

function isMissing(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  return code === 'MODULE_NOT_FOUND' || code === 'ENOENT'
}

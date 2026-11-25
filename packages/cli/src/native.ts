import { fileURLToPath } from 'node:url'

// What to say when Tade will not even start, because something it is built on
// did not load.
//
// Two of Tade's dependencies are native — node-pty (`@lydell/node-pty`), which
// is every terminal it opens, and better-sqlite3, which is the index over the
// journal — and a native module is the one thing an install can get
// half-right: the JavaScript arrives and the binary does not. `npm i -g
// tade-sh` then ends at a stack trace out of `node:internal/modules`, which
// names a file nobody has and says nothing about what to do.
//
// Both arrive ready-built and neither has an install script, so nothing is
// compiled and nothing a package manager holds (npm 12, pnpm and bun all hold
// a dependency's scripts) is the reason. What is left is a machine nobody
// built one for, or an install that left this machine's binary out. So the
// entry point catches it once and says which module, what the machine said,
// which machines are built for, and how to install again.
//
// Only a *package* that did not load is answered here. A relative file that is
// missing is Tade's own bug, and dressing that up as somebody's install
// problem would send them off to fix a machine that is fine.
//
// This file imports nothing of Tade's, because it runs once something did not
// load: which is why the npx cache key is read here rather than asked of core.

/** Whose absence is a machine that could not build them, rather than a bad install. */
const NATIVE = ['@lydell/node-pty', 'node-pty', 'better-sqlite3']

/**
 * Which module this is about.
 *
 * A known native one named anywhere in the message wins, because those
 * messages are not all shaped alike: `ERR_DLOPEN_FAILED` says
 * `dlopen(…/node-pty/prebuilds/…)` with nothing quoted in it at all, and a
 * quoted path would be read as the name. Otherwise it is whatever was quoted,
 * as long as that is a package and not a file of Tade's own.
 */
function named(message: string): string | null {
  const known = NATIVE.find((one) => message.includes(one))
  if (known !== undefined) return known
  // node-pty's own loader names its binary and not its package.
  if (message.includes('pty.node')) return NATIVE[0] ?? null
  const quoted = /['"]([^'"]+)['"]/.exec(message)?.[1]
  if (quoted === undefined || quoted.startsWith('.') || quoted.startsWith('/')) return null
  return quoted.startsWith('node:') ? null : quoted
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * What to tell somebody about this failure, or null when it is not one of
 * these and the original error is the better answer.
 *
 * `from` is where this Tade is running from, which says whether it came out
 * of npx's cache and so how it is installed again.
 */
export function nativeTrouble(
  error: unknown,
  from: string = fileURLToPath(import.meta.url),
): string | null {
  const code = codeOf(error)
  const message = messageOf(error)
  const first = message.split('\n')[0] ?? message
  // Whether this is a native module is decided by how it failed, never by
  // whether the name could be picked out: a binary that would not load is a
  // binary that would not load even where the message names no package.
  // `@lydell/node-pty` throws its own plain Error, with no code, when this
  // platform's package is not there: that is the same failure in its words.
  if (
    code === 'ERR_DLOPEN_FAILED' ||
    message.includes('NODE_MODULE_VERSION') ||
    message.includes('Failed to load native module') ||
    message.startsWith('The @lydell/node-pty package')
  )
    return advice(named(message) ?? 'a native module', first, true, from)
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    const module = named(message)
    return module === null ? null : advice(module, first, NATIVE.includes(module), from)
  }
  return null
}

/** The npx cache entry `from` is in (`~/.npm/_npx/<key>/`), as core's `npxKeyOf` reads it. */
function npxKey(from: string): string | null {
  return /[/\\]_npx[/\\]([^/\\]+)[/\\]/.exec(from)?.[1] ?? null
}

function advice(module: string, said: string, native: boolean, from: string): string {
  const lines = [`Tade could not load ${module}.`, '', `  ${said}`, '']
  const key = npxKey(from)
  // Run with npx, the cache entry is the install, and the same version is
  // answered from it until it is forgotten.
  const again =
    key !== null
      ? [`  npx    npm cache npx rm ${key} && npx tade-sh`]
      : [
          '  npm    npm install -g tade-sh',
          '  pnpm   pnpm add -g tade-sh',
          '  bun    bun add -g tade-sh',
        ]
  if (native)
    lines.push(
      'That is a native module, and it comes ready-built: nothing is compiled when Tade is',
      'installed. Built for macOS and for Linux with glibc 2.28 or newer, on x64 and arm64 —',
      "not Alpine's musl, and not Windows. On one of those, the install left this machine's",
      'binary out: it is an optional dependency, so --omit=optional drops it, and a',
      'node_modules copied from another machine or into a container has the wrong one.',
      '',
      'Install Tade again, here, with optional dependencies:',
      '',
      ...again,
    )
  else
    lines.push(
      'It is a dependency of Tade, so this is an install that did not finish rather than',
      'anything you have done. Installing Tade again is the fix:',
      '',
      ...again,
    )
  return `${lines.join('\n')}\n`
}

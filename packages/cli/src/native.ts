// What to say when Tade will not even start, because something it is built on
// did not load.
//
// Two of Tade's dependencies are native — node-pty, which is every terminal it
// opens, and better-sqlite3, which is the index over the journal — and a
// native module is the one thing an install can get half-right: the JavaScript
// arrives and the binary does not. `npm i -g tade-sh` then ends at a stack
// trace out of `node:internal/modules`, which names a file nobody has and says
// nothing about what to do.
//
// So the entry point catches it once and says which module, what the machine
// said, and the commands that fix the two ways it happens: a toolchain that is
// not there, and install scripts a package manager held rather than ran.
//
// Only a *package* that did not load is answered here. A relative file that is
// missing is Tade's own bug, and dressing that up as somebody's install
// problem would send them off to fix a machine that is fine.

/** Whose absence is a machine that could not build them, rather than a bad install. */
const NATIVE = ['node-pty', 'better-sqlite3']

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
 */
export function nativeTrouble(error: unknown): string | null {
  const code = codeOf(error)
  const message = messageOf(error)
  const first = message.split('\n')[0] ?? message
  // Whether this is a native module is decided by how it failed, never by
  // whether the name could be picked out: a binary that would not load is a
  // binary that would not load even where the message names no package.
  if (
    code === 'ERR_DLOPEN_FAILED' ||
    message.includes('NODE_MODULE_VERSION') ||
    message.includes('Failed to load native module')
  )
    return advice(named(message) ?? 'a native module', first, true)
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    const module = named(message)
    return module === null ? null : advice(module, first, NATIVE.includes(module))
  }
  return null
}

function advice(module: string, said: string, native: boolean): string {
  const lines = [`Tade could not load ${module}.`, '', `  ${said}`, '']
  if (native)
    lines.push(
      'That is a native module: a binary your package manager either downloaded ready-built',
      'or compiled when Tade was installed. Neither happened here.',
      '',
      'If the install scripts were held rather than run — which pnpm, npm 11 and bun all do',
      'by default — approve them and install again:',
      '',
      '  pnpm   pnpm approve-builds -g',
      '  npm    npm install -g --allow-scripts=tade-sh,node-pty,better-sqlite3 tade-sh',
      '  bun    bun pm -g trust --all',
      '',
      'If it was built and the build failed, the machine needs a C++ toolchain and python3:',
      '',
      '  macOS           xcode-select --install',
      '  Debian/Ubuntu   sudo apt-get install -y build-essential python3',
      '  Fedora          sudo dnf install -y gcc-c++ make python3',
    )
  else
    lines.push(
      'It is a dependency of Tade, so this is an install that did not finish rather than',
      'anything you have done. Installing Tade again is the fix:',
      '',
      '  npm install -g tade-sh',
    )
  return `${lines.join('\n')}\n`
}

// What a Linux machine needs before node-pty is compiled on it, said before
// node-gyp says it.
//
// node-pty ships prebuilt binaries for `darwin-arm64`, `darwin-x64`,
// `win32-arm64` and `win32-x64` — and for no Linux at all. So on Linux it is
// always compiled, and on a machine with no toolchain `npm i -g tade-sh` ends
// in forty lines of node-gyp whose last words are a Python that is not Tade's
// and a working directory nobody chose. (better-sqlite3 ships its own
// prebuilds everywhere and is not why this is here.)
//
// This is the package's `preinstall`, which npm runs before it builds that
// package's dependencies — checked, in a container, in both directions: the
// marker printed before node-pty's `install` on a machine that could build,
// and the install stopped here on one that could not. Exiting non-zero is what
// makes this sentence the whole of the error rather than a line above the wall
// where nobody reads it, because npm shows a script's output only when the
// script fails.
//
// It may only ever refuse where node-gyp would have failed anyway, so it looks
// for what node-gyp looks for and is generous about what counts: any of six
// compiler names, either Python, and the environment variables node-gyp reads
// before it looks at all. Being wrong the other way costs nothing — node-gyp
// then speaks, exactly as it did before this existed.
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/** What node-gyp will look for, and what answers for each without a search. */
const NEEDS = [
  { what: 'python3', named: ['PYTHON', 'npm_config_python'], programs: ['python3', 'python'] },
  {
    what: 'a C++ compiler — g++, or clang++',
    named: ['CXX'],
    programs: ['c++', 'g++', 'clang++', 'cc', 'gcc', 'clang'],
  },
  { what: 'make', named: ['MAKE', 'npm_config_ninja'], programs: ['make', 'gmake', 'ninja'] },
]

/**
 * Of the things compiling node-pty needs, what this machine has not got.
 *
 * Empty everywhere but Linux, because everywhere else there is a prebuild and
 * nothing is compiled at all. `here` answers whether a program can be run, so
 * the decision is a pure function of the platform, the environment and that.
 */
export function missingFor(platform, env, here) {
  if (platform !== 'linux') return []
  return NEEDS.filter(
    (need) =>
      !need.named.some((name) => (env[name] ?? '') !== '') &&
      !need.programs.some((one) => here(one)),
  ).map((need) => need.what)
}

/** Whether a program of this name is executable somewhere on PATH. */
export function onPath(env, name) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      return true
    } catch {
      // Not here, or not runnable: the next one, and no failure either way.
    }
  }
  return false
}

/** What to say about it, or null when there is nothing to say. */
export function trouble(missing) {
  if (missing.length === 0) return null
  return `${[
    'Tade cannot be installed here yet. node-pty is the terminal it opens for every agent,',
    'it ships no Linux prebuild, so it is compiled while Tade installs — and compiling it',
    'needs what this machine has not got:',
    '',
    ...missing.map((one) => `  ${one}`),
    '',
    '  Debian/Ubuntu   sudo apt-get install -y build-essential python3',
    '  Fedora          sudo dnf install -y gcc-c++ make python3',
    '  Alpine          apk add --no-cache build-base python3',
    '',
    'Then install Tade again. Nothing has been installed.',
  ].join('\n')}\n`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const said = trouble(missingFor(process.platform, process.env, (one) => onPath(process.env, one)))
  if (said !== null) {
    process.stderr.write(said)
    process.exit(1)
  }
}

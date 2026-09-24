import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { COMMAND, git, type Manifest, manifests, PUBLISHED, ROOT, rootManifest } from './repo.ts'

// The publish directory: the whole workspace, as one package called `tade-sh`.
//
//   pnpm stage --version 0.1.0
//
// Thirty-eight packages go out as one because that is what was decided, and
// one package means the `@tade/*` specifiers between them have to resolve on a
// machine that has never seen this repository. They do it by self-reference:
// the staged tree keeps the same `packages/<name>/src/…` shape, the root
// manifest declares an `exports` entry per package generated from that
// package's own, and `@tade/core` is rewritten to `tade-sh/core`. Nothing
// resolves through `node_modules`, so nothing depends on how a package manager
// chose to lay one out.
//
// The one thing that cannot survive the trip is the TypeScript. Node refuses
// to strip types from any file under a `node_modules` path — deliberately, to
// discourage exactly this — and `npm i -g tade-sh` puts the package under one,
// so a tarball of `.ts` files would be a tarball that cannot run. There is no
// flag for it and no way to ask nicely. So the types come off here, with
// Node's own `stripTypeScriptTypes` in `strip` mode: types are replaced by
// whitespace, which means every line of the published package is at the line
// it is at in this repository and a stack trace a user sends back is one you
// can read against the source. That is a publish step and not a build step —
// `pnpm tade` still runs the `.ts` on your machine, the repository still has
// no build, and nothing in it was rewritten to make this work.

const require = createRequire(import.meta.url)
const { stripTypeScriptTypes } = require('node:module') as {
  stripTypeScriptTypes: (source: string, options: { mode: 'strip' }) => string
}

export const DEFAULT_OUT = 'dist/package'

/**
 * What never ships.
 *
 * A conformance suite is the shared test every implementation of a port must
 * pass; it imports vitest, and vitest is the one dependency the workspace
 * declares that a user must never be made to install. `echo-child.js` is the
 * child process only that suite spawns.
 */
const NOT_SHIPPED = new Set(['conformance.ts', 'echo-child.js'])

/** Files taken from the root of the repository as they are. */
const AT_ROOT = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md']

/**
 * The scripts a user's install runs, which are the only ones that ship.
 *
 * Both are node-pty's: it is compiled where there is no prebuild for the
 * machine, which is every Linux, and its prebuilt `spawn-helper` can come out
 * of an extraction without its executable bit. `manifestFor` names them as
 * `preinstall` and `postinstall` in that order, which is the order npm runs
 * them in around the dependency build.
 */
const ON_INSTALL = ['check-build-tools.mjs', 'fix-pty-permissions.mjs']

export interface Staged {
  /** Absolute path of the staged directory. */
  out: string
  /** How many files are in it. */
  files: number
  dependencies: Record<string, string>
  /** Declared dependencies left out, each with why. */
  left: string[]
}

export function stage(opts: { out?: string; version: string }): Staged {
  const root = rootManifest()
  const out = resolve(ROOT, opts.out ?? DEFAULT_OUT)
  if (out === ROOT) throw new Error('refusing to stage over the repository itself')
  rmSync(out, { recursive: true, force: true })

  const packages = manifests()
  const shipped: string[] = []
  const held: string[] = []
  let files = 0
  for (const manifest of packages) {
    for (const path of tracked(manifest.dir)) {
      const name = posix.basename(path)
      const under = path.slice(manifest.dir.length + 1)
      if (!under.startsWith('src/') && !under.startsWith('skills/')) continue
      const text = path.endsWith('.ts') ? readFileSync(join(ROOT, path), 'utf8') : null
      if (NOT_SHIPPED.has(name)) {
        if (text !== null) held.push(...imported(text))
        continue
      }
      if (text === null) {
        put(join(out, path), null, join(ROOT, path))
      } else {
        const code = rewrite(stripTypeScriptTypes(text, { mode: 'strip' }))
        shipped.push(...imported(code))
        put(join(out, path.replace(/\.ts$/, '.js')), code, null)
      }
      files++
    }
  }

  const { dependencies, left } = depsFor(packages, new Set(shipped), new Set(held))
  const manifest = manifestFor(root, packages, dependencies, opts.version)
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  files++
  // The scripts an installed Tade runs, and the only ones: `install-hooks`
  // points git at this repository's own hooks, which is a contributor's
  // business and nobody else's. Both of these are about node-pty, which is the
  // one thing in the tarball that is a binary rather than a file.
  for (const name of ON_INSTALL) {
    put(join(out, `scripts/${name}`), null, join(ROOT, 'scripts', name))
    files++
  }
  for (const name of AT_ROOT) {
    if (!existsSync(join(ROOT, name))) continue
    put(join(out, name), null, join(ROOT, name))
    files++
  }

  check(out, manifest)
  return { out, files, dependencies, left }
}

/** Everything git has under this package, repo-relative and posix. */
function tracked(dir: string): string[] {
  return git(['ls-files', '-z', '--', dir])
    .split('\0')
    .filter((path) => path !== '')
}

function put(to: string, text: string | null, from: string | null): void {
  mkdirSync(dirname(to), { recursive: true })
  if (text === null && from !== null) copyFileSync(from, to)
  else writeFileSync(to, text ?? '')
}

/**
 * The specifiers, rewritten for a tree that is one package.
 *
 * Two rules and no others. A `@tade/…` specifier becomes a `tade-sh/…` one,
 * which the root manifest's `exports` answers by self-reference. A relative
 * path ending in `.ts` becomes the same path ending in `.js` — and that is not
 * only the imports: `new URL('./hook.ts', import.meta.url)` is how a harness is
 * told which file to run, and those are the files Claude Code, Codex and pi
 * are handed. A bare `'extension.ts'` is left alone on purpose: that one names
 * a file in somebody's own `~/.tade/extensions`, which is not in this tarball
 * and is not under `node_modules`, so Node strips its types the ordinary way.
 */
export function rewrite(code: string): string {
  return code.replace(
    /(['"])((?:\.{1,2}\/[^'"\n]*\.ts)|(?:@tade\/[^'"\n]*))\1/g,
    (_whole, quote: string, spec: string) => {
      const to = spec.startsWith('@tade/')
        ? `${PUBLISHED}/${spec.slice('@tade/'.length)}`
        : `${spec.slice(0, -'.ts'.length)}.js`
      return `${quote}${to}${quote}`
    },
  )
}

/**
 * Every package a file names, `@scope/name/deep` counted as `@scope/name`.
 *
 * Neither the keyword nor the shape is trusted on its own. `line('from',
 * where.base.replace(…))` reads to a regular expression as an import of `,
 * where.base.replace(`, and the AppleScript that asks the pasteboard what it
 * is holding contains a literal `ObjC.import("AppKit")` — so the keyword may
 * not follow a dot or a quote, and what it names has to be shaped like a
 * package. A release that stopped on either is a release nobody can cut.
 */
const PACKAGE = /^(@[a-z0-9~][\w.-]*\/)?[a-z0-9~][\w.-]*(\/[^'"\n]*)?$/i

const IMPORT = /(?<![.\w$'"`])(?:from|import|require)\s*\(?\s*(['"])([^'"\n]+)\1/g

function imported(code: string): string[] {
  const out: string[] = []
  for (const match of code.matchAll(IMPORT)) {
    const spec = match[2]
    if (spec === undefined) continue
    if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith(`${PUBLISHED}/`))
      continue
    if (!PACKAGE.test(spec)) continue
    const parts = spec.split('/')
    out.push(spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec))
  }
  return out
}

/**
 * What the published package depends on: everything the workspace declares,
 * minus what only the files that do not ship were importing.
 *
 * Conservative on purpose — a declared dependency nothing appears to import
 * may still be reached in a way no regular expression sees, and a missing
 * dependency is a package that does not run. The only thing it drops is what
 * left with the conformance suites, which today is vitest.
 */
function depsFor(
  packages: readonly Manifest[],
  shipped: ReadonlySet<string>,
  held: ReadonlySet<string>,
): { dependencies: Record<string, string>; left: string[] } {
  const ranges = new Map<string, Map<string, string[]>>()
  for (const manifest of packages) {
    for (const [name, range] of Object.entries(manifest.dependencies)) {
      if (name.startsWith('@tade/')) continue
      const seen = ranges.get(name) ?? new Map<string, string[]>()
      seen.set(range, [...(seen.get(range) ?? []), manifest.name])
      ranges.set(name, seen)
    }
  }
  const dependencies: Record<string, string> = {}
  const left: string[] = []
  for (const name of [...ranges.keys()].sort()) {
    const seen = ranges.get(name) ?? new Map<string, string[]>()
    if (seen.size > 1) {
      const said = [...seen].map(([range, who]) => `${range} (${who.join(', ')})`).join(' and ')
      throw new Error(
        `${name} is declared as ${said}.\n` +
          'One published package can only have one range. Make the workspace agree first.',
      )
    }
    const range = [...seen.keys()][0] ?? '*'
    if (!shipped.has(name) && held.has(name)) {
      left.push(`${name} — only the conformance suites import it, and those do not ship`)
      continue
    }
    dependencies[name] = range
  }
  for (const name of [...shipped].sort()) {
    if (dependencies[name] === undefined)
      throw new Error(
        `${name} is imported by a file that ships and no package in the workspace depends on it.\n` +
          'Add it to that package’s dependencies: a published package that reaches for\n' +
          'something nobody installed fails on somebody else’s machine and never here.',
      )
  }
  return { dependencies, left }
}

interface Published {
  name: string
  version: string
  description: string
  license: string
  type: string
  bin: Record<string, string>
  exports: Record<string, string>
  engines: Record<string, string>
  repository: { type: string; url: string }
  homepage: string
  bugs: { url: string }
  keywords: string[]
  dependencies: Record<string, string>
  scripts: Record<string, string>
  pnpm: { onlyBuiltDependencies: string[] }
}

function manifestFor(
  root: ReturnType<typeof rootManifest>,
  packages: readonly Manifest[],
  dependencies: Record<string, string>,
  version: string,
): Published {
  return {
    name: PUBLISHED,
    version,
    description: root.description,
    license: root.license,
    type: 'module',
    // `tade`, never `tade-sh`: the name on npm was what was free, and the
    // command is what people type.
    bin: { [COMMAND]: './packages/cli/src/bin.js' },
    exports: exportsFor(packages),
    engines: root.engines,
    repository: root.repository,
    homepage: root.homepage,
    bugs: root.bugs,
    keywords: ['agents', 'cli', 'terminal', 'tui', 'orchestrator', 'coding-agent'],
    dependencies,
    // Two, and both node-pty's. `preinstall` runs before the dependency build
    // and says what a Linux machine is missing rather than letting node-gyp
    // say it in forty lines; `postinstall` runs after it, because node-pty's
    // prebuilt `spawn-helper` can come out of an extraction without its
    // executable bit and every PTY spawn then fails with `posix_spawnp
    // failed`. Nothing else runs on install, and neither reaches the network.
    scripts: {
      preinstall: `node scripts/${ON_INSTALL[0]}`,
      postinstall: `node scripts/${ON_INSTALL[1]}`,
    },
    // Carried, and it is nobody's install that it fixes: pnpm reads
    // `onlyBuiltDependencies` from the project being installed into and never
    // from a dependency's own manifest, so on 10 and on 12 alike `pnpm add -g
    // tade-sh` holds node-pty, better-sqlite3 and the postinstall above, and
    // says so. What answers that is `pnpm approve-builds -g`, which is in the
    // README, in `nativeTrouble` and in `helperProblem` — here is where
    // somebody reading this field would otherwise conclude it was handled.
    pnpm: root.pnpm,
  }
}

/**
 * The `exports` map, generated from each package's own.
 *
 * `@tade/mcp-core/protocol` becomes `tade-sh/mcp-core/protocol`, so every
 * subpath a package already declares keeps working, and a package that gains
 * one gains it here with nothing to remember. `./conformance` is the one key
 * dropped, because its file does not ship.
 */
export function exportsFor(packages: readonly Manifest[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const manifest of packages) {
    for (const [key, target] of Object.entries(manifest.exports)) {
      if (key === './conformance') continue
      const sub = key === '.' ? '' : key.slice(1)
      out[`./${manifest.short}${sub}`] =
        `./${manifest.dir}/${target.replace(/^\.\//, '').replace(/\.ts$/, '.js')}`
    }
  }
  const sorted: Record<string, string> = { '.': './packages/cli/src/index.js' }
  for (const key of Object.keys(out).sort()) sorted[key] = out[key] ?? ''
  return sorted
}

/**
 * What must be true of the directory before anybody packs it.
 *
 * Every one of these was a way the staged tree could be wrong in a manner that
 * only shows up on a stranger's machine, which is the one place nobody can
 * debug it. Cheap enough to run every time.
 */
function check(out: string, manifest: Published): void {
  const wrong: string[] = []
  const here = (path: string): string => relative(out, path)
  const staged = walk(out)

  for (const path of staged) {
    if (path.endsWith('.ts'))
      wrong.push(`${here(path)} is TypeScript. Node will not strip types under node_modules.`)
    if (posix.basename(path) === 'package.json' && dirname(path) !== out)
      wrong.push(
        `${here(path)} is a second package.json.\n` +
          '  It would become the closest package scope for the files beside it, and\n' +
          `  \`${PUBLISHED}/core\` resolves by self-reference against the scope it is in.`,
      )
  }

  for (const [key, target] of Object.entries(manifest.exports)) {
    // A pattern has no one file behind it, so what is checked is the folder it
    // reaches into: the subpaths themselves are checked from the other side,
    // where every `tade-sh/…` specifier in the tree is matched against the map.
    const where = target.includes('*') ? dirname(target) : target
    if (!existsSync(join(out, where)))
      wrong.push(`exports ${key} points at ${target}, which is not there`)
  }

  const bin = Object.values(manifest.bin)[0] ?? ''
  if (!existsSync(join(out, bin))) wrong.push(`bin points at ${bin}, which is not there`)
  else if (!readFileSync(join(out, bin), 'utf8').startsWith('#!'))
    wrong.push(`${bin} has no shebang, so npm cannot link it`)

  const keys = Object.keys(manifest.exports)
  for (const path of staged) {
    if (!path.endsWith('.js') && !path.endsWith('.mjs')) continue
    const code = readFileSync(path, 'utf8')
    for (const match of code.matchAll(/(['"])((?:\.{1,2}\/[^'"\n]*)|(?:tade-sh\/[^'"\n]*))\1/g)) {
      const spec = match[2] ?? ''
      if (spec.startsWith(`${PUBLISHED}/`)) {
        if (!answered(keys, `./${spec.slice(PUBLISHED.length + 1)}`))
          wrong.push(`${here(path)} imports ${spec}, which no exports key answers`)
        continue
      }
      if (!/\.(js|mjs|cjs|json|md)$/.test(spec)) continue
      if (!existsSync(resolve(dirname(path), spec)))
        wrong.push(`${here(path)} names ${spec}, which is not there`)
    }
  }

  if (wrong.length > 0)
    throw new Error(`\n\nThe staged package is not right:\n\n${wrong.join('\n')}\n`)
}

/** Whether an `exports` map answers this subpath, patterns included. */
function answered(keys: readonly string[], subpath: string): boolean {
  return keys.some((key) => {
    if (!key.includes('*')) return key === subpath
    const [before = '', after = ''] = key.split('*')
    return subpath.startsWith(before) && subpath.endsWith(after) && subpath.length >= key.length - 1
  })
}

function walk(dir: string): string[] {
  const out = execFileSync('find', [dir, '-type', 'f'], { encoding: 'utf8' })
  return out.split('\n').filter((path) => path !== '')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--version')
  const version = at === -1 ? rootManifest().version : (args[at + 1] ?? '0.0.0')
  const where = args.indexOf('--out')
  const result = stage({
    version,
    ...(where === -1 ? {} : { out: args[where + 1] ?? DEFAULT_OUT }),
  })
  process.stdout.write(
    `${PUBLISHED}@${version}: ${result.files} files in ${relative(ROOT, result.out)}\n` +
      `${Object.keys(result.dependencies).length} dependencies\n` +
      result.left.map((one) => `left out: ${one}\n`).join(''),
  )
}

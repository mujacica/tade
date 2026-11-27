import { createHash } from 'node:crypto'
import { readFile, realpath as realpathOnDisk } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'

// The window's drawing code, served to a browser as it is (the away view's
// full view: the phone draws its own copy of the window from the state the
// machine sends, §10 T2 of the Duo plan).
//
// **No build step.** Every file is served as the file it is, its types taken
// off by Node's own `stripTypeScriptTypes` — the one the release staging uses —
// so a line on the phone is a line in the repository, at the same line number.
// What makes a folder of modules loadable without a bundler is the browser's
// own **import map**: a bare specifier (`@tade/core/pure`, `zod`) is mapped to
// the URL its file is served at, and that is the whole of the resolution.
//
// What is served is **the closure of one entry and nothing else**, walked here
// the way a browser will walk it: through the import map, swaps included. A
// request is a lookup in that map, so nothing outside it — and nothing of the
// machine's that is not code — can be asked for: a traversal is not refused,
// it is unrepresentable, as `assets.ts` puts it.
//
// Three facts the browser cannot be argued out of, each handled here once:
//
// - **A file has one URL**, `/draw/<version>/pkg/<package>/<path in it>`, so a
//   relative import inside a package resolves where the browser expects, and a
//   bare one goes through the map. The version is a hash over everything
//   served, so every file is `immutable` and a new Tade is a new URL.
// - **A swap** replaces one file by another wherever it is imported, as an
//   import map entry keyed by the replaced file's URL: pi-tui's
//   `terminal-image.js` asks `child_process` what terminal this is, and a
//   browser is given Tade's own answer instead (`browser-terminal.ts`).
// - **CommonJS is wrapped, never transformed**: a file Node would load as
//   CommonJS that requires nothing (highlight.js's core is the one) is served
//   with `module` defined above it and `export default module.exports` below.
//   One that calls `require` is refused, by name, rather than served broken.
//
// `test/browser.test.ts` (in `@tade/app`) walks the same closure with
// TypeScript's own parser and holds two things: that this walk finds exactly
// the files that one does, and that none of them imports `node:` or a package
// only Node can load.

/** What the browser's drawing is built from. */
export interface DrawingPlan {
  /** The modules a page imports first: the window's drawing (`browser.ts`), and highlight.js. */
  roots: readonly Root[]
  /** Files a browser is given in place of others, absolute → absolute. */
  swaps?: Readonly<Record<string, string>>
}

/** One thing a page imports: a file, or a bare specifier resolved as if from a file. */
export type Root = { file: string } | { specifier: string; from: string }

/** One file, ready to serve. */
export interface Drawn {
  /** Where it is served, under `/draw/<version>/`. */
  path: string
  /** The file it is, on this disk. */
  file: string
  bytes: Buffer
  type: string
  etag: string
}

/** The whole of it, built once. */
export interface Drawing {
  /** A hash over every byte served and the map: what every URL carries. */
  version: string
  /** By served path. */
  files: ReadonlyMap<string, Drawn>
  /** The import map, as a page puts it in a `<script type="importmap">`. */
  importMap: { imports: Record<string, string> }
  /** Each root, as the URL a page imports it by. */
  roots: readonly string[]
  /** The bare specifiers each file imports, by served path — what the test reads. */
  imports: ReadonlyMap<string, readonly string[]>
}

/** A path with its links followed, asked of the disk once per path for the same reason. */
const reals = new Map<string, Promise<string>>()

function realpath(path: string): Promise<string> {
  let found = reals.get(path)
  if (found === undefined) {
    found = realpathOnDisk(path)
    reals.set(path, found)
  }
  return found
}

/** Where everything is served from. */
export const DRAW_PREFIX = '/draw'

// ── The walk ────────────────────────────────────────────────────────────────

/**
 * The drawing for a plan: every file the roots reach, read, stripped, versioned.
 *
 * Asynchronous and a file at a time, because it reads a few hundred files and
 * strips their types, and the window draws on the same thread: each `await`
 * is a place a frame goes out. Throws, naming the file, on what a browser
 * could not load — a `node:` import, a package that cannot be found, a
 * CommonJS file that requires — because serving it would be a page that is
 * broken with nothing on it able to say why.
 */
export async function drawingFor(plan: DrawingPlan): Promise<Drawing> {
  const swaps = new Map<string, string>()
  for (const [from, to] of Object.entries(plan.swaps ?? {})) {
    swaps.set(await realpath(from), await realpath(to))
  }
  const read = new Map<string, { code: string; bare: string[]; packageOf: PackageAt }>()
  const resolved = new Map<string, string>()
  const queue: string[] = []
  const queued = new Set<string>()
  const add = async (file: string): Promise<string> => {
    const real = swaps.get(await realpath(file)) ?? (await realpath(file))
    if (!queued.has(real)) {
      queued.add(real)
      queue.push(real)
    }
    return real
  }
  const rootFiles: string[] = []
  for (const root of plan.roots) {
    const file = 'file' in root ? root.file : await resolveBare(root.specifier, root.from, 'a root')
    const real = await add(file)
    rootFiles.push(real)
    // A root named by its specifier is imported by it: the page's own
    // `import('highlight.js/lib/core')` goes through the map like any other.
    if (!('file' in root)) resolved.set(root.specifier, real)
  }
  while (queue.length > 0) {
    const file = queue.shift()!
    const packageOf = await packageAt(file)
    const source = await readFile(file, 'utf8')
    const code = await servable(file, source, packageOf)
    const found = moduleImports(code)
    const bare: string[] = []
    for (const spec of found.specifiers) {
      if (isNodeOnly(spec))
        throw new Error(`${file} imports ${spec}, which a browser does not have`)
      if (spec.startsWith('.') || spec.startsWith('/')) {
        await add(join(dirname(file), spec))
        continue
      }
      const target = await add(await resolveBare(spec, file, file))
      const before = resolved.get(spec)
      if (before !== undefined && before !== target) {
        // An import map has one answer per specifier; two packages wanting
        // two versions of one would need scopes, and nothing here needs them.
        throw new Error(`${spec} is two files here: ${before} and ${target} (from ${file})`)
      }
      resolved.set(spec, target)
      bare.push(spec)
    }
    read.set(file, { code, bare, packageOf })
  }
  const pathOf = (file: string): string => {
    const one = read.get(file)
    if (one === undefined) throw new Error(`${file} was never read`)
    return servedPath(file, one.packageOf)
  }
  const files = new Map<string, Drawn>()
  const imports = new Map<string, readonly string[]>()
  const hash = createHash('sha256')
  for (const [file, one] of [...read].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const bytes = Buffer.from(one.code)
    const path = pathOf(file)
    hash.update(path).update('\0').update(bytes).update('\0')
    const etag = `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`
    files.set(path, { path, file, bytes, type: 'text/javascript; charset=utf-8', etag })
    imports.set(path, one.bare)
  }
  const mapped: Record<string, string> = {}
  for (const [spec, file] of [...resolved].sort(([a], [b]) => (a < b ? -1 : 1))) {
    mapped[spec] = pathOf(file)
  }
  const swapped: Record<string, string> = {}
  for (const [from, to] of swaps) {
    if (read.has(to)) swapped[servedPath(from, await packageAt(from))] = pathOf(to)
  }
  hash.update(JSON.stringify(mapped)).update(JSON.stringify(swapped))
  const version = hash.digest('hex').slice(0, 16)
  const url = (path: string) => `${DRAW_PREFIX}/${version}/${path}`
  const importMap: Record<string, string> = {}
  for (const [spec, path] of Object.entries(mapped)) importMap[spec] = url(path)
  for (const [from, to] of Object.entries(swapped)) importMap[url(from)] = url(to)
  return {
    version,
    files,
    importMap: { imports: importMap },
    roots: rootFiles.map((file) => url(pathOf(file))),
    imports,
  }
}

/** Specifiers only Node can answer: its own modules, by either spelling. */
export function isNodeOnly(spec: string): boolean {
  return spec.startsWith('node:') || NODE_BUILTINS.has(spec.split('/')[0] ?? spec)
}

const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
])

/** A file's code as served: types off a `.ts`, `module` around a CommonJS file. */
async function servable(file: string, source: string, at: PackageAt): Promise<string> {
  if (file.endsWith('.ts')) return stripTypeScriptTypes(source, { mode: 'strip' })
  if (!isCommonJs(file, source, at)) return source
  if (/\brequire\s*\(/.test(source)) {
    throw new Error(`${file} is CommonJS that requires other files, which a browser cannot load`)
  }
  return `const module = { exports: {} }; const exports = module.exports;\n${source}\nexport default module.exports;\n`
}

/** Whether Node would load this file as CommonJS: by extension, then by its package's `type`. */
function isCommonJs(file: string, source: string, at: PackageAt): boolean {
  if (file.endsWith('.cjs')) return true
  if (file.endsWith('.mjs')) return false
  if (at.type === 'module') return false
  // Node's own syntax detection, in the one case it is needed: a `.js` in a
  // package that says nothing is ESM if it is written as ESM.
  return moduleImports(source).esm === false
}

// ── Where a file is served ──────────────────────────────────────────────────

/** The package a file belongs to: its folder, its name, and how its `.js` files load. */
interface PackageAt {
  dir: string
  name: string
  type: string | undefined
}

/**
 * The nearest `package.json` above a file that names itself — what a file's
 * package is. A nested one that only says `"type"` (highlight.js's `es/`)
 * decides how the files under it load and is otherwise passed over.
 */
async function packageAt(file: string): Promise<PackageAt> {
  let dir = dirname(file)
  let type: string | undefined
  for (;;) {
    const manifest = await manifestIn(dir)
    if (manifest !== null) {
      type ??= typeof manifest.type === 'string' ? manifest.type : undefined
      if (typeof manifest.name === 'string') return { dir, name: manifest.name, type }
    }
    const up = dirname(dir)
    if (up === dir) throw new Error(`${file} is in no package`)
    dir = up
  }
}

/**
 * A folder's `package.json`, read once per folder: every file of a package
 * asks the same few on the way up, and three hundred files asking each one
 * again was most of what a walk cost.
 */
const manifests = new Map<string, Promise<Record<string, unknown> | null>>()

function manifestIn(dir: string): Promise<Record<string, unknown> | null> {
  let found = manifests.get(dir)
  if (found === undefined) {
    found = readFile(join(dir, 'package.json'), 'utf8').then(
      (text) => JSON.parse(text) as Record<string, unknown>,
      (problem: NodeJS.ErrnoException) => {
        if (problem.code === 'ENOENT' || problem.code === 'ENOTDIR') return null
        throw problem
      },
    )
    manifests.set(dir, found)
  }
  return found
}

/** `pkg/<name>/<path in the package>`, always with `/`. */
function servedPath(file: string, at: PackageAt): string {
  return ['pkg', at.name, ...relative(at.dir, file).split(sep)].join('/')
}

// ── Resolving a bare specifier, as a browser's map will have it ─────────────

/**
 * The file a bare specifier names, from a file: Node's ESM resolution with the
 * conditions a browser's module is chosen by (`browser`, `import`, `default`),
 * so `zod` is its ES build and not its CommonJS one. A package names itself
 * too — the published tarball's `tade-sh/core/pure` is a self-reference.
 */
export async function resolveBare(spec: string, from: string, who: string): Promise<string> {
  const parts = spec.split('/')
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec)
  const sub = parts.slice(spec.startsWith('@') ? 2 : 1).join('/')
  const dir = await packageDirOf(name, from)
  if (dir === null) throw new Error(`${who} imports ${spec}, and there is no ${name} to be found`)
  const manifest = (await manifestIn(dir)) ?? {}
  const target =
    manifest.exports !== undefined ? exported(manifest.exports, sub) : sub || main(manifest)
  if (target === null) throw new Error(`${who} imports ${spec}, which ${name} does not export`)
  return realpath(join(dir, target))
}

/** The folder a package is in, as Node finds it from a file: itself, or `node_modules` upward. */
async function packageDirOf(name: string, from: string): Promise<string | null> {
  let dir = dirname(from)
  for (;;) {
    const own = await manifestIn(dir)
    if (own !== null && own.name === name) return dir
    const there = join(dir, 'node_modules', ...name.split('/'))
    if ((await manifestIn(there)) !== null) return realpath(there)
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function main(manifest: Record<string, unknown>): string {
  if (typeof manifest.module === 'string') return manifest.module
  if (typeof manifest.main === 'string') return manifest.main
  return 'index.js'
}

const CONDITIONS = ['browser', 'import', 'default'] as const

/** What an `exports` field answers for a subpath, or null where it answers nothing. */
export function exported(exports: unknown, sub: string): string | null {
  const key = sub === '' ? '.' : `./${sub}`
  const table =
    typeof exports === 'string' ||
    Array.isArray(exports) ||
    (typeof exports === 'object' &&
      exports !== null &&
      !Object.keys(exports).some((one) => one.startsWith('.')))
      ? { '.': exports }
      : (exports as Record<string, unknown>)
  if (key in table) return conditioned(table[key], '')
  // The longest pattern that matches, as Node picks one.
  let best: { prefix: string; suffix: string; value: unknown } | null = null
  for (const [pattern, value] of Object.entries(table)) {
    const star = pattern.indexOf('*')
    if (star < 0) continue
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (!key.startsWith(prefix) || !key.endsWith(suffix) || key.length < pattern.length - 1)
      continue
    if (best === null || prefix.length > best.prefix.length) best = { prefix, suffix, value }
  }
  if (best === null) return null
  return conditioned(best.value, key.slice(best.prefix.length, key.length - best.suffix.length))
}

function conditioned(value: unknown, star: string): string | null {
  if (typeof value === 'string') return value.replaceAll('*', star)
  if (Array.isArray(value)) {
    for (const one of value) {
      const found = conditioned(one, star)
      if (found !== null) return found
    }
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  for (const [condition, inner] of Object.entries(value)) {
    if ((CONDITIONS as readonly string[]).includes(condition)) {
      const found = conditioned(inner, star)
      if (found !== null) return found
    }
  }
  return null
}

// ── Reading what a module imports ───────────────────────────────────────────

/**
 * Every specifier a module's code imports — `import … from`, `import '…'`,
 * `export … from` and `import('…')` with a literal — and whether it is written
 * as an ES module at all. Read with a small lexer that knows comments, strings,
 * templates and regular expressions, so an import in a comment or a string is
 * not one; type-only imports are already gone, because this reads stripped
 * code.
 */
export function moduleImports(code: string): { specifiers: string[]; esm: boolean } {
  const specifiers: string[] = []
  let esm = false
  const tokens = tokensOf(code)
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!
    if (token.kind !== 'word' || (token.text !== 'import' && token.text !== 'export')) continue
    const before = tokens[at - 1]
    if (before?.kind === 'punct' && before.text === '.') continue
    const next = tokens[at + 1]
    if (token.text === 'import') {
      if (next?.kind === 'punct' && next.text === '(') {
        const arg = tokens[at + 2]
        const close = tokens[at + 3]
        if (arg?.kind === 'string' && close?.kind === 'punct' && close.text === ')') {
          specifiers.push(arg.value)
        }
        continue
      }
      if (next?.kind === 'punct' && next.text === '.') continue
      // `{ import: … }` is a key, not a statement: an import is followed by a
      // name, a brace, a star or the string it imports.
      if (next === undefined || (next.kind === 'punct' && next.text !== '{' && next.text !== '*'))
        continue
      esm = true
      if (next.kind === 'string') {
        specifiers.push(next.value)
        continue
      }
      const spec = fromAfter(tokens, at + 1)
      if (spec !== null) specifiers.push(spec)
      continue
    }
    if (next === undefined || (next.kind === 'punct' && next.text !== '{' && next.text !== '*'))
      continue
    esm = true
    if (next.kind === 'punct' && (next.text === '{' || next.text === '*')) {
      const spec = fromAfter(tokens, at + 1)
      if (spec !== null) specifiers.push(spec)
    }
  }
  return { specifiers, esm }
}

/** The string after the `from` that ends an import or export clause, or null where it has none. */
function fromAfter(tokens: readonly Token[], start: number): string | null {
  let depth = 0
  for (let at = start; at < tokens.length; at++) {
    const token = tokens[at]!
    if (token.kind === 'punct') {
      if (token.text === '{') depth++
      else if (token.text === '}' && --depth < 0) return null
      else if (token.text === ';' && depth === 0) return null
      else if (token.text === '=' && depth === 0) return null
      else if (token.text === '(' && depth === 0) return null
    }
    if (depth === 0 && token.kind === 'word' && token.text === 'from') {
      const spec = tokens[at + 1]
      return spec?.kind === 'string' ? spec.value : null
    }
  }
  return null
}

type Token =
  | { kind: 'word'; text: string }
  | { kind: 'punct'; text: string }
  | { kind: 'string'; value: string }
  | { kind: 'other' }

/** After these, a `/` starts a regular expression rather than dividing. */
const BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

function tokensOf(code: string): Token[] {
  const out: Token[] = []
  // A template's `${` opens code; this is how many braces deep each one is.
  const templates: number[] = []
  let braces = 0
  let at = 0
  const regexAllowed = (): boolean => {
    const last = out.at(-1)
    if (last === undefined) return true
    if (last.kind === 'word') return BEFORE_REGEX.has(last.text)
    if (last.kind === 'punct') return last.text !== ')' && last.text !== ']' && last.text !== '}'
    return false
  }
  const readTemplate = (): void => {
    // At a backtick, or just after a `}` that closed a `${`: read to the end
    // of this stretch of text, which is a backtick or a `${`.
    while (at < code.length) {
      const c = code[at]!
      if (c === '\\') {
        at += 2
        continue
      }
      if (c === '`') {
        at++
        out.push({ kind: 'other' })
        return
      }
      if (c === '$' && code[at + 1] === '{') {
        at += 2
        templates.push(braces)
        braces++
        out.push({ kind: 'punct', text: '(' })
        return
      }
      at++
    }
  }
  while (at < code.length) {
    const c = code[at]!
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      at++
      continue
    }
    if (c === '/' && code[at + 1] === '/') {
      const end = code.indexOf('\n', at)
      at = end < 0 ? code.length : end
      continue
    }
    if (c === '/' && code[at + 1] === '*') {
      const end = code.indexOf('*/', at + 2)
      at = end < 0 ? code.length : end + 2
      continue
    }
    if (c === "'" || c === '"') {
      let value = ''
      at++
      while (at < code.length && code[at] !== c) {
        if (code[at] === '\\') {
          value += code[at + 1] ?? ''
          at += 2
          continue
        }
        if (code[at] === '\n') break
        value += code[at]
        at++
      }
      at++
      out.push({ kind: 'string', value })
      continue
    }
    if (c === '`') {
      at++
      readTemplate()
      continue
    }
    if (c === '/' && regexAllowed()) {
      at++
      let inClass = false
      while (at < code.length) {
        const r = code[at]!
        if (r === '\\') {
          at += 2
          continue
        }
        if (r === '\n') break
        if (r === '[') inClass = true
        else if (r === ']') inClass = false
        else if (r === '/' && !inClass) break
        at++
      }
      at++
      while (at < code.length && inWord(code.charCodeAt(at))) at++
      out.push({ kind: 'other' })
      continue
    }
    if (startsWord(code.charCodeAt(at))) {
      let end = at + 1
      while (end < code.length && inWord(code.charCodeAt(end))) end++
      out.push({ kind: 'word', text: code.slice(at, end) })
      at = end
      continue
    }
    if (c >= '0' && c <= '9') {
      let end = at + 1
      while (end < code.length && (inWord(code.charCodeAt(end)) || code[end] === '.')) end++
      out.push({ kind: 'other' })
      at = end
      continue
    }
    if (c === '{') {
      braces++
      out.push({ kind: 'punct', text: '{' })
      at++
      continue
    }
    if (c === '}') {
      braces--
      at++
      if (templates.length > 0 && templates.at(-1) === braces) {
        templates.pop()
        out.push({ kind: 'punct', text: ')' })
        readTemplate()
        continue
      }
      out.push({ kind: 'punct', text: '}' })
      continue
    }
    out.push({ kind: 'punct', text: c })
    at++
  }
  return out
}

/** `A`–`Z`, `a`–`z`, `_` or `$`: what a name starts with. */
function startsWord(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36
}

/** What a name goes on with: those, and digits. */
function inWord(c: number): boolean {
  return startsWord(c) || (c >= 48 && c <= 57)
}

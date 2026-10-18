import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from '@typescript/typescript6'

// Which tests can see a change: the import graph, read by name through a
// re-export rather than by file.
//
// `vitest related` reads the graph by file, and every package here is entered
// through an `index.ts` that is nothing but `export * from` lines — so a test
// that takes one function from `@tade/core` reached all ninety-odd of core's
// files and everything those import, and a change to any of them ran it.
//
// Here a re-export is followed only for the names somebody asked for:
// `import { tadeHome } from '@tade/core'` reaches `home.ts` and what `home.ts`
// imports, not `config.ts`. Everything else stays as wide as the file:
//
//  - A module's own body is whole. Asking anything of `home.ts` reaches every
//    import it makes, whatever it uses them for.
//  - `import * as`, `import('…')`, `require('…')`, a re-export of a whole
//    namespace and `new URL('…', import.meta.url)` (a file handed to another
//    process) ask for every name, so they follow every re-export.
//  - A re-exported module with something at its top level that runs when it is
//    loaded — a call, a loop, a top-level `await` — is reached by anybody who
//    loads the barrel, because loading the barrel runs it.
//  - A name no re-export claims is asked of every `export *`, and a cycle of
//    them is read as one that could export anything.
//  - A file of ours an import names and that is not there is still reached,
//    so deleting a module runs the tests that import it. A package from
//    `node_modules` is not followed, as `vitest related` did not follow it.
//
// What it does not see is what the graph never saw: a declaration whose
// initialiser throws as the barrel loads it reaches every importer of the
// barrel and none of them asked for it. The commit hook's smoke run loads every
// barrel, and the batched full suite runs everything.

/** Every name a module exports, or that something asked for all of them. */
export const ALL = '*'

interface Uses {
  /** A specifier as written. */
  from: string
  /** The names asked of it, or `ALL`. */
  names: Set<string> | typeof ALL
  /** Handed to another process (`new URL('./x.ts', import.meta.url)`) rather than loaded here. */
  handed?: boolean
}

export interface Module {
  /** What the module's own body imports: reached whenever the module is. */
  uses: Uses[]
  /** `export { a as b } from './x'`: `b` → `a` of `./x`; `export * as ns` is `ns` → `ALL`. */
  reexports: Map<string, { from: string; name: string }>
  /** `export * from './x'`. */
  stars: string[]
  /** Names this module declares and exports itself. */
  own: Set<string>
  /** Something at its top level runs when it is loaded. */
  runs: boolean
}

/** One module's imports and exports, from its source. Type-only ones are gone at run time and left out. */
export function moduleOf(path: string, source: string): Module {
  const mod: Module = { uses: [], reexports: new Map(), stars: [], own: new Set(), runs: false }
  if (!/\.[cm]?[jt]sx?$/.test(path)) return mod
  const kind = /\.[cm]?jsx?$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
  const use = (from: string, names: Set<string> | typeof ALL, handed = false) =>
    mod.uses.push(handed ? { from, names, handed } : { from, names })
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
      const from = statement.moduleSpecifier.text
      const clause = statement.importClause
      // `import './x'` runs it; nothing is asked of it by name.
      if (!clause) use(from, new Set())
      else if (!clause.isTypeOnly) {
        const names = new Set<string>()
        let all = false
        if (clause.name) names.add('default')
        const bound = clause.namedBindings
        if (bound && ts.isNamespaceImport(bound)) all = true
        else if (bound) {
          for (const one of bound.elements) {
            if (!one.isTypeOnly) names.add((one.propertyName ?? one.name).text)
          }
        }
        // `import { type A } from './x'` may be kept as `import {} from './x'`
        // (`verbatimModuleSyntax`), which loads it: only `import type` is gone.
        use(from, all ? ALL : names)
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      const from =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined
      const clause = statement.exportClause
      if (from === undefined) {
        if (clause && ts.isNamedExports(clause)) {
          for (const one of clause.elements) if (!one.isTypeOnly) mod.own.add(one.name.text)
        }
      } else if (!clause) mod.stars.push(from)
      else if (ts.isNamespaceExport(clause))
        mod.reexports.set(clause.name.text, { from, name: ALL })
      else {
        for (const one of clause.elements) {
          if (!one.isTypeOnly)
            mod.reexports.set(one.name.text, { from, name: (one.propertyName ?? one.name).text })
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      mod.own.add('default')
      mod.runs ||= !inert(statement.expression)
    } else if (ts.isImportEqualsDeclaration(statement)) {
      mod.runs = true
    } else {
      const exported = ts.canHaveModifiers(statement)
        ? (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        : false
      const isDefault = ts.canHaveModifiers(statement)
        ? (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
        : false
      if (ts.isVariableStatement(statement)) {
        mod.runs ||= awaitsHere(statement)
        if (exported) {
          for (const one of statement.declarationList.declarations) {
            for (const name of boundNames(one.name)) mod.own.add(name)
          }
        }
      } else if (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)
      ) {
        if (exported && isDefault) mod.own.add('default')
        else if (exported && statement.name) mod.own.add(statement.name.text)
      } else if (
        !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement) &&
        !ts.isModuleDeclaration(statement) &&
        !ts.isEmptyStatement(statement) &&
        !isDirective(statement)
      ) {
        mod.runs = true
      }
    }
  }
  // Whatever loads something else as it runs: the asked-for module is the
  // whole of it, because nothing says which names it will use.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0]
      const literal = first && ts.isStringLiteralLike(first) ? first.text : undefined
      if (literal !== undefined) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) use(literal, ALL)
        else if (ts.isIdentifier(node.expression) && node.expression.text === 'require')
          use(literal, ALL)
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const [first, second] = node.arguments ?? []
      if (
        node.expression.text === 'URL' &&
        first &&
        ts.isStringLiteralLike(first) &&
        /\.[cm]?[jt]s$/.test(first.text) &&
        second &&
        second.getText(file) === 'import.meta.url'
      ) {
        use(first.text, ALL, true)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return mod
}

/** A top-level `await` in a declaration: `const config = await load()`. */
function awaitsHere(node: ts.Node): boolean {
  if (ts.isAwaitExpression(node)) return true
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false
  return ts.forEachChild(node, awaitsHere) ?? false
}

function isDirective(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)
}

/** An expression that runs nothing when it is evaluated: a name, a literal, a function. */
function inert(node: ts.Expression): boolean {
  return (
    ts.isIdentifier(node) ||
    ts.isLiteralExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassExpression(node)
  )
}

function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((one) => (ts.isBindingElement(one) ? boundNames(one.name) : []))
}

/** Where `@tade/…` names point: a package's directory and its `exports`. */
export interface Workspace {
  root: string
  packages: Map<string, { dir: string; exports: Record<string, string> }>
}

/** Every package under `packages/` and `test/`, by the name its manifest gives it. */
export function workspaceAt(root: string): Workspace {
  const packages = new Map<string, { dir: string; exports: Record<string, string> }>()
  const look = (dir: string, depth: number) => {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      const read = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string
        exports?: string | Record<string, string>
      }
      if (read.name) {
        const exports =
          typeof read.exports === 'string' ? { '.': read.exports } : (read.exports ?? {})
        packages.set(read.name, { dir, exports })
      }
      return
    }
    if (depth === 0) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules')
        look(join(dir, entry.name), depth - 1)
    }
  }
  look(join(root, 'packages'), 2)
  look(join(root, 'test'), 0)
  return { root, packages }
}

/** The path a specifier names, relative to the root, whether or not it is there; `undefined` outside the repository. */
export function wouldBe(ws: Workspace, importer: string, specifier: string): string | undefined {
  const absolute = absoluteOf(ws, importer, specifier)
  return absolute === undefined ? undefined : relative(ws.root, absolute).split(sep).join('/')
}

/** The file a specifier names, relative to the root, or `undefined` for one outside the repository or not there. */
export function resolveFrom(
  ws: Workspace,
  importer: string,
  specifier: string,
): string | undefined {
  const absolute = absoluteOf(ws, importer, specifier)
  if (absolute === undefined) return undefined
  const tried = [absolute, `${absolute}.ts`, join(absolute, 'index.ts')]
  const found = tried.find((one) => existsSync(one) && statSync(one).isFile())
  return found === undefined ? undefined : relative(ws.root, found).split(sep).join('/')
}

function absoluteOf(ws: Workspace, importer: string, specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return resolve(dirname(join(ws.root, importer)), specifier)
  }
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '')
  const pkg = ws.packages.get(name)
  if (!pkg) return undefined
  const sub = `.${specifier.slice(name.length)}`
  const target = targetOf(pkg.exports, sub)
  return target === undefined ? undefined : resolve(pkg.dir, target)
}

function targetOf(exports: Record<string, string>, sub: string): string | undefined {
  const exact = exports[sub]
  if (typeof exact === 'string') return exact
  for (const [pattern, target] of Object.entries(exports)) {
    const star = pattern.indexOf('*')
    if (star < 0 || typeof target !== 'string') continue
    const head = pattern.slice(0, star)
    const tail = pattern.slice(star + 1)
    if (sub.startsWith(head) && sub.endsWith(tail) && sub.length >= head.length + tail.length) {
      return target.replace('*', sub.slice(head.length, sub.length - tail.length))
    }
  }
  return undefined
}

/** The graph over a repository: modules read once, resolved once. */
export class Graph {
  readonly #modules = new Map<string, Module | null>()
  readonly #resolved = new Map<string, string | undefined>()
  readonly #exported = new Map<string, Set<string> | null>()
  readonly #loads = new Map<string, Set<string>>()

  readonly ws: Workspace
  readonly read: (path: string) => string | undefined

  constructor(ws: Workspace, read?: (path: string) => string | undefined) {
    this.ws = ws
    this.read =
      read ??
      ((path) => {
        try {
          return readFileSync(join(ws.root, path), 'utf8')
        } catch {
          return undefined
        }
      })
  }

  module(path: string): Module | null {
    if (!this.#modules.has(path)) {
      const source = this.read(path)
      let mod: Module | null = null
      if (source !== undefined) {
        try {
          mod = moduleOf(path, source)
        } catch {
          mod = null
        }
      }
      this.#modules.set(path, mod)
    }
    return this.#modules.get(path) ?? null
  }

  resolve(importer: string, specifier: string): string | undefined {
    const key = `${importer}\0${specifier}`
    if (!this.#resolved.has(key)) this.#resolved.set(key, resolveFrom(this.ws, importer, specifier))
    return this.#resolved.get(key)
  }

  /** Every name a module exports at run time, or `null` where that cannot be said. */
  exported(path: string, seen = new Set<string>()): Set<string> | null {
    const cached = this.#exported.get(path)
    if (cached !== undefined) return cached
    // A cycle of `export *` is not worth placing a name in: say it cannot be said.
    if (seen.has(path)) return null
    seen.add(path)
    const mod = this.module(path)
    let names: Set<string> | null = null
    if (mod) {
      names = new Set([...mod.own, ...mod.reexports.keys()])
      for (const star of mod.stars) {
        const target = this.resolve(path, star)
        const theirs = target === undefined ? null : this.exported(target, seen)
        if (theirs === null) {
          names = null
          break
        }
        for (const one of theirs) if (one !== 'default') names.add(one)
      }
    }
    this.#exported.set(path, names)
    return names
  }

  /**
   * Every file a module reaches when these names of it are asked for — a file
   * of this repository it imports and is not there among them.
   */
  reach(start: string, names: Set<string> | typeof ALL = ALL): Set<string> {
    const files = new Set<string>()
    const asked = new Map<string, Set<string> | typeof ALL>()
    const queue: Array<[string, Set<string> | typeof ALL]> = [[start, names]]
    // Where a process starts: this one, and every file handed to another.
    const entries = new Set([start])
    const ask = (path: string | undefined, want: Set<string> | typeof ALL) => {
      if (path !== undefined) queue.push([path, want])
    }
    const walk = () => {
      for (let next = queue.pop(); next; next = queue.pop()) {
        const [path, want] = next
        const before = asked.get(path)
        if (before === ALL) continue
        let fresh: Set<string> | typeof ALL
        if (want === ALL) fresh = ALL
        else {
          fresh = new Set([...want].filter((one) => !before?.has(one)))
          if (before !== undefined && fresh.size === 0) continue
        }
        asked.set(path, fresh === ALL ? ALL : new Set([...(before ?? []), ...fresh]))
        const first = !files.has(path)
        files.add(path)
        const mod = this.module(path)
        if (!mod) continue
        if (first) {
          for (const one of mod.uses) {
            const target = this.resolve(path, one.from)
            // A file of ours that is not there is still reached, so a test that
            // imports a deleted module is related to its deletion.
            if (target === undefined && !one.handed) {
              const gone = wouldBe(this.ws, path, one.from)
              if (gone !== undefined) files.add(gone)
            }
            if (target !== undefined && one.handed) entries.add(target)
            ask(target, one.names)
          }
        }
        if (fresh === ALL) {
          for (const { from, name } of mod.reexports.values())
            ask(this.resolve(path, from), name === ALL ? ALL : new Set([name]))
          for (const star of mod.stars) ask(this.resolve(path, star), ALL)
          continue
        }
        for (const name of fresh) {
          const re = mod.reexports.get(name)
          if (re) {
            ask(this.resolve(path, re.from), re.name === ALL ? ALL : new Set([re.name]))
            continue
          }
          if (mod.own.has(name) || name === 'default') continue
          const targets = mod.stars.map((star) => this.resolve(path, star))
          const claimed = targets.filter((target) => {
            const theirs = target === undefined ? new Set<string>() : this.exported(target)
            return theirs === null || theirs.has(name)
          })
          // A name nobody claims is a name this misread: ask everybody for it.
          for (const target of claimed.length > 0 ? claimed : targets) ask(target, new Set([name]))
        }
      }
    }
    walk()
    // Loading a module loads everything it re-exports and everything those
    // import, by name or not. What runs as it loads is reached by whoever
    // loads it, however little they asked of it — in this process or in one
    // handed a file.
    for (;;) {
      const loaded = new Set([...entries].flatMap((entry) => [...this.#loaded(entry)]))
      const runs = [...loaded].filter((path) => !files.has(path) && this.module(path)?.runs)
      if (runs.length === 0) break
      for (const path of runs) ask(path, new Set())
      walk()
    }
    return files
  }

  /** Every file loading this one loads in the same process: the graph by file, as `vitest related` reads it. */
  #loaded(start: string): Set<string> {
    const cached = this.#loads.get(start)
    if (cached) return cached
    const seen = new Set<string>([start])
    const queue = [start]
    for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
      const mod = this.module(path)
      if (!mod) continue
      const next = [
        ...mod.uses.filter((one) => !one.handed).map(({ from }) => from),
        ...[...mod.reexports.values()].map(({ from }) => from),
        ...mod.stars,
      ]
      for (const from of next) {
        const target = this.resolve(path, from)
        if (target !== undefined && !seen.has(target)) {
          seen.add(target)
          queue.push(target)
        }
      }
    }
    this.#loads.set(start, seen)
    return seen
  }
}

/**
 * The tests among `tests` that reach any of `changed` — themselves, or a file
 * every test runs under (`setupFiles`), which reaches all of them.
 */
export function testsReaching(
  graph: Graph,
  tests: readonly string[],
  changed: readonly string[],
  everyTestRuns: readonly string[] = [],
): string[] {
  const wanted = new Set(changed)
  const touches = (path: string) => [...graph.reach(path)].some((file) => wanted.has(file))
  if (everyTestRuns.some(touches)) return [...tests]
  return tests.filter(touches)
}

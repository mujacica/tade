import { readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DRAWING_CEILING,
  type Drawing,
  isNodeOnly,
  resolveBare,
  wireBytes,
} from '@tade/web/drawing'
// The compiler as a library, for its parser: `typescript` 7 ships no API
// (`test/dead-keys.test.ts` says why the 6 compatibility package is the one).
import ts from '@typescript/typescript6'
import { beforeAll, describe, expect, it } from 'vitest'
import { BROWSER_ENTRY, drawing, drawingPlan } from '../src/wire/drawing.ts'

// The window's drawing runs in a browser, and this is what holds it there.
//
// "The pure files are pure" was a rule about each file: no `node:` import in
// `view.ts`. It said nothing about what they import, and that is where Node
// came in — `model.ts` reached `@tade/core`'s barrel, and through it `fs`,
// `crypto` and `child_process`; `inbox.ts` reached the away view's server;
// pi-tui's barrel reached its renderer. A browser loads the closure, so the
// closure is what is held: every file `browser.ts` reaches, walked the way the
// browser walks it — through the import map and its swaps — and read with
// TypeScript's own parser rather than the lexer that serves it, so the one
// that is wrong cannot agree with itself.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

interface Walked {
  /** Every file the roots reach, through the swaps. */
  files: Set<string>
  /** Why each file is in it: the file that first imported it. */
  via: Map<string, string | null>
  /** What a browser has no answer to, as `file imports spec`. */
  nodeOnly: string[]
}

/** The specifiers a file imports at run time: what a browser will fetch. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      // `import { type A } from 'a'` still loads `a`: Node's type stripping
      // leaves `import {} from 'a'` behind, so only `import type` is free.
      out.push((node.moduleSpecifier as ts.StringLiteral).text)
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      out.push((node.moduleSpecifier as ts.StringLiteral).text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

async function walk(): Promise<Walked> {
  const plan = await drawingPlan()
  const swaps = new Map<string, string>()
  for (const [from, to] of Object.entries(plan.swaps ?? {})) {
    swaps.set(await realpath(from), await realpath(to))
  }
  const files = new Set<string>()
  const via = new Map<string, string | null>()
  const nodeOnly: string[] = []
  const queue: [string, string | null][] = []
  const reach = async (file: string, from: string | null): Promise<void> => {
    const real = await realpath(file)
    const to = swaps.get(real) ?? real
    if (files.has(to)) return
    files.add(to)
    via.set(to, from)
    queue.push([to, from])
  }
  for (const root of plan.roots) {
    await reach(
      'file' in root ? root.file : await resolveBare(root.specifier, root.from, 'a root'),
      null,
    )
  }
  while (queue.length > 0) {
    const [file] = queue.shift()!
    for (const spec of importsOf(file)) {
      if (isNodeOnly(spec)) nodeOnly.push(`${relative(ROOT, file)} imports ${spec}`)
      else if (spec.startsWith('.')) await reach(join(dirname(file), spec), file)
      else await reach(await resolveBare(spec, file, file), file)
    }
  }
  return { files, via, nodeOnly }
}

/** How a file came to be in the closure, from the entry down: what to cut. */
function chain(walked: Walked, file: string): string {
  const out: string[] = []
  for (let at: string | null | undefined = file; at; at = walked.via.get(at)) {
    out.unshift(relative(ROOT, at))
  }
  return out.join(' → ')
}

let walked: Walked
let built: Drawing

beforeAll(async () => {
  walked = await walk()
  built = await drawing()
})

describe("the window's drawing, in a browser", () => {
  it('imports nothing of Node, anywhere it reaches', () => {
    const why = walked.nodeOnly.map((line) => {
      const file = join(ROOT, line.split(' imports ')[0] ?? '')
      return `${line}\n    ${chain(walked, file)}`
    })
    expect(why, why.join('\n')).toEqual([])
  })

  it('starts at browser.ts, which reaches the view, the panels and the hit map', () => {
    const app = (path: string) => join(ROOT, 'packages/app/src', path)
    for (const one of ['view.ts', 'panels.ts', 'hits.ts', 'scroll.ts', 'layout.ts', 'model.ts']) {
      expect(walked.files.has(app(one)), one).toBe(true)
    }
    expect(walked.files.has(BROWSER_ENTRY)).toBe(true)
  })

  it('reaches no barrel that brings the machine with it', () => {
    const barrels = ['packages/core/src/index.ts', 'packages/web/src/index.ts']
    for (const barrel of barrels) {
      const file = join(ROOT, barrel)
      expect(walked.files.has(file), walked.files.has(file) ? chain(walked, file) : barrel).toBe(
        false,
      )
    }
    const tui = [...walked.files].filter((file) =>
      /pi-tui\/dist\/(index|tui|terminal)\.js$/.test(file),
    )
    expect(tui.map((file) => chain(walked, file))).toEqual([])
  })

  it('is served exactly: the lexer that serves it finds the files the parser does', () => {
    const served = new Set([...built.files.values()].map((one) => one.file))
    const missing = [...walked.files].filter((file) => !served.has(file))
    const extra = [...served].filter((file) => !walked.files.has(file))
    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })

  it('maps every bare specifier any of it imports, and nothing it does not', () => {
    const imported = new Set([...built.imports.values()].flat())
    const mapped = Object.keys(built.importMap.imports).filter((key) => !key.startsWith('/'))
    const roots = mapped.filter((key) => key.startsWith('highlight.js/'))
    expect(mapped.filter((key) => !imported.has(key) && !roots.includes(key))).toEqual([])
    expect([...imported].filter((spec) => !(spec in built.importMap.imports))).toEqual([])
  })

  it("swaps pi-tui's terminal-image.js for the one that asks no terminal", () => {
    const swapped = Object.entries(built.importMap.imports).filter(([key]) => key.startsWith('/'))
    expect(swapped).toHaveLength(1)
    const [from, to] = swapped[0] ?? ['', '']
    expect(from).toMatch(/\/pkg\/@earendil-works\/pi-tui\/dist\/terminal-image\.js$/)
    expect(to).toMatch(/\/pkg\/@tade\/app\/src\/browser-terminal\.ts$/)
  })

  it('serves every file at one versioned URL, with its types off', () => {
    for (const [path, one] of built.files) {
      expect(path.startsWith('pkg/'), path).toBe(true)
      if (one.file.endsWith('.ts')) expect(one.bytes.toString()).not.toMatch(/^import type /m)
    }
    for (const url of Object.values(built.importMap.imports)) {
      expect(url.startsWith(`/draw/${built.version}/pkg/`), url).toBe(true)
      expect(built.files.has(url.slice(`/draw/${built.version}/`.length)), url).toBe(true)
    }
  })
})

describe("the full view's code, on the wire", () => {
  it('fits its own ceiling, as served and as sent', async () => {
    const { raw, wire } = await wireBytes(built)
    const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`
    expect(raw / 1024, `${kb(raw)} as served`).toBeLessThanOrEqual(DRAWING_CEILING.rawKb)
    expect(wire / 1024, `${kb(wire)} brotli`).toBeLessThanOrEqual(DRAWING_CEILING.wireKb)
  })
})

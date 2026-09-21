import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// A key nobody will ever read.
//
// TypeScript refuses an object literal with a key the target type does not
// have — its excess-property check, and the thing that catches a typo in a
// field name. Spread the literal instead, and the check does not happen:
//
//   const section: Section = { id: 'queue', ...(plan ? { action: … } : {}) }
//
// `action` is not a key of `Section`, which has `actions`. Nothing complains,
// nothing draws it, and the build is green. That is not a hypothetical either:
// this is how the SMART QUEUE's `plan` button was never drawn, and with it the
// only way into the plan view — one letter, a whole feature unreachable, and
// every other test passing.
//
// The idiom is right and used 450-odd times here; what is missing is the
// check. So this is the check: the same excess-property question TypeScript
// asks of a literal, asked of every literal that is spread into one.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The bug as it was, so this test can never pass by having stopped looking. */
const PROBE_PATH = `${ROOT}packages/app/src/__dead-key-probe__.ts`
const PROBE = `
interface Section { id: string; actions?: { label: string }[] }
declare const plan: boolean
export const bad: Section = { id: 'queue', ...(plan ? { action: { label: 'plan' } } : {}) }
export const good: Section = { id: 'queue', ...(plan ? { actions: [{ label: 'plan' }] } : {}) }
`

interface DeadKey {
  where: string
  key: string
  type: string
}

/**
 * Every object literal reachable through a spread's expression: the branches
 * of a conditional, both sides of `&&`, `||` and `??`, and through `as` and
 * `satisfies`. Anything else — a variable, a call — has a type of its own that
 * TypeScript already checked, and is not what goes unchecked here.
 */
function literalsIn(expr: ts.Expression): ts.ObjectLiteralExpression[] {
  const e = ts.isParenthesizedExpression(expr) ? expr.expression : expr
  if (ts.isObjectLiteralExpression(e)) return [e]
  if (ts.isConditionalExpression(e)) return [...literalsIn(e.whenTrue), ...literalsIn(e.whenFalse)]
  if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return literalsIn(e.expression)
  if (ts.isBinaryExpression(e)) {
    const kind = e.operatorToken.kind
    const logical =
      kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken
    if (logical) return [...literalsIn(e.left), ...literalsIn(e.right)]
  }
  return []
}

/**
 * Whether this key reaches anything in the contextual type. A union is
 * answered by any arm that has the key — spreading into `A | B` is a choice
 * between them, not a promise about both. An index signature, `any`, and a
 * type with no members at all take whatever they are given, so nothing spread
 * into one is dead.
 */
function reaches(checker: ts.TypeChecker, target: ts.Type, key: string): boolean {
  const parts = target.isUnion() ? target.types : [target]
  return parts.some(
    (part) =>
      checker.getPropertyOfType(part, key) !== undefined ||
      checker.getIndexInfosOfType(part).length > 0 ||
      (part.flags & ts.TypeFlags.Any) !== 0 ||
      checker.getPropertiesOfType(part).length === 0,
  )
}

/** Builds the repository's own program, with the probe file served from memory. */
function program(): ts.Program {
  const config = ts.readConfigFile(`${ROOT}tsconfig.json`, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT)
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.readFile = (name) => (name === PROBE_PATH ? PROBE : readFile(name))
  host.fileExists = (name) => name === PROBE_PATH || fileExists(name)
  host.getSourceFile = (name, version, onError, shouldCreate) =>
    name === PROBE_PATH
      ? ts.createSourceFile(name, PROBE, version, true, ts.ScriptKind.TS)
      : getSourceFile(name, version, onError, shouldCreate)
  return ts.createProgram([...parsed.fileNames, PROBE_PATH], parsed.options, host)
}

function deadKeys(): { found: DeadKey[]; probe: DeadKey[]; spreads: number } {
  const built = program()
  const checker = built.getTypeChecker()
  const found: DeadKey[] = []
  const probe: DeadKey[] = []
  let spreads = 0
  for (const file of built.getSourceFiles()) {
    if (file.isDeclarationFile) continue
    if (!file.fileName.startsWith(ROOT) || file.fileName.includes('node_modules')) continue
    const walk = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const contextual = checker.getContextualType(node)
        // No contextual type is nothing to check against: the literal's own
        // type is whatever it says, and no key in it can be dead.
        const target = contextual ? checker.getNonNullableType(contextual) : undefined
        for (const property of node.properties) {
          if (!ts.isSpreadAssignment(property)) continue
          for (const inner of literalsIn(property.expression)) {
            spreads++
            if (!target) continue
            for (const member of inner.properties) {
              const name = member.name
              // A computed or quoted key is not the typo this is about.
              if (!name || !ts.isIdentifier(name)) continue
              if (reaches(checker, target, name.text)) continue
              const { line } = file.getLineAndCharacterOfPosition(name.getStart())
              const where = `${file.fileName.slice(ROOT.length)}:${line + 1}`
              const one = { where, key: name.text, type: checker.typeToString(target) }
              ;(file.fileName === PROBE_PATH ? probe : found).push(one)
            }
          }
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(file)
  }
  return { found, probe, spreads }
}

describe('a spread into an object literal cannot carry a dead key', () => {
  const { found, probe, spreads } = deadKeys()

  it('catches the key that made the plan view unreachable', () => {
    // Written against the real bug, in the file the real check reads, so the
    // day this stops working it says so rather than reporting nothing found.
    expect(probe.map((one) => one.key)).toEqual(['action'])
  })

  it('reads every conditional spread there is', () => {
    // A rewrite that quietly stopped matching the idiom would leave the check
    // above passing and this one at zero.
    expect(spreads).toBeGreaterThan(100)
  })

  it('finds no key the type it is spread into does not have', () => {
    const said = found.map((one) => `${one.where}  '${one.key}' is not a key of ${one.type}`)
    expect(said).toEqual([])
  })
})

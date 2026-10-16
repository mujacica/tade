// The parser as a library — `typescript` 7 is the native port and ships no
// API, so this reads with the 6-era one, as `dead-keys.test.ts` does. Only the
// parser: whether a handler throws away what it caught is a question about the
// shape of the code, and answering it needs no types.
import ts from '@typescript/typescript6'

/** One handler that catches an error and carries on without it. */
export interface Discard {
  line: number
  kind: 'catch {}' | '.catch()' | '.then(, )'
}

/**
 * Every handler in one file's source that catches an error and carries on
 * without it: a `catch` clause, or the function handed to `.catch()` or as the
 * second argument of `.then()`, that never names what it caught and does not
 * throw.
 *
 * **Never naming the error is the whole test**, because it is the one thing a
 * handler that reports cannot help doing and one that swallows always does.
 * `catch {}` and `.catch(() => [])` cannot say what went wrong — they have
 * nothing to say it with — and `catch (err) {}` names it only to drop it. A
 * handler that tells anybody anything (`warnings.push(\`…: ${String(err)}\`)`,
 * `this.troubled(err)`, `report(err)`), or looks before it decides
 * (`if (isMissing(err)) return null`), names it. A handler handed by name
 * (`.catch(report)`) is passed the error, so it is not one of these. One that
 * throws is not carrying on, whatever it throws.
 */
export function discardsIn(path: string, source: string): Discard[] {
  if (!/catch|\.then\(/.test(source)) return []
  const kind = /\.m?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
  const found: Discard[] = []
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      if (!holds(node.variableDeclaration?.name, node.block)) {
        found.push({ line: lineOf(node), kind: 'catch {}' })
      }
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const handler =
        method === 'catch' ? node.arguments[0] : method === 'then' ? node.arguments[1] : undefined
      if (
        handler &&
        (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
        !holds(handler.parameters[0]?.name, handler.body)
      ) {
        found.push({
          line: lineOf(node.expression.name),
          kind: method === 'catch' ? '.catch()' : '.then(, )',
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Whether a handler does something with what it caught: names it, or throws. */
function holds(caught: ts.BindingName | undefined, body: ts.Node): boolean {
  // A destructured binding reads something out of the error on the way in.
  if (caught && !ts.isIdentifier(caught)) return true
  return (caught !== undefined && names(caught.text, body)) || throws(body)
}

/** Whether `name` is read anywhere in `body` — as itself, not as a property of something else. */
function names(name: string, body: ts.Node): boolean {
  const visit = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent
      const member =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node)
      if (!member) return true
    }
    return ts.forEachChild(node, visit) ?? false
  }
  return visit(body)
}

/** Whether `body` throws on its own account, not inside a function it only defines. */
function throws(body: ts.Node): boolean {
  const visit = (node: ts.Node): boolean => {
    if (ts.isThrowStatement(node)) return true
    if (ts.isFunctionLike(node)) return false
    return ts.forEachChild(node, visit) ?? false
  }
  return ts.isFunctionLike(body) ? false : visit(body)
}

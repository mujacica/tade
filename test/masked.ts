// The parser as a library, as `swallowed.ts` reads it: `typescript` 7 is the
// native port and ships no API. Only the parser — whether something awaited
// can overtake a rethrow is a question about the order of the code.
import ts from '@typescript/typescript6'

/** One `await` that, if it rejects, leaves the handler in place of the error it caught. */
export interface Mask {
  line: number
  awaited: string
}

/**
 * Every `await` in one file's source that stands between a caught error and
 * the `throw` that hands it on: in a `catch` clause, or the function given to
 * `.catch()` or as the second argument of `.then()`, a statement that throws
 * what was caught (`throw err`, `throw new McpError(…, why(err))`), and before
 * that statement an `await` with nothing guarding it.
 *
 * If that await rejects, its error is the one that leaves, and the one caught
 * — the only one that says what went wrong — is never said anywhere. It is the
 * cleanup or the record on the way out that does it: the journal line saying
 * a reply could not go (`intake.ts`), a lock let go, a program ended.
 *
 * **Guarded is a `try` around it, or a rejection handler on it** (`.catch(…)`,
 * `.then(…, …)`) — what that handler does with what *it* caught is
 * `swallowed.ts`'s question, not this one. Only `await`, because what is
 * awaited is what goes to the disk, the network or another program, which is
 * what fails on a bad day. An `await` in the same statement as the throw is in
 * another branch of it (`if (signIn) await signIn() else throw …`), and one
 * after it never runs before it.
 */
export function masksIn(path: string, source: string): Mask[] {
  if (!/catch|\.then\(/.test(source) || !source.includes('throw')) return []
  const kind = /\.m?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
  const found: Mask[] = []
  const look = (caught: ts.BindingName | undefined, body: ts.Node) => {
    if (!caught || !ts.isIdentifier(caught) || !ts.isBlock(body)) return
    const statements = body.statements
    const last = statements.findLastIndex((one) => rethrows(caught.text, one))
    for (const one of statements.slice(0, Math.max(0, last))) {
      for (const awaited of unguarded(one)) {
        found.push({
          line: file.getLineAndCharacterOfPosition(awaited.getStart(file)).line + 1,
          awaited: shortly(awaited.expression.getText(file)),
        })
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      look(node.variableDeclaration?.name, node.block)
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const handler =
        method === 'catch' ? node.arguments[0] : method === 'then' ? node.arguments[1] : undefined
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        look(handler.parameters[0]?.name, handler.body)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * Whether a statement throws something that reads `name` out of this handler —
 * not from inside a function it only defines, nor from a `try` that would
 * catch it again.
 */
function rethrows(name: string, statement: ts.Node): boolean {
  const visit = (node: ts.Node): boolean => {
    if (ts.isFunctionLike(node)) return false
    if (ts.isTryStatement(node)) {
      return [node.catchClause?.block, node.finallyBlock].some((part) => part && visit(part))
    }
    if (ts.isThrowStatement(node) && reads(name, node.expression)) return true
    return ts.forEachChild(node, visit) ?? false
  }
  return visit(statement)
}

/** The `await`s in a statement that nothing would catch, outside any function it only defines. */
function unguarded(statement: ts.Node): ts.AwaitExpression[] {
  const found: ts.AwaitExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
    if (ts.isTryStatement(node)) {
      // What the `try` block awaits is caught there; its handlers are not.
      if (node.catchClause) visit(node.catchClause.block)
      if (node.finallyBlock) visit(node.finallyBlock)
      return
    }
    if (ts.isAwaitExpression(node) && !handled(node.expression)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(statement)
  return found
}

/** What was awaited, on one line and short enough to read in a list. */
function shortly(text: string): string {
  const line = text.replace(/\s*\n\s*(?=[.?])/g, '').replace(/\s+/g, ' ')
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** Whether a promise has a rejection handler of its own: `.catch(…)` or `.then(…, …)`. */
function handled(expression: ts.Expression): boolean {
  const call = ts.isParenthesizedExpression(expression) ? expression.expression : expression
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false
  const method = call.expression.name.text
  return method === 'catch' || (method === 'then' && call.arguments.length > 1)
}

/** Whether `name` is read anywhere in `node` — as itself, not as a property of something else. */
function reads(name: string, node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === name) {
    const parent = node.parent
    const member =
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node)
    if (!member) return true
  }
  return ts.forEachChild(node, (child) => reads(name, child) || undefined) ?? false
}

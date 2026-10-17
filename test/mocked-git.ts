// The parser as a library, as `swallowed.ts` reads it: `typescript` 7 is the
// native port and ships no API. Only the parser — whether a test answers for
// git is a question about the shape of the code, and answering it needs no
// types.
import ts from '@typescript/typescript6'

/** One place a test stands in for git rather than asking it. */
export interface StandIn {
  line: number
  kind: 'answers for git' | 'makes up a git failure'
}

/**
 * Every place in one test file's source where the test writes what git would
 * have said, rather than asking git:
 *
 * - **It answers for git**: it asks whether the program it was handed is
 *   `'git'` (`command !== 'git'`, `case 'git':`) and, on the side of that
 *   branch where it is, never hands it to anything — no call takes the program
 *   it compared, or `'git'`, as its first argument. Only a stand-in needs to
 *   know it is being asked for git; a test that runs git hands it on
 *   (`run(command, args)`), or never asks and sends on whatever is not the
 *   replay's (`command === 'gh' ? replay.exec(…) : reallyExec(…)`).
 * - **It makes up a git failure**: it builds an `Error` whose message says
 *   git. In a test, an error about git that the test wrote is one git never
 *   gave, and the code is then held to a failure reality may not have.
 */
export function standInsIn(path: string, source: string): StandIn[] {
  if (!/git/.test(source)) return []
  const kind = /\.m?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
  const found: StandIn[] = []
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  const visit = (node: ts.Node): void => {
    const asked = askedIfGit(node)
    if (asked && !handsOn(asked.program.getText(file), whereGit(asked), file)) {
      found.push({ line: lineOf(node), kind: 'answers for git' })
    } else if (madeUpGitFailure(node)) {
      found.push({ line: lineOf(node), kind: 'makes up a git failure' })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** The literal `'git'`. Matched rather than compared, since a comparison with it is what is counted. */
const isGit = (node: ts.Node | undefined): boolean =>
  node !== undefined &&
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
  /^git$/.test(node.text)

/** A comparison of something with `'git'`, or a `case 'git':`, and what was compared. */
function askedIfGit(
  node: ts.Node,
): { at: ts.Node; program: ts.Expression; when: 'true' | 'false' | 'case' } | null {
  if (ts.isCaseClause(node) && isGit(node.expression) && ts.isSwitchStatement(node.parent.parent)) {
    return { at: node, program: node.parent.parent.expression, when: 'case' }
  }
  if (!ts.isBinaryExpression(node)) return null
  const op = node.operatorToken.kind
  const equal =
    op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken
  const unequal =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken
  if (!equal && !unequal) return null
  const program = isGit(node.right) ? node.left : isGit(node.left) ? node.right : null
  return program ? { at: node, program, when: equal ? 'true' : 'false' } : null
}

/** The code that runs when the program is git, as near as the branch says; else the whole function. */
function whereGit(asked: { at: ts.Node; when: 'true' | 'false' | 'case' }): ts.Node[] {
  if (asked.when === 'case') return [asked.at]
  // Up through what keeps the answer: `a === 'git' && b` is true only for git,
  // `a !== 'git' || b` false only for git.
  const keeps =
    asked.when === 'true' ? ts.SyntaxKind.AmpersandAmpersandToken : ts.SyntaxKind.BarBarToken
  let cond: ts.Node = asked.at
  while (
    ts.isParenthesizedExpression(cond.parent) ||
    (ts.isBinaryExpression(cond.parent) && cond.parent.operatorToken.kind === keeps)
  ) {
    cond = cond.parent
  }
  const branch = cond.parent
  if (ts.isConditionalExpression(branch) && branch.condition === cond) {
    return [asked.when === 'true' ? branch.whenTrue : branch.whenFalse]
  }
  if (ts.isIfStatement(branch) && branch.expression === cond) {
    const taken = asked.when === 'true' ? branch.thenStatement : branch.elseStatement
    const after = ts.isBlock(branch.parent)
      ? branch.parent.statements.slice(branch.parent.statements.indexOf(branch) + 1)
      : []
    return taken && exits(taken) ? [taken] : [...(taken ? [taken] : []), ...after]
  }
  let fn: ts.Node = asked.at
  while (!ts.isSourceFile(fn) && !ts.isFunctionLike(fn)) fn = fn.parent
  return [fn]
}

/** A statement that never falls through to the one after it. */
function exits(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true
  if (ts.isBlock(statement)) {
    const last = statement.statements.at(-1)
    return last !== undefined && exits(last)
  }
  if (ts.isIfStatement(statement)) {
    return (
      statement.elseStatement !== undefined &&
      exits(statement.thenStatement) &&
      exits(statement.elseStatement)
    )
  }
  return false
}

/** Whether anything in these nodes is called with the program, or with `'git'`, first. */
function handsOn(program: string, nodes: ts.Node[], file: ts.SourceFile): boolean {
  const calls = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const first = node.arguments?.[0]
      if (first && (isGit(first) || first.getText(file) === program)) return true
    }
    return ts.forEachChild(node, calls) ?? false
  }
  return nodes.some(calls)
}

/** `new Error('git …')`, `Error(\`… git …\`)`: any `…Error` built with a message that says git. */
function madeUpGitFailure(node: ts.Node): boolean {
  if (!ts.isNewExpression(node) && !ts.isCallExpression(node)) return false
  if (!ts.isIdentifier(node.expression) || !node.expression.text.endsWith('Error')) return false
  const message = node.arguments?.[0]
  if (!message) return false
  const text =
    ts.isStringLiteral(message) || ts.isNoSubstitutionTemplateLiteral(message)
      ? message.text
      : ts.isTemplateExpression(message)
        ? [message.head.text, ...message.templateSpans.map((span) => span.literal.text)].join(' ')
        : ''
  return /\bgit\b/.test(text)
}

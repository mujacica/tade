#!/usr/bin/env node
import { nodeTooOld } from './node.ts'
import { needsNode } from './version.ts'

// Nothing below this line is imported at the top, and the two above it are
// each a file with no dependency of its own. A static import is evaluated
// before any statement in this file, so anything imported here is code that
// runs before the check that says whether this Node can run it — which on Node
// 20 is what a person sees instead: a TypeError out of the middle of execa.
const tooOld = nodeTooOld(process.versions.node, needsNode(), process.execPath)
if (tooOld !== null) {
  process.stderr.write(tooOld)
  process.exit(1)
}

// Loaded rather than imported, so that a dependency which did not install is a
// sentence instead of a stack trace out of Node's module loader. Everything
// Tade needs is reached through `program.ts`, so one catch here is every such
// failure there is.
async function load(): Promise<(argv: string[]) => Promise<number>> {
  try {
    return (await import('./program.ts')).run
  } catch (error) {
    const { nativeTrouble } = await import('./native.ts')
    const trouble = nativeTrouble(error)
    if (trouble === null) throw error
    process.stderr.write(trouble)
    return process.exit(1)
  }
}

process.exitCode = await (await load())(process.argv)

#!/usr/bin/env node
import { nodeTooOld } from './node.ts'
import { opensWindow, sayOpening, unsayOpening } from './opening.ts'
import { endsQuietly } from './pipe.ts'
import { needsNode } from './version.ts'

// Nothing below this line is imported at the top, and the four above it are
// each a file with no dependency of its own — but `opening.ts`'s drawing,
// `splash.ts`, which has none either. A static import is evaluated
// before any statement in this file, so anything imported here is code that
// runs before the check that says whether this Node can run it — which on Node
// 20 is what a person sees instead: a TypeError out of the middle of execa.
const tooOld = nodeTooOld(process.versions.node, needsNode(), process.execPath)
if (tooOld !== null) {
  process.stderr.write(tooOld)
  process.exit(1)
}

// A reader that stops reading ends a command quietly (`pipe.ts`).
endsQuietly(process.stdout, () =>
  process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0),
)

// Before the most of a second it takes to load the rest: a terminal left blank
// that long reads as a command that did nothing, so the mark goes up at once
// and turns until the window takes the screen (`opening.ts`).
if (opensWindow(process.argv.slice(2))) sayOpening()

// Loaded rather than imported, so that a dependency which did not install is a
// sentence instead of a stack trace out of Node's module loader. Everything
// Tade needs is reached through `program.ts` — the command typed is loaded by
// `run` before it parses anything, and a failure inside a command is answered
// there — so one catch here is every such failure there is.
async function main(argv: string[]): Promise<number> {
  try {
    return await (await import('./program.ts')).run(argv)
  } catch (error) {
    const { nativeTrouble } = await import('./native.ts')
    const trouble = nativeTrouble(error)
    unsayOpening()
    if (trouble === null) throw error
    process.stderr.write(trouble)
    return process.exit(1)
  }
}

process.exitCode = await main(process.argv)

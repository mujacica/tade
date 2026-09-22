#!/usr/bin/env node
import { nativeTrouble } from './native.ts'

// Loaded rather than imported at the top, so that a dependency which did not
// install is a sentence instead of a stack trace out of Node's module loader.
// Everything Tade needs is reached through `program.ts`, so one catch here is
// every such failure there is.
async function load(): Promise<(argv: string[]) => Promise<number>> {
  try {
    return (await import('./program.ts')).run
  } catch (error) {
    const trouble = nativeTrouble(error)
    if (trouble === null) throw error
    process.stderr.write(trouble)
    return process.exit(1)
  }
}

process.exitCode = await (await load())(process.argv)

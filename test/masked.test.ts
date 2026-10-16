import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path/posix'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { masksIn } from './masked.ts'

// An error that was going to be handed on, replaced on the way out.
//
// Jev asks of every change whether it "makes something able to fail without
// anyone being told in words what went wrong", and seven times a verdict said
// yes. Four of the seven were a handler that never named what it caught, and
// `swallowed.test.ts` counts those. One of the other three was a handler that
// did name it and did throw it — and still lost it: when a reply could not be
// posted to an intake source, `intake.ts` wrote the failure down and then
// rethrew it, and with the write awaited bare, a journal that would not take
// the line threw from there instead. The transport's own sentence, the only one
// that said what went wrong at the source, never reached anybody.
//
// What a machine can see is the order: an `await` with nothing guarding it, in
// a statement before the one that throws what was caught. `masksIn`
// (`./masked.ts`) says exactly what is counted. Five were already in the tree,
// each a record or a cleanup on the way out of a failure, so this is a ratchet
// like `swallowed.test.ts`: one number per file, today's, which may go DOWN in
// the commit that earns it and never up.
//
// The fix it asks for is a rejection handler on the cleanup. Note that one
// which drops what *it* caught (`.catch(() => {})`, as `intake.ts` now does) is
// what `swallowed.test.ts` counts, and raising a number there is the
// conversation; one that says both, the caught error first, is counted by
// neither.
//
// What no check here can see, and where the seven showed it:
//
// - **A throw from somewhere a promise nobody awaited reaches.** The schedules
//   pass runs as `void runDue().then(…)`, so a throw from `machine.route()`
//   inside it went to `watchProcess`, which reports it and nothing else. Any
//   call can throw, and the floating promise was there long before the call.
// - **A bound that binds before the rule does.** The same intake change capped
//   replies at six a day when a request's life has seven: a number, not a shape.
// - **A deadline that runs out for ever.** An emulator thread caught in a loop
//   left every capture falling back to the last screen, which a single late
//   answer must do and does; that it would never stop is not in the code.
//
// It runs in `test:smoke`, which is what the commit hook runs.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const TABLE = 'test/masked.test.ts'

/** Where the counting is done: what ships, the away view's page included. */
const SOURCE = /^packages\/(.+\/)?src\/.*\.(ts|m?js)$/

/**
 * The mistake as it was made, and the shapes it takes in the tree, so this test
 * can never pass by having stopped looking. Each must be counted once.
 */
const MADE: Record<string, string> = {
  // As 5c7153fe's own comment says it was before: "Awaited bare".
  'factory-source-replies packages/workbench/src/intake.ts': `
    try {
      receipt = await req.post({ key, say, mark })
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err)
      await tade.log.append({ type: 'intake_replied', detail: { ...line, state: 'unsent', problem } })
      throw err
    }`,
  'a rejection handler that lets go first': `
    const slot = await wait().catch(async (err) => {
      await lock.release()
      throw err
    })`,
  'a rethrow under an if': `
    try { return await run(argv) } catch (error) {
      const { nativeTrouble } = await import('./native.ts')
      if (nativeTrouble(error) === null) throw error
      return 1
    }`,
  'what was caught, wrapped': `
    await opening.catch(async (err) => {
      await close()
      throw new McpError('unavailable', \`would not start: \${why(err)}\`)
    })`,
  'an await under an if before the rethrow': `
    try { await write() } catch (err) {
      if (handle) await handle.close()
      throw err
    }`,
}

/** The shapes that are not the mistake. None is counted. */
const FIXED: Record<string, string> = {
  '5c7153fe the record is attempted and the original raised': `
    try {
      receipt = await req.post({ key, say, mark })
    } catch (err) {
      await tade.log.append({ type: 'intake_replied', detail: { problem } }).catch(() => {})
      throw err
    }`,
  'a cleanup that says both, the caught error first': `
    try { await work() } catch (err) {
      await lock.release().catch((also) => {
        throw new Error(\`\${why(err)}, and the lock could not be let go: \${why(also)}\`)
      })
      throw err
    }`,
  'a cleanup in a try of its own': `
    try { await work() } catch (err) {
      try { await lock.release() } catch (also) { said(also) }
      throw err
    }`,
  'a rejection handler given as the second argument': `
    try { await work() } catch (err) {
      await lock.release().then(undefined, said)
      throw err
    }`,
  'an await in another branch of the statement that throws': `
    try { await work() } catch (err) {
      if (signIn) {
        if (!(await signIn())) throw new Error('signing in did not finish')
      } else {
        throw new Error(\`it needs signing in: \${(err as Error).message}\`)
      }
    }`,
  'an await after the rethrow': `
    try { await work() } catch (err) {
      if (code(err) !== 'EEXIST') throw err
      await rm(path, { force: true })
    }`,
  'an await in a function it only defines': `
    try { await work() } catch (err) {
      later(async () => { await retry() })
      throw err
    }`,
  'a throw that is not what was caught': `
    try { await work() } catch (err) {
      await rm(path, { force: true })
      throw new Error('could not write it')
    }`,
}

/**
 * How many awaits in each file can replace an error it was handing on. A
 * number here may go DOWN in the commit that earns it, and never up; a file
 * that is not here is allowed none.
 */
const ALLOWED: Record<string, number> = {
  // Letting go of the checkout's lock when the wait for the machine's failed.
  'packages/checks/core/src/run.ts': 1,
  // Loading what explains a dependency that did not install.
  'packages/cli/src/bin.ts': 1,
  // Ending a server that would not start.
  'packages/mcp/stdio/src/index.ts': 1,
  // Writing down that a watch's finding could not be made into work: the
  // intake mistake itself, in a second place.
  'packages/workbench/src/found.ts': 1,
  // Letting go of the home's lock when opening the workbench failed.
  'packages/workbench/src/workbench.ts': 1,
}

/** Repo-relative paths of every source file git tracks under `packages/`. */
function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'packages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((path) => SOURCE.test(path))
}

/**
 * A file's source, or `null` when it is not on disk: agents share this
 * checkout, and a file git tracks that nobody has is a deletion somebody has
 * not committed yet.
 */
function sourceOf(path: string): string | null {
  try {
    return readFileSync(join(ROOT, path), 'utf8')
  } catch (problem) {
    // Only absence is a deletion; a file that could not be read is not one
    // that has nothing in it.
    if ((problem as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw problem
  }
}

const counted = (source: string): number => masksIn('probe.ts', source).length

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/** Thrown rather than expected, so the message arrives as it was written, saying what to do. */
function report(problems: string[]): void {
  if (problems.length > 0) throw new Error(`\n\n${problems.join('\n\n')}\n`)
}

describe('an error being handed on is not replaced on the way out', () => {
  it('counts the mistake as it was made, and each shape it takes', () => {
    const missed = Object.entries(MADE).filter(([, source]) => counted(source) !== 1)
    expect(missed.map(([name]) => name)).toEqual([])
  })

  it('counts none of the shapes that guard the cleanup, or never run it first', () => {
    const counts = Object.entries(FIXED).filter(([, source]) => counted(source) !== 0)
    expect(counts.map(([name]) => name)).toEqual([])
  })

  it('holds each file to the awaits it already had', () => {
    const problems: string[] = []
    for (const path of tracked()) {
      const source = sourceOf(path)
      if (source === null) continue
      const found = masksIn(path, source)
      const allowed = ALLOWED[path] ?? 0
      if (found.length <= allowed) continue
      const where = found.map((one) => `  ${path}:${one.line}  await ${one.awaited}`).join('\n')
      problems.push(
        `${path} awaits something that can replace the error it is handing on ${times(found.length)}, where it is allowed ${allowed}:\n${where}`,
      )
    }
    if (problems.length > 0)
      problems.push(
        'If that await rejects, its error leaves instead of the one caught, and what went wrong is\n' +
          'never said. Give it a rejection handler that says both, the caught error first, or one\n' +
          'that drops its own (and argue for that in `swallowed.test.ts`). Moving code moves its\n' +
          `number in ALLOWED (${TABLE}) with it.`,
      )
    report(problems)
  })

  it('keeps the numbers following the files down', () => {
    const problems: string[] = []
    for (const [path, allowed] of Object.entries(ALLOWED)) {
      const source = sourceOf(path)
      if (source === null) continue
      const found = masksIn(path, source).length
      if (found < allowed)
        problems.push(
          `${path} has ${found} awaits that can replace an error it is handing on, and ALLOWED (${TABLE}) still says ${allowed}.\n` +
            (found === 0 ? 'Delete its line' : `Lower it to ${found}`) +
            ' in the same commit: a number left above its file is room for the next one.',
        )
    }
    report(problems)
  })
})

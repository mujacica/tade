import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyDelta, deltaBetween, revise, tick } from '../src/delta.ts'
import { DeltaSchema, PROTOCOL_VERSION, SnapshotSchema } from '../src/protocol.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { EVERY, input, NOW, reach, task } from './fixtures.ts'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** Repo-relative paths of every `.ts` file git tracks under `packages/web/src`. */
function sources(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'packages/web/src'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.endsWith('.ts'))
}

const textOf = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

/**
 * A file with its comments taken off.
 *
 * The three rules below are string checks over *code*, and the comments are
 * where the argument for each rule lives — so a file that explains why it may
 * not import `@tade/app` must not fail the test for saying so. The `[^:]`
 * guard is what keeps `https://` from reading as the start of a comment.
 */
const code = (path: string): string =>
  textOf(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('the schema is the test', () => {
  it('parses a whole projection strictly, so a stray key is a failure', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    expect(SnapshotSchema.parse(snapshot)).toEqual(snapshot)
  })

  it('refuses a projection with a field nobody declared', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    const smuggled = {
      ...snapshot,
      tasks: snapshot.tasks.map((one) => ({ ...one, worktree: '/Users/testperson/x' })),
    }
    expect(SnapshotSchema.safeParse(smuggled).success).toBe(false)
  })

  it('parses every delta a run of changes produces', () => {
    const steps = [
      input({ reach: reach(EVERY) }),
      input({ reach: reach(EVERY), tasks: [...input().tasks, task({ id: 'tade/new' })] }),
      input({ reach: reach(['notes']), notes: [] }),
      input({ reach: reach(EVERY), projects: [], tasks: [], queue: [], findings: [], plans: [] }),
    ]
    let held = snapshotOf(steps[0]!, NOW)
    for (const [n, step] of steps.slice(1).entries()) {
      const next = snapshotOf(step, NOW + (n + 1) * 2_000)
      const delta = deltaBetween(held, next)
      expect(DeltaSchema.parse(delta)).toEqual(delta)
      held = applyDelta(held, delta!)
    }
    expect(DeltaSchema.parse(tick(held, NOW))).toBeTruthy()
  })

  it('stamps the version on every frame, so a client never has to guess', () => {
    const one = input({ reach: reach(EVERY) })
    const made = revise(null, one, NOW)
    expect(made.snapshot.v).toBe(PROTOCOL_VERSION)
    const been = revise(made.snapshot, { ...one, notes: [] }, NOW + 2_000)
    expect(been.kind === 'changed' && been.delta.v).toBe(PROTOCOL_VERSION)
  })
})

describe('what this package may not reach', () => {
  it('imports neither the window nor the workbench', () => {
    // Also held repo-wide by `test/modularity.test.ts`; here because this is
    // where somebody adding an import to this package is looking.
    const guilty = sources().filter((path) => /@tade\/(app|workbench)/.test(code(path)))
    expect(guilty).toEqual([])
  })

  it('never writes a `said` line, because it cannot name the event', () => {
    // `said` has exactly one writer — `Keyboard.remember` — and `namedBy`
    // reads those lines to authorise every `asked`-tier setting change on the
    // machine. A page that could put words in somebody's mouth would inherit
    // authority over all of them. The guarantee on this side is that the away
    // view cannot reach `say()` or `remember()` at all; this is the cheap half
    // of it, as DESIGN.md §13.3's test 2.
    const guilty = sources().filter((path) => /['"]said['"]/.test(code(path)))
    expect(guilty).toEqual([])
  })

  it('keys nothing to a journal sequence number or a byte offset', () => {
    // `compactJournal` rewrites `events.jsonl` in place at every window start,
    // and `readJournalSince` resumes by byte offset: a cursor keyed to either
    // can point at different content after a restart and still look valid.
    // `(epoch, rev)` is immune by construction, and stays immune only while
    // nothing here learns about the other two.
    const guilty = sources().filter((path) => /\bseq\b|readJournalSince|lastSeq/.test(code(path)))
    expect(guilty).toEqual([])
  })
})

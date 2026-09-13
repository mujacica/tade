import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TestSignal } from '@wilco/core'

// Whether a task's tests passed, and whether that is still true.
//
// The first failure mode in the design is an agent reporting success on broken
// work, so `review` is meant to mean green tests and a clean tree, both
// verified by something other than the agent. Tests were never probed, which
// left half the state machine unreachable and made `review` mean "it stopped".
//
// A result is about one commit. Tests that passed three commits ago say
// nothing about this one, so a record that does not name the current HEAD is
// worth no more than never having run them.

export interface TestRecord {
  status: 'pass' | 'fail'
  /** The commit they ran against. */
  commit: string
  command: string
  at: string
  /** Tail of the output, so a failure can be explained without re-running. */
  output: string
}

export function testsPath(worktree: string): string {
  return join(worktree, '.wilco', 'tests.json')
}

/** What the recorded run says about the commit checked out now. */
export async function readTests(worktree: string, head: string | null): Promise<TestSignal> {
  const record = await readRecord(worktree)
  if (!record || !head) return 'unknown'
  // Stale results are worse than none: they would let `review` mean green
  // when the last three commits were never run.
  return record.commit === head ? record.status : 'unknown'
}

/** The whole record, for saying what failed. Null when there is none to read. */
export async function readRecord(worktree: string): Promise<TestRecord | null> {
  try {
    return asRecord(JSON.parse(await readFile(testsPath(worktree), 'utf8')))
  } catch {
    // Never run, or a file we cannot read: the same answer either way.
    return null
  }
}

export async function writeTests(worktree: string, record: TestRecord): Promise<void> {
  const path = testsPath(worktree)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`)
}

/** Hand-checked rather than schema-parsed: null on any shape we don't know. */
function asRecord(value: unknown): TestRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw.status !== 'pass' && raw.status !== 'fail') return null
  if (typeof raw.commit !== 'string' || raw.commit === '') return null
  return {
    status: raw.status,
    commit: raw.commit,
    command: typeof raw.command === 'string' ? raw.command : '',
    at: typeof raw.at === 'string' ? raw.at : '',
    output: typeof raw.output === 'string' ? raw.output : '',
  }
}

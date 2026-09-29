import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { carryOver, followRenames, readChecks, readRuns, rollup } from '@tade/checks-core'
import type { TestSignal } from '@tade/core'

// Whether a task's tests passed, and whether that is still true.
//
// The first failure mode in the design is an agent reporting success on broken
// work, so `review` is meant to mean green tests and a clean tree, both
// verified by something other than the agent. Tests were never probed, which
// left half the state machine unreachable and made `review` mean "it stopped".
//
// A result is about one commit. Tests that passed three commits ago say
// nothing about this one, so a record that does not name the current HEAD is
// worth no more than never having run them — unless it names the very bytes
// this commit holds, which is what a check run records and `carryOver` reads.
// The old `tests.json` records no such thing, so it stays commit-exact.

export interface TestRecord {
  status: 'pass' | 'fail'
  /** The commit they ran against. */
  commit: string
  command: string
  at: string
  /** Tail of the output, so a failure can be explained without re-running. */
  output: string
}

export function testsPath(records: string): string {
  return join(records, 'tests.json')
}

/** What the recorded run says about the commit checked out now. */
export async function readTests(records: string, head: string | null): Promise<TestSignal> {
  const record = await readRecord(records)
  if (!record || !head) return 'unknown'
  // Stale results are worse than none: they would let `review` mean green
  // when the last three commits were never run.
  return record.commit === head ? record.status : 'unknown'
}

/**
 * Whether this commit is verified: the rollup of the project's required
 * checks at HEAD, and the one recorded test run for a project that has no
 * checks written down.
 *
 * `unknown` when some required check has not run here. Absent is not fine:
 * "three commits, tests green" must mean the whole gate passed, not that one
 * of three commands did.
 */
export async function verifiedAt(
  worktree: string,
  head: string | null,
  project: {
    name: string
    root: string
    /** Where runs about this worktree are written down: Tade's own folder for it. */
    records: string
    test?: string | undefined
    /**
     * What somebody said about running each check here (`checks.run_here`).
     * Read here for the same reason the page reads it: a check Tade does not
     * run on this machine is out of what a run here adds up to, and a required
     * one left in would hold every commit at `unknown` for good.
     */
    chosen?: Readonly<Record<string, boolean>> | undefined
  },
): Promise<TestSignal> {
  const manifest = await readChecks({
    name: project.name,
    root: worktree,
    ...(project.test ? { test: project.test } : {}),
    ...(project.chosen ? { chosen: project.chosen } : {}),
  })
  const records = project.records
  if (manifest.checks.length === 0) return readTests(records, head)
  // Runs recorded under a step's earlier name still speak for it, as long as
  // they ran the same command: retitling a step in CI must not read as a check
  // nobody has ever run.
  const runs = followRenames(manifest.checks, await readRuns(records))
  // A run taken just before a commit, over the bytes that commit holds, is a
  // run of this commit whatever it is called: `carryOver` says which those
  // are, and says nothing about any other.
  const state = rollup(manifest.checks, runs, await carryOver(worktree, runs, head)).state
  // A project that has checks but has never run one through Tade still has
  // whatever `tade check` recorded before this existed.
  return state === 'unknown' ? readTests(records, head) : state
}

/** The whole record, for saying what failed. Null when there is none to read. */
export async function readRecord(records: string): Promise<TestRecord | null> {
  try {
    return asRecord(JSON.parse(await readFile(testsPath(records), 'utf8')))
  } catch {
    // Never run, or a file we cannot read: the same answer either way.
    return null
  }
}

export async function writeTests(records: string, record: TestRecord): Promise<void> {
  const path = testsPath(records)
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

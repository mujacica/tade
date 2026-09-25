import type { Reading } from './ci.ts'
import { readWorkflows } from './ci.ts'
import { readHooks } from './hooks.ts'
import type { Check, ProjectRef } from './port.ts'

// What a project checks, read out of what it already says.
//
// There is no manifest and there is deliberately no way to write one. A
// project says what it checks in two places already — the hook that runs
// before a commit, and the workflows that run on every change — and a third
// list in `.tade/checks.yaml` was a list somebody had to keep in step with
// both. Tade generated CI from it, which made the drift a test could catch and
// the duplication a person still had to maintain.
//
// So, in order:
//
//   1. the commit hook — what this project holds a *commit* to, here (hooks.ts)
//   2. CI's change-triggered workflows — what it holds a *push* to (ci.ts)
//   3. `projects.<name>.test_command` — one line in Tade's own config, for a
//      project that has neither
//   4. nothing, and `unknown` stands, which is true
//
// The escape hatch for a project whose CI cannot be read is deliberately a
// config key and not a file in that repository: a file Tade writes into
// somebody's repo so that Tade can read it back is the duplication being
// removed here. A project with nothing readable has no checks, its agents are
// told so in as many words, and nothing pretends otherwise — because a check
// nobody could read is not a check Tade may invent.

/** Where a project's checks came from, for the sentence that says so. */
export type ChecksSource = 'CI' | 'hook' | 'CI and hook' | 'test command' | 'none'

export interface ChecksRead {
  checks: readonly Check[]
  source: ChecksSource
  /** The files they were read from, as a person reads it; null where there were none. */
  from: string | null
  /** What was not read, in sentences a person can act on. */
  problems: readonly string[]
}

const DEFAULT_MINUTES = 10

const NONE: ChecksRead = { checks: [], source: 'none', from: null, problems: [] }

/**
 * A project's checks, from what it already says. Reads files and nothing else:
 * no processes, no network, safe to call from a draw-adjacent poll or from the
 * CLI with the window closed.
 */
export async function readChecks(
  project: ProjectRef & { test?: string | undefined },
): Promise<ChecksRead> {
  const [hook, ci] = await Promise.all([readHooks(project.root), readWorkflows(project.root)])
  const found = joined(hook, ci)
  if (found) return found
  if (project.test) {
    return {
      checks: [
        {
          id: 'tests',
          title: 'Tests',
          run: project.test,
          alone: true,
          minutes: DEFAULT_MINUTES,
          required: true,
          from: 'test_command',
        },
      ],
      source: 'test command',
      from: null,
      problems: [],
    }
  }
  return NONE
}

/**
 * The hook and CI as one list: the hook first, because it is the cheap gate and
 * a run that fails in four seconds should fail in four seconds.
 *
 * Null where neither had anything at all — which is not the same as a project
 * whose workflows hold no checks Tade may run, and reads differently to
 * whoever is told: that one keeps its sentences.
 */
function joined(hook: Reading | null, ci: Reading | null): ChecksRead | null {
  if (!hook && !ci) return null
  const checks: Check[] = [...(hook?.checks ?? [])]
  const taken = new Set(checks.map((check) => check.id))
  for (const check of ci?.checks ?? []) {
    // A CI step named after the hook keeps a name of its own: two rows with one
    // id is two things the window draws as one.
    let id = check.id
    for (let n = 2; taken.has(id); n++) id = `${check.id}-${n}`
    taken.add(id)
    checks.push(id === check.id ? check : { ...check, id })
  }
  const from = [...(hook?.from ?? []), ...(ci?.from ?? [])]
  const problems = [...(hook?.unread ?? []), ...(ci?.unread ?? [])]
  if (checks.length === 0 && problems.length === 0) return null
  return {
    checks,
    source: hook && ci?.checks.length ? 'CI and hook' : hook ? 'hook' : 'CI',
    from: from.length > 0 ? from.join(' and ') : null,
    problems,
  }
}

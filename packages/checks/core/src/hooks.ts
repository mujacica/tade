import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Reading } from './ci.ts'
import type { Check } from './port.ts'

// What a project holds a commit to, on this machine, by its own arrangement.
//
// A hook is arbitrary shell and cannot be parsed into steps — and does not need
// to be. **The hook is one check whose command is the hook**, which is the
// honest reading of what the project already runs before every commit. That is
// the fast gate, where CI is the real one, and between them a project has said
// everything it checks without writing any of it down twice.
//
// Found by looking for files, never by running git: `readChecks` is called
// from a draw-adjacent poll, and a poll that spawns `git config` four times a
// second is a poll that costs something. The cost of that is a project whose
// `core.hooksPath` points somewhere unusual — Tade does not see its hook, says
// what it found, and that is honest rather than wrong.

/** The id a hook check always has, whichever manager wrote it. */
export const HOOK_ID = 'pre-commit'

/**
 * Where a commit hook lives, and what running it looks like, in the order they
 * are believed. `.githooks/` before `.git/hooks/` because a project that has
 * both has pointed `core.hooksPath` at the one it committed — and the sample
 * hooks git ships are named `.sample`, so nothing here finds one of those.
 */
const HOOKS: readonly { at: string; run: (at: string) => string; what: string }[] = [
  { at: join('.githooks', 'pre-commit'), run: (at) => `sh ${at}`, what: 'the committed hook' },
  { at: join('.husky', 'pre-commit'), run: (at) => `sh ${at}`, what: 'the husky hook' },
  {
    at: '.pre-commit-config.yaml',
    run: () => 'pre-commit run --all-files',
    what: 'the pre-commit framework',
  },
  { at: '.pre-commit-config.yml', run: () => 'pre-commit run --all-files', what: 'pre-commit' },
  { at: 'lefthook.yml', run: () => 'lefthook run pre-commit', what: 'lefthook' },
  { at: 'lefthook.yaml', run: () => 'lefthook run pre-commit', what: 'lefthook' },
  { at: '.lefthook.yml', run: () => 'lefthook run pre-commit', what: 'lefthook' },
  { at: join('.git', 'hooks', 'pre-commit'), run: (at) => `sh ${at}`, what: 'the installed hook' },
]

/** How long a hook is given. It is the fast gate by design; past this it has hung. */
const MINUTES = 10

/**
 * The commit hook this project has, as one check. Null where it has none.
 *
 * At most one: two hook managers in one repository is one of them left over,
 * and running both would be running somebody's dead configuration.
 */
export async function readHooks(root: string): Promise<Reading | null> {
  for (const hook of HOOKS) {
    if (!(await there(join(root, hook.at)))) continue
    const check: Check = {
      id: HOOK_ID,
      title: 'Before a commit',
      run: hook.run(hook.at),
      // One script, and the fast gate: it wants the machine the way every
      // other check does, and it is seconds rather than minutes.
      alone: true,
      minutes: MINUTES,
      required: true,
      from: hook.at,
    }
    return { checks: [check], from: [hook.at], unread: [] }
  }
  return null
}

/** Whether there is a file there. A directory is not a hook. */
async function there(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

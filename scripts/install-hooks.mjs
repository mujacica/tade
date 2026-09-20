// Point git at the hooks that are in the repository, so the gate everybody
// gets is the one under review rather than one each person copied into
// `.git/hooks` once and never updated.
//
// Never fails an install: a hook is a convenience, and a machine that cannot
// have one — a tarball with no `.git`, a worktree mid-surgery — must still be
// able to install dependencies and run the tests.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const hooks = join(root, '.githooks')
const relative = '.githooks'

const git = (...args) =>
  spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

if (existsSync(hooks) && git('rev-parse', '--git-dir').status === 0) {
  // Git refuses a hook without the executable bit, silently: it is simply
  // never run, which is the one failure mode a gate must not have.
  for (const name of readdirSync(hooks)) {
    const hook = join(hooks, name)
    try {
      if ((statSync(hook).mode & 0o111) === 0) chmodSync(hook, 0o755)
    } catch {
      // best effort
    }
  }
  const asked = process.argv.includes('--force')
  const current = git('config', '--local', '--get', 'core.hooksPath').stdout?.trim() ?? ''
  if (current === relative) {
    if (asked) console.log(`git hooks: core.hooksPath is already ${relative}`)
  } else if (current !== '' && !asked) {
    // Somebody chose their own. Say so rather than taking it over: hooks run
    // arbitrary commands on every commit, and quietly swapping whose is a
    // surprise nobody wants from an install. `pnpm hooks` is how you say yes.
    console.log(
      `git hooks: leaving core.hooksPath as ${current} — \`pnpm hooks\` switches it to ${relative}`,
    )
  } else if (git('config', '--local', 'core.hooksPath', relative).status === 0) {
    console.log(`git hooks: core.hooksPath -> ${relative}`)
  }
}

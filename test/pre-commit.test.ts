import { spawnSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gitEnv, mkrepo, type Repo } from './fixtures/mkrepo.ts'

// In a commit, the committed hook's style step reads what is being committed
// and nothing else (`.githooks/pre-commit`): agents share one checkout, and
// over `.` one agent's half-written file failed every other agent's commit.
// What it reads is the staged copy of each path, not the working tree's, so a
// file half-staged with `git add -p` is held to what goes into the commit.
// Tade's checks given `paths` run it on the index a commit of those paths
// would have (`asCommitOf`), so it reads them the same way. Outside a commit —
// by hand, or by Tade's checks with no paths — it still reads the whole tree.
//
// The repository here has no tsconfig, so a hook that got past its style step
// stops at types, and no commit here ever lands. Which step said it failed is
// the whole answer.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOOK = join(ROOT, '.githooks', 'pre-commit')
const STYLE = 'pre-commit: style and lint failed'
const TYPES = 'pre-commit: types failed'
const TIDY = 'export const a = 1\n'
const UNTIDY = 'export   const b    =    2;;\n'

/** A repository using this one's hooks and biome, and none of its files. */
function repo(): Repo {
  const repo = mkrepo()
  symlinkSync(join(ROOT, 'node_modules'), join(repo.root, 'node_modules'))
  repo.write({
    'package.json': '{ "private": true }\n',
    // As biome itself formats it, since outside a commit it reads this too.
    'biome.json':
      '{\n\t"files": { "includes": ["*.ts"] },\n\t"javascript": { "formatter": { "semicolons": "asNeeded" } }\n}\n',
  })
  repo.git('add', 'package.json', 'biome.json')
  repo.git('commit', '-q', '--no-verify', '-m', 'Biome')
  repo.git('config', 'core.hooksPath', join(ROOT, '.githooks'))
  return repo
}

/** What `args` wrote to stderr, run in `repo` as a person at a terminal would. */
function run(repo: Repo, ...args: string[]): string {
  const env = gitEnv()
  // When this suite itself runs inside a commit hook, the outer commit's index
  // must not leak into these.
  delete env.GIT_INDEX_FILE
  return spawnSync(args[0] ?? '', args.slice(1), { cwd: repo.root, env, encoding: 'utf8' }).stderr
}

describe('the commit hook', () => {
  it('is not failed by somebody else’s untidy file that is not in the commit', () => {
    const r = repo()
    r.write({ 'tidy.ts': TIDY, 'untidy.ts': UNTIDY })
    r.git('add', 'tidy.ts')
    const untracked = run(r, 'git', 'commit', '-q', '-m', 'Tidy', '--only', '--', 'tidy.ts')
    expect(untracked).not.toContain(STYLE)
    expect(untracked).toContain(TYPES)

    // Staged by somebody else, it is still not in a commit `--only` names.
    r.git('add', 'untidy.ts')
    const staged = run(r, 'git', 'commit', '-q', '-m', 'Tidy', '--only', '--', 'tidy.ts')
    expect(staged).not.toContain(STYLE)
    expect(staged).toContain(TYPES)
  }, 60_000)

  it('fails a commit of an untidy file', () => {
    const r = repo()
    r.write({ 'tidy.ts': TIDY, 'untidy.ts': UNTIDY })
    r.git('add', 'tidy.ts', 'untidy.ts')
    expect(run(r, 'git', 'commit', '-q', '-m', 'Untidy', '--only', '--', 'untidy.ts')).toContain(
      STYLE,
    )
    expect(run(r, 'git', 'commit', '-q', '-m', 'Both')).toContain(STYLE)
  }, 60_000)

  it('reads the whole tree when it is run outside a commit', () => {
    const r = repo()
    r.write({ 'tidy.ts': TIDY })
    expect(run(r, 'sh', HOOK)).toContain(TYPES)
    // Nothing staged, nothing tracked: only the whole tree has it.
    r.write({ 'untidy.ts': UNTIDY })
    expect(run(r, 'sh', HOOK)).toContain(STYLE)
  }, 60_000)

  it('reads what is staged, not what is in the working tree', () => {
    const r = repo()
    // A tidy copy staged, and an untidy edit beside it that is not going in.
    r.write({ 'half.ts': TIDY })
    r.git('add', 'half.ts')
    r.write({ 'half.ts': UNTIDY })
    const clean = run(r, 'git', 'commit', '-q', '-m', 'Half')
    expect(clean).not.toContain(STYLE)
    expect(clean).toContain(TYPES)

    // An untidy copy staged, and the working tree tidied after it.
    r.write({ 'half.ts': UNTIDY })
    r.git('add', 'half.ts')
    r.write({ 'half.ts': TIDY })
    expect(run(r, 'git', 'commit', '-q', '-m', 'Half')).toContain(STYLE)
  }, 60_000)
})

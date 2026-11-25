import { spawnSync } from 'node:child_process'
import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gitEnv, runGit, tmp } from './fixtures/mkrepo.ts'

// In a commit, the committed hook's style step reads the files being committed
// and nothing else (`.githooks/pre-commit`): agents share one checkout, and
// over `.` one agent's half-written file failed every other agent's commit.
// Outside a commit (Tade's checks run it as `sh .githooks/pre-commit`) it
// still reads the whole tree.
//
// The repository here has no tsconfig, so a hook that got past its style step
// stops at types. Which step said it failed is the whole answer.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const STYLE = 'pre-commit: style and lint failed'
const TYPES = 'pre-commit: types failed'

/** A repository using this one's hooks and biome, with a tidy file and an untidy one. */
function repo(): string {
  const dir = tmp('tade-pre-commit-')
  runGit(dir, 'init', '-q', '-b', 'main')
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'))
  writeFileSync(join(dir, 'package.json'), '{ "private": true }\n')
  writeFileSync(join(dir, 'biome.json'), '{ "files": { "includes": ["*.ts"] } }\n')
  writeFileSync(join(dir, 'tidy.ts'), 'export const a = 1;\n')
  writeFileSync(join(dir, 'untidy.ts'), 'export   const b    =    2\n')
  runGit(dir, 'add', 'package.json', 'biome.json')
  runGit(dir, 'commit', '-q', '--no-verify', '-m', 'A first commit')
  runGit(dir, 'config', 'core.hooksPath', join(ROOT, '.githooks'))
  return dir
}

function run(dir: string, args: string[]): string {
  const env = gitEnv()
  delete env.GIT_INDEX_FILE
  return spawnSync(args[0] ?? '', args.slice(1), { cwd: dir, env, encoding: 'utf8' }).stderr
}

describe('the commit hook', () => {
  it('holds a commit to the style of the files it commits, not of the rest of the tree', () => {
    const dir = repo()
    // Somebody else has the untidy file staged: `--only` leaves it out.
    runGit(dir, 'add', 'tidy.ts', 'untidy.ts')
    const theirs = run(dir, ['git', 'commit', '-q', '-m', 'Tidy', '--only', '--', 'tidy.ts'])
    expect(theirs).not.toContain(STYLE)
    expect(theirs).toContain(TYPES)

    const mine = run(dir, ['git', 'commit', '-q', '-m', 'Untidy', '--only', '--', 'untidy.ts'])
    expect(mine).toContain(STYLE)
  }, 60_000)

  it('reads the whole tree when it is run outside a commit', () => {
    const dir = repo()
    expect(run(dir, ['sh', join(ROOT, '.githooks', 'pre-commit')])).toContain(STYLE)
  }, 60_000)
})

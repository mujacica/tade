import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync } from 'node:fs'
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
// The repository the style tests use has no tsconfig, so a hook that got past
// its style step stops at types, and none of their commits ever lands. Which
// step said it failed is the whole answer.
//
// Types, in a commit, check the whole project as it is being committed: the
// index written out with the installed packages lent to it, so another agent's
// half-done file fails nobody's commit but its own, and a change to a port
// still fails on the untouched file it breaks. The workspace here is two
// packages joined the way pnpm joins this one's, by a link in node_modules, so
// a lent link that reached the working tree's copy would be caught too.

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

const PORT = 'packages/port/src/index.ts'
const USER = 'packages/app/src/main.ts'
const NUMBER = 'export const answer = (): number => 42\n'
const STRING = 'export const answer = (): string => "42"\n'
const WRONG = 'export const half: number = "not yet"\n'

/** A two-package workspace with a tsconfig, whose app uses the port's `answer` as a number. */
function workspace(): Repo {
  const r = repo()
  r.write({
    // A smoke step that passes, so a commit the types let through lands.
    'package.json': '{ "private": true, "type": "module", "scripts": { "test:smoke": "true" } }\n',
    'tsconfig.json': `${JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ['packages/*/src'],
    })}\n`,
    'packages/port/package.json':
      '{ "name": "@x/port", "type": "module", "exports": "./src/index.ts" }\n',
    [PORT]: NUMBER,
    'packages/app/package.json': '{ "name": "@x/app", "type": "module" }\n',
    [USER]: 'import { answer } from "@x/port"\n\nexport const doubled: number = answer() * 2\n',
  })
  // As pnpm links a workspace package: relative, and never committed.
  mkdirSync(join(r.root, 'packages/app/node_modules/@x'), { recursive: true })
  symlinkSync('../../../port', join(r.root, 'packages/app/node_modules/@x/port'))
  r.git(
    'add',
    'package.json',
    'tsconfig.json',
    'packages/port/package.json',
    PORT,
    'packages/app/package.json',
    USER,
  )
  r.git('commit', '-q', '--no-verify', '-m', 'Workspace')
  return r
}

const commits = (r: Repo): number => Number(r.git('rev-list', '--count', 'HEAD').trim())

describe('the commit hook’s types', () => {
  it('are not failed by somebody else’s type error that is not in the commit', () => {
    const r = workspace()
    // Another agent's half-done work: a port changed under its user, and a
    // file that does not type-check yet. Neither is in this commit.
    r.write({ [PORT]: STRING, 'packages/app/src/half.ts': WRONG, 'packages/app/src/a.ts': TIDY })
    expect(run(r, 'sh', HOOK)).toContain(TYPES)
    const before = commits(r)
    r.git('add', 'packages/app/src/a.ts')
    const untracked = run(
      r,
      'git',
      'commit',
      '-q',
      '-m',
      'A',
      '--only',
      '--',
      'packages/app/src/a.ts',
    )
    expect(untracked).not.toContain(TYPES)
    expect(commits(r)).toBe(before + 1)

    // Staged by somebody else, it is still not in a commit `--only` names.
    r.git('add', 'packages/app/src/half.ts', PORT)
    r.write({ 'packages/app/src/b.ts': TIDY })
    r.git('add', 'packages/app/src/b.ts')
    const staged = run(r, 'git', 'commit', '-q', '-m', 'B', '--only', '--', 'packages/app/src/b.ts')
    expect(staged).not.toContain(TYPES)
    expect(commits(r)).toBe(before + 2)
  }, 60_000)

  it('fail a commit of a file with a type error', () => {
    const r = workspace()
    r.write({ 'packages/app/src/half.ts': WRONG })
    r.git('add', 'packages/app/src/half.ts')
    const before = commits(r)
    const failed = run(
      r,
      'git',
      'commit',
      '-q',
      '-m',
      'Half',
      '--only',
      '--',
      'packages/app/src/half.ts',
    )
    expect(failed).toContain(TYPES)
    expect(failed).toContain('packages/app/src/half.ts')
    expect(commits(r)).toBe(before)
  }, 60_000)

  it('fail a change to a port on the untouched file it breaks', () => {
    const r = workspace()
    r.write({ [PORT]: STRING })
    r.git('add', PORT)
    const before = commits(r)
    const failed = run(r, 'git', 'commit', '-q', '-m', 'Port', '--only', '--', PORT)
    expect(failed).toContain(TYPES)
    expect(failed).toContain(USER)
    expect(commits(r)).toBe(before)
  }, 60_000)
})

const SMOKE = 'pre-commit: smoke tests failed'
const PASSING = 'test/ok.test.mjs'
const BROKEN = 'test/half.test.mjs'

/**
 * The workspace, with smoke tests that are Node's test runner over `test/`.
 * The one committed test passes only where git can say it is tracked, as this
 * repository's own smoke tests ask `git ls-files` what the repository has.
 */
function smoked(): Repo {
  const r = workspace()
  r.write({
    'package.json':
      '{ "private": true, "type": "module", "scripts": { "test:smoke": "node --test \'test/*.test.mjs\'" } }\n',
    [PASSING]: [
      "import { execFileSync } from 'node:child_process'",
      "import { test } from 'node:test'",
      `test('is tracked', () => { execFileSync('git', ['ls-files', '--error-unmatch', '${PASSING}']) })`,
      '',
    ].join('\n'),
  })
  r.git('add', 'package.json', PASSING)
  r.git('commit', '-q', '--no-verify', '-m', 'Smoke')
  return r
}

/** A test that fails, as another agent's is while they are halfway through it. */
const HALF =
  "import { test } from 'node:test'\ntest('half', () => { throw new Error('not yet') })\n"

describe('the commit hook’s smoke tests', () => {
  it('are not failed by somebody else’s broken test that is not in the commit', () => {
    const r = smoked()
    r.write({ [BROKEN]: HALF, 'packages/app/src/a.ts': TIDY })
    // Run over the working tree, the broken test is found.
    expect(run(r, 'sh', HOOK)).toContain(SMOKE)
    const before = commits(r)
    r.git('add', 'packages/app/src/a.ts')
    const untracked = run(
      r,
      'git',
      'commit',
      '-q',
      '-m',
      'A',
      '--only',
      '--',
      'packages/app/src/a.ts',
    )
    expect(untracked).not.toContain(SMOKE)
    expect(commits(r)).toBe(before + 1)

    // Staged by somebody else, it is still not in a commit `--only` names.
    r.git('add', BROKEN)
    r.write({ 'packages/app/src/b.ts': TIDY })
    r.git('add', 'packages/app/src/b.ts')
    const staged = run(r, 'git', 'commit', '-q', '-m', 'B', '--only', '--', 'packages/app/src/b.ts')
    expect(staged).not.toContain(SMOKE)
    expect(commits(r)).toBe(before + 2)
  }, 60_000)

  it('fail a commit of a broken test', () => {
    const r = smoked()
    r.write({ [BROKEN]: HALF })
    r.git('add', BROKEN)
    const before = commits(r)
    const failed = run(r, 'git', 'commit', '-q', '-m', 'Half', '--only', '--', BROKEN)
    expect(failed).toContain(SMOKE)
    expect(commits(r)).toBe(before)
  }, 60_000)
})

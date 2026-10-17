import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path/posix'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { standInsIn } from './mocked-git.ts'

// git, answered by a test rather than asked.
//
// "Never mock git" is the guide's rule, and twice a verdict said a change had:
// 90e9c2d answered the branch watch's `rev-parse` and `log` from a table, so
// the detached checkout the watch was built for rested on git saying `HEAD`
// and nothing had ever seen it say so (made real in 22b6f39); 009851fb gave
// `doorbellFor` a repository reader so a test could hand it one that throws,
// a failure the real reader never has (taken back in 43cfee05). A judge found
// each after it was committed, and the rule had been in the guide all along.
//
// What a machine can see is what each test wrote: git's words. `standInsIn`
// (`./mocked-git.ts`) counts a test that asks whether its program is `'git'`
// and then, where it is, never hands it on, and a test that builds an `Error`
// saying git. Two files had a stand-in before this, so this is a ratchet:
// their number may go down and never up, and a test file not in ALLOWED is
// allowed none.
//
// What it cannot see:
//
// - **A stand-in that never asks.** `exec: async () => ({ code: 0, stdout:
//   'main\n', stderr: '' })` answers every program as git would, and nothing
//   in it says git.
// - **A made-up failure that does not say git.** A reader that resolves
//   `null`, or throws `not on this PATH`, is a function like any other; only
//   the default it replaces says what it stands for, and that is in `src`.
// - **More of a stand-in already allowed.** A new test in `review.test.ts`
//   that hands `gitLike` another answer is under the same one.
// - **Fakes that are not tests' files**: the `scripted` siblings and the
//   conformance suites under `src/`.
//
// It runs in `test:smoke`, which is what the commit hook runs.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const TABLE = 'test/mocked-git.test.ts'

/** A test's file: anything under a `test/` folder, fixtures and helpers included. */
const TEST = /(^|\/)test\/.*\.(ts|m?js)$/

/**
 * The mistakes as they were made, so this test can never pass by having
 * stopped looking, and the shapes they could as easily have had. Every one
 * must be counted, once.
 */
const MADE: Record<string, string> = {
  '90e9c2d packages/extensions/review/test/branch.test.ts': `
    function gitLike(options: { branch?: string; commit?: string; remote?: boolean } = {}) {
      return async (command: string, args: readonly string[]) => {
        const said = args.join(' ')
        if (command !== 'git') return { code: 1, stdout: '', stderr: 'no such command' }
        if (said.includes('remote.origin.url')) {
          return options.remote === false
            ? { code: 1, stdout: '', stderr: '' }
            : { code: 0, stdout: 'git@github.com:acme/api.git\\n', stderr: '' }
        }
        if (said.includes('rev-parse --abbrev-ref HEAD')) {
          return { code: 0, stdout: \`\${options.branch ?? 'main'}\\n\`, stderr: '' }
        }
        if (said.includes('log -1 --format=%H%n%s')) {
          return { code: 0, stdout: \`\${options.commit ?? RED}\\nretry refunds once\\n\`, stderr: '' }
        }
        return { code: 1, stdout: '', stderr: '' }
      }
    }`,
  '009851fb packages/app/test/wire/doorbell.test.ts': `
    const woke = await doorbellFor(wire, config, github, async () => {
      throw new Error('git is not on this PATH')
    })`,
  'git answered beside the replay': `
    const exec = async (command: string, args: readonly string[]) => {
      if (command === 'git' && args.includes('rev-parse')) return { code: 0, stdout: 'main\\n', stderr: '' }
      return replay.exec(command, args)
    }`,
  'git answered in a switch': `
    switch (program) {
      case 'git':
        return { code: 0, stdout: 'main\\n', stderr: '' }
      default:
        return run(program, args)
    }`,
  'a failure written as a template': `
    const read = () => Promise.reject(new Error(\`git exited 128 in \${root}\`))`,
}

/** The same tests as they were fixed, and the shapes that ask git. None is counted. */
const FIXED: Record<string, string> = {
  '22b6f39 git really run, and gh the replay': `
    exec: async (command: string, args: readonly string[]) =>
      command === 'gh' ? replay.exec(command, args) : reallyExec(command, args),`,
  'packages/extensions/intake/test/github.test.ts hands git to git': `
    const exec: ExtensionContext['exec'] = async (command, args) => {
      if (command === 'git') {
        try {
          const { stdout } = await run(command, [...args])
          return { code: 0, stdout, stderr: '' }
        } catch (err) {
          const said = err as { code?: number; stdout?: string; stderr?: string }
          return { code: said.code ?? 1, stdout: said.stdout ?? '', stderr: said.stderr ?? '' }
        }
      }
      return replay.exec(command, args)
    }`,
  'a spy that counts and hands on': `
    const exec = async (command: string, args: readonly string[]) => {
      if (command === 'git') gits += 1
      return reallyExec(command, args)
    }`,
  'what git really said, read back': `
    const repo = mkrepo()
    rmSync(join(repo.root, '.git'), { recursive: true })
    expect(await repositoryAt(repo.root)).toBeNull()
    expect(wire.state.notice).toContain('git could not say which repository it is')`,
  'an error that is not about git': `
    const read = async () => { throw new Error('the disk is full') }`,
}

/**
 * How many stand-ins for git each test file has. A number here may go DOWN
 * in the commit that earns it, and never up; a file that is not here is
 * allowed none.
 */
const ALLOWED: Record<string, number> = {
  // git answering from a table, as the review loop's tests were written before
  // anybody asked it of every change. 90e9c2d's `gitLike` was this one, copied.
  'packages/extensions/review/test/review.test.ts': 1,
  'packages/extensions/review/test/surfaces.test.ts': 1,
}

/** Repo-relative paths of every test's file git tracks. */
function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((path) => TEST.test(path))
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
    if ((problem as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw problem
  }
}

const counted = (source: string): number => standInsIn('probe.ts', source).length

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/** Thrown rather than expected, so the message arrives as it was written, saying what to do. */
function report(problems: string[]): void {
  if (problems.length > 0) throw new Error(`\n\n${problems.join('\n\n')}\n`)
}

describe('a test asks git rather than answering for it', () => {
  it('counts every one of the mistakes it was written against', () => {
    const missed = Object.entries(MADE).filter(([, source]) => counted(source) !== 1)
    expect(missed.map(([name]) => name)).toEqual([])
  })

  it('counts none of the tests that hand git on, or read back what it said', () => {
    const counts = Object.entries(FIXED).filter(([, source]) => counted(source) !== 0)
    expect(counts.map(([name]) => name)).toEqual([])
  })

  it('holds each test file to the stand-ins it already had', () => {
    const problems: string[] = []
    for (const path of tracked()) {
      const source = sourceOf(path)
      if (source === null) continue
      const found = standInsIn(path, source)
      const allowed = ALLOWED[path] ?? 0
      if (found.length <= allowed) continue
      const where = found.map((one) => `  ${path}:${one.line}  ${one.kind}`).join('\n')
      problems.push(
        `${path} stands in for git ${times(found.length)}, where it is allowed ${allowed}:\n${where}`,
      )
    }
    if (problems.length > 0)
      problems.push(
        'Ask git. Build the repository with `mkrepo` (test/fixtures/mkrepo.ts) and hand git on —\n' +
          "`command === 'gh' ? replay.exec(command, args) : reallyExec(command, args)` — and make a\n" +
          'failure real: a folder that is no repository, a PATH without git, `DIRC` over `.git/index`.\n' +
          'If git cannot be made to fail that way, the branch is one reality does not reach: take it\n' +
          'out rather than hold it with a test. There is no number to raise.',
      )
    report(problems)
  })

  it('keeps the numbers following the files down', () => {
    const problems: string[] = []
    for (const [path, allowed] of Object.entries(ALLOWED)) {
      const source = sourceOf(path)
      if (source === null) continue
      const found = standInsIn(path, source).length
      if (found < allowed)
        problems.push(
          `${path} stands in for git ${times(found)}, and ALLOWED (${TABLE}) still says ${allowed}.\n` +
            (found === 0 ? 'Delete its line' : `Lower it to ${found}`) +
            ' in the same commit: a number left above its file is room for the next one.',
        )
    }
    report(problems)
  })
})

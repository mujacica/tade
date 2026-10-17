import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The tests a change touches, and nothing else.
//
//   pnpm test:related                  what is not committed here: changed, added, untracked
//   pnpm test:related <path>…          the tests those paths touch
//   pnpm test:related --since <ref>    what changed since <ref>, committed or not
//
// Which tests is the import graph's answer (`vitest related`): a test file runs
// when it imports a changed file, however far down. Never a model's and never
// a judge's — a judge may only ever add caution, and choosing what not to run
// is the opposite of that. The same change always picks the same tests.
//
// It is the quick look for one agent's loop, and **never** the suite: a related
// run passing says the tests that import what changed passed, and nothing about
// a test that reads a file rather than importing it, so it is recorded as its
// own check (`related`) and no rollup ever counts it as `tests`. Where the
// full checks are batched (`checks.full`) the window runs the suite once a
// batch, on HEAD, and anything leaving the machine needs it green either way.
//
// What the graph cannot see is said rather than guessed at:
//
//  - A file every test runs under — the vitest config, its setup files, a
//    manifest, the lockfile, a tsconfig — touches every test, so the whole
//    suite runs (without the coverage floors, which are the `tests` check's).
//  - A deleted module has nothing left to import, so nothing in the graph
//    leads to its importers. The type checker does: `tsc` fails on an import of
//    a file that is gone, which is the commit hook's.
//  - A test that reads a file rather than importing it — the guide, the file
//    budgets, the notices, the pictures — is the commit hook's smoke run.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Paths every test runs under: touching one is touching all of them. */
const EVERYTHING = [
  /^vitest\.config\.ts$/,
  /^test\/(no-gui|own-home|one-suite)\.ts$/,
  /^package\.json$/,
  /^packages\/(?:[^/]+\/){1,2}package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig(\.[^/]*)?\.json$/,
]

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64_000_000 })
}

/** Uncommitted paths, both sides of a rename, and the untracked ones: `-z`, so any name survives. */
function uncommitted(): string[] {
  const out: string[] = []
  const fields = git(['status', '--porcelain=v2', '-z', '-uall']).split('\0')
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i] ?? ''
    if (record.startsWith('? ')) out.push(record.slice(2))
    else if (record.startsWith('1 ')) out.push(record.split(' ').slice(8).join(' '))
    else if (record.startsWith('2 ')) {
      out.push(record.split(' ').slice(9).join(' '))
      // A rename's original path is the next field.
      out.push(fields[++i] ?? '')
    } else if (record.startsWith('u ')) out.push(record.split(' ').slice(10).join(' '))
  }
  return out.filter(Boolean)
}

/** Everything that differs from `ref`, committed or not. */
function since(ref: string): string[] {
  const committed = git(['diff', '--name-only', '-z', ref]).split('\0').filter(Boolean)
  return [...new Set([...committed, ...uncommitted()])]
}

const args = process.argv.slice(2)
const at = args.indexOf('--since')
const ref = at >= 0 ? args[at + 1] : undefined
if (at >= 0 && !ref) {
  process.stderr.write('--since needs a ref: pnpm test:related --since HEAD~3\n')
  process.exit(2)
}
// Paths as whoever typed them meant them: from where they stood, which a
// package script is not (`INIT_CWD` is), and then from the repository root.
const typedIn = process.env.INIT_CWD ?? process.cwd()
const named = args
  .filter((arg, i) => !arg.startsWith('--') && (at < 0 || i !== at + 1))
  .map((arg) => relative(ROOT, resolve(typedIn, arg)))
const paths = [...new Set(named.length > 0 ? named : ref ? since(ref) : uncommitted())].sort()

if (paths.length === 0) {
  process.stdout.write('Nothing has changed here, so no test is related to a change.\n')
  process.exit(0)
}

const all = paths.find((path) => EVERYTHING.some((rule) => rule.test(path)))
const gone = paths.filter((path) => !existsSync(join(ROOT, path)))
const present = paths.filter((path) => existsSync(join(ROOT, path)))
const said = [
  all
    ? `${all} is something every test runs under, so every test is related: the whole suite runs, without the coverage floors.`
    : `${paths.length} changed ${paths.length === 1 ? 'path' : 'paths'}; the tests that import ${paths.length === 1 ? 'it' : 'them'} run.`,
  gone.length > 0
    ? `${gone.length} ${gone.length === 1 ? 'is' : 'are'} gone (${gone.slice(0, 3).join(', ')}${gone.length > 3 ? ', …' : ''}): what imported ${gone.length === 1 ? 'it' : 'them'} is the type checker's to catch — the commit hook runs it.`
    : '',
  'A test that reads a file rather than importing it is the commit hook’s smoke run, and everything else is the full suite’s.',
]
process.stdout.write(`${said.filter(Boolean).join('\n')}\n\n`)

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const run =
  all !== undefined
    ? ['run']
    : present.length === 0
      ? null
      : ['related', '--run', '--passWithNoTests', ...present]
if (run === null) process.exit(0)
const suite = spawn(process.execPath, [vitest, ...run], { cwd: ROOT, stdio: 'inherit' })
suite.on('exit', (code, signal) => process.exit(signal === null ? (code ?? 1) : 1))

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, globSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../vitest.config.ts'
import { Graph, testsReaching, workspaceAt } from './related-graph.ts'

// The tests a change touches, and nothing else.
//
//   pnpm test:related                  what is not committed here: changed, added, untracked
//   pnpm test:related <path>…          the tests those paths touch
//   pnpm test:related --since <ref>    what changed since <ref>, committed or not
//
// Which tests is the import graph's answer (`related-graph.ts`): a test file
// runs when it imports a changed file, however far down. Never a model's and
// never a judge's — a judge may only ever add caution, and choosing what not to
// run is the opposite of that. The same change always picks the same tests.
//
// It used to be `vitest related`, and that ran the whole suite for most
// changes: it reads the graph by file, so a test taking one name from a
// package's `index.ts` reached every file the package has; and it runs every
// test when anything `globalSetup` reaches changed, which through
// `test/one-suite.ts` was 140 files of core. 15 of 21 runs took over 100 s and
// most ran all 11,900 tests. The graph here follows a re-export only for the
// names asked of it, and `globalSetup` is read as what it is below.
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
//  - A file every test runs under — the vitest config, its setup files and
//    what they import, a manifest, the lockfile, a tsconfig, the temp root
//    `globalSetup` gives every test — touches every test, so the whole suite
//    runs (without the coverage floors, which are the `tests` check's).
//  - The rest of what `globalSetup` imports decides whether a run waits for the
//    machine, never what a test finds: a change there runs the tests that
//    import it, `one-suite.test.ts` among them, and a `globalSetup` broken by
//    it fails every run that loads it, loudly.
//  - A deleted module has nothing left to import, so nothing in the graph
//    leads to it. A test that still imports it runs (and fails), and `tsc`
//    fails on any other import of it, which is the commit hook's.
//  - A test that reads a file rather than importing it — the guide, the file
//    budgets, the notices, the pictures — is the commit hook's smoke run.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Paths every test runs under: touching one is touching all of them. */
const EVERYTHING = [
  /^vitest\.config\.ts$/,
  /^test\/(no-gui|own-home|one-suite|own-tmp)\.ts$/,
  // Any manifest, as vitest's own `forceRerunTriggers` has it.
  /(^|\/)package\.json$/,
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
const said = [
  all
    ? `${all} is something every test runs under, so every test is related: the whole suite runs, without the coverage floors.`
    : `${paths.length} changed ${paths.length === 1 ? 'path' : 'paths'}; the tests that import ${paths.length === 1 ? 'it' : 'them'} run.`,
  gone.length > 0
    ? `${gone.length} ${gone.length === 1 ? 'is' : 'are'} gone (${gone.slice(0, 3).join(', ')}${gone.length > 3 ? ', …' : ''}): a test that still imports ${gone.length === 1 ? 'it' : 'one'} runs, and any other import of ${gone.length === 1 ? 'it' : 'them'} is the type checker's to catch — the commit hook runs it.`
    : '',
  'A test that reads a file rather than importing it is the commit hook’s smoke run, and everything else is the full suite’s.',
]
process.stdout.write(`${said.filter(Boolean).join('\n')}\n\n`)

const tests = (config.test?.include ?? [])
  .flatMap((pattern) => globSync(pattern, { cwd: ROOT, exclude: ['**/node_modules/**'] }))
  .sort()
const setups = [config.test?.setupFiles ?? []]
  .flat()
  .map((file) => relative(ROOT, resolve(ROOT, file)))
const related =
  all !== undefined ? tests : testsReaching(new Graph(workspaceAt(ROOT)), tests, paths, setups)
if (all === undefined) {
  process.stdout.write(`${related.length} of ${tests.length} test files import what changed.\n\n`)
}
if (related.length === 0) process.exit(0)

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
// Absolute paths, because vitest reads each as a part of a path to match.
const run = all !== undefined ? ['run'] : ['run', ...related.map((test) => join(ROOT, test))]
const suite = spawn(process.execPath, [vitest, ...run], { cwd: ROOT, stdio: 'inherit' })
suite.on('exit', (code, signal) => process.exit(signal === null ? (code ?? 1) : 1))

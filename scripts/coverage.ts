import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type FileCoverage, FLOOR, measure, readCoverage, said } from './coverage-floors.ts'
import {
  BLOBS,
  blobName,
  blobSetProblem,
  durationLines,
  type JsonReport,
  SHARD_ENV,
  shardOf,
} from './shards.ts'

// The suite, and then what it left uncovered.
//
//   pnpm coverage            the suite with coverage, then the floors
//   pnpm coverage --table    …and print every package, not just what is wrong
//
// And in CI, split (`scripts/shards.ts` says how and why):
//
//   VITEST_SHARD=2/4 node scripts/coverage.ts
//                            one shard, written as a blob; no floors, since a
//                            quarter of the suite measured against whole-repo
//                            floors is red for reasons that are not a change
//   node scripts/coverage.ts --merge <dir>
//                            the shards' blobs merged, every file's duration,
//                            then the floors on the merged coverage
//
// This is what the `tests` check runs, so coverage is measured wherever the
// gate is: on your machine, in `pnpm check`, and in CI. It costs nothing —
// 111.6s with coverage against 111.8s without, which is noise — so there is no
// version of the suite that is "the one where we also look".
//
// Everything that decides anything is in `coverage-floors.ts`, which has no
// machine under it and is held to its cases by `test/coverage-floors.test.ts`. What is
// here is the running and the printing.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Where the report lands. `coverage/` is already ignored. */
const REPORT = 'coverage/coverage-final.json'

/** Repo-relative paths of every `.ts` file git tracks under `packages/`. */
function tracked(): Set<string> {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'packages'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return new Set(out.split('\0').filter((path) => path.endsWith('.ts')))
}

/** Read the report and hold the repository to the tables. Exits 1 on a problem. */
function gate(reportPath: string, showTable: boolean): void {
  let raw: string
  try {
    raw = readFileSync(reportPath, 'utf8')
  } catch {
    process.stdout.write(
      `\nNo coverage report at ${reportPath}.\n` +
        'The suite has to run with coverage for there to be one: `pnpm coverage`.\n\n',
    )
    process.exit(1)
  }
  const report = JSON.parse(raw) as Record<string, FileCoverage>
  const read = readCoverage(measure(report, ROOT), tracked())

  if (showTable) {
    const width = Math.max(...read.rows.map((row) => row.pkg.length))
    process.stdout.write(`\n${'package'.padEnd(width)}   lines   floor    files\n`)
    for (const row of read.rows)
      process.stdout.write(
        `${row.pkg.padEnd(width)}  ${said(row.coverage).padStart(6)}  ` +
          `${String(FLOOR[row.pkg] ?? '—').padStart(6)}  ${String(row.files).padStart(7)}\n`,
      )
  }

  if (read.problems.length > 0) {
    process.stdout.write(`\n${read.problems.join('\n\n')}\n\n`)
    process.exit(1)
  }
  process.stdout.write(
    `\ncoverage: ${said(read.coverage)}% of ${read.lines.toLocaleString('en-US')} lines, ` +
      `every floor met in ${read.rows.length} packages\n`,
  )
}

const args = process.argv.slice(2)
const showTable = args.includes('--table')
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
// `fileURLToPath` and not `.pathname`, which percent-encodes: a checkout in a
// folder with a space in it would look for a report nothing wrote.
const report = fileURLToPath(new URL(`../${REPORT}`, import.meta.url))

/** Run vitest with these arguments, then this with its exit code (1 where a signal ended it). */
function suite(vitestArgs: string[], then: (code: number) => void): void {
  const child = spawn(process.execPath, [vitest, ...vitestArgs], { cwd: ROOT, stdio: 'inherit' })
  child.on('exit', (code, signal) => then(signal === null ? (code ?? 1) : 1))
}

// `--report <path>` gates an existing report instead of running the suite,
// which is how anybody working on these files gets an answer in a second
// rather than in two minutes.
const given = args.indexOf('--report')
const merging = args.indexOf('--merge')
const shard = shardOf(process.env[SHARD_ENV])
if (given >= 0) {
  gate(args[given + 1] ?? REPORT, showTable)
} else if (merging >= 0) {
  const dir = resolve(ROOT, args[merging + 1] ?? BLOBS)
  let problem: string | null
  try {
    problem = blobSetProblem(readdirSync(dir))
  } catch (err) {
    problem = `it could not be read (${(err as NodeJS.ErrnoException).code ?? String(err)}).`
  }
  if (problem) {
    process.stdout.write(`\nNothing merged from ${dir}: ${problem}\n\n`)
    process.exit(1)
  }
  // Beside the blobs and not in `coverage/`, which the merge empties first.
  const durations = join(ROOT, `${BLOBS}-durations.json`)
  // An earlier merge's report read as this one's would name the wrong times.
  rmSync(durations, { force: true })
  suite(
    [
      `--merge-reports=${dir}`,
      '--coverage.enabled',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${durations}`,
    ],
    (code) => {
      let read: JsonReport | null = null
      try {
        read = JSON.parse(readFileSync(durations, 'utf8')) as JsonReport
      } catch {
        process.stdout.write(`\nNo per-file durations: vitest wrote no report at ${durations}.\n`)
      }
      if (read) process.stdout.write(`\n${durationLines(read, ROOT).join('\n')}\n`)
      // Either saying a test failed is enough: the merge's exit, or its report.
      if (code !== 0 || read?.success === false) process.exit(code || 1)
      gate(report, showTable)
    },
  )
} else if (typeof shard === 'string') {
  process.stdout.write(`\n${shard}\n\n`)
  process.exit(1)
} else if (shard) {
  mkdirSync(join(ROOT, BLOBS), { recursive: true })
  suite(
    [
      'run',
      '--coverage.enabled',
      `--shard=${shard.index}/${shard.total}`,
      '--reporter=default',
      '--reporter=blob',
      `--outputFile.blob=${join(BLOBS, blobName(shard))}`,
    ],
    (code) => process.exit(code),
  )
} else {
  suite(['run', '--coverage.enabled'], (code) => {
    // A coverage number off a suite that did not pass is a number about which
    // tests ran, so it is not reported at all: the failures above are the news.
    if (code !== 0) process.exit(code)
    gate(report, showTable)
  })
}

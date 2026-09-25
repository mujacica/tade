import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type FileCoverage, FLOOR, measure, readCoverage, said } from './coverage-floors.ts'

// The suite, and then what it left uncovered.
//
//   pnpm coverage            the suite with coverage, then the floors
//   pnpm coverage --table    …and print every package, not just what is wrong
//
// This is what the `tests` check runs, so coverage is measured wherever the
// gate is: on your machine, in `pnpm check`, and in CI. It costs nothing —
// 111.6s with coverage against 111.8s without, which is noise — so there is no
// version of the suite that is "the one where we also look".
//
// Everything that decides anything is in `coverage-floors.ts`, which has no
// machine under it and is held to its cases by `test/coverage.test.ts`. What is
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
// `--report <path>` gates an existing report instead of running the suite,
// which is how anybody working on these files gets an answer in a second
// rather than in two minutes.
const given = args.indexOf('--report')
if (given >= 0) {
  gate(args[given + 1] ?? REPORT, showTable)
} else {
  const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
  const suite = spawn(process.execPath, [vitest, 'run', '--coverage.enabled'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  suite.on('exit', (code, signal) => {
    // A coverage number off a suite that did not pass is a number about which
    // tests ran, so it is not reported at all: the failures above are the news.
    if (code !== 0 || signal !== null) process.exit(code ?? 1)
    // `fileURLToPath` and not `.pathname`, which percent-encodes: a checkout in
    // a folder with a space in it would look for a report nothing wrote.
    gate(fileURLToPath(new URL(`../${REPORT}`, import.meta.url)), showTable)
  })
}

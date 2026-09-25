// What each package has to cover, and what this cannot see.
//
// The tables and the rules, with nothing under them: no clock, no filesystem,
// no child process. `scripts/coverage.ts` runs the suite and hands what it
// measured to `readCoverage` here, and `test/coverage-floors.test.ts` hands it made-up
// readings and checks that each rule fires — which is the whole reason the two
// are apart. A gate is exactly the sort of thing that fails by quietly doing
// nothing, and a gate that runs the suite on import is a gate nothing can test.
// It is the `notices.ts` / `notices-stamp.ts` split, for the same reason.
//
// **Why a floor per package and not one number for the repository.** A single
// percentage hides the thing worth knowing. `packages/core` is pure functions
// of what they are handed and is at 97%; what is left of `packages/cli` once
// the program itself is taken out is at 65%. Added together they are 88%,
// which is true of nothing and answers no question anybody has. Worse, one
// number can be held up by the cheap half of the repository while the
// expensive half falls, and nothing says so. So: a floor each, at what that
// package already does, and a package that slips is named.
//
// **What this cannot do.** It counts lines that ran. A test that executes a
// function and asserts nothing raises every number here, and is worse than no
// test at all, because it makes this file lie. Nothing mechanical can tell the
// two apart — so the rule is a rule for people: never write a test to move a
// number in this file. If a floor is in the way, the honest moves are to cover
// the thing properly, or to say in the commit message why it is not worth
// covering and lower it.
//
// The shape is `test/modularity.test.ts`'s, deliberately, because it is the
// same kind of rule: one table, checked in, and a ratchet. The direction is the
// mirror of it — a line budget may only go down, a coverage floor may only go
// up.
//
// Nothing here can quietly stop working, which is the failure a gate is most
// likely to have: a package the report never reached is a named problem, an
// excluded file the report never mentioned is a named problem, and an excluded
// file that turns out to be measurable is a named problem too. There is no
// answer this returns that looked at nothing and called it fine.

const TABLE = 'scripts/coverage-floors.ts'

/**
 * What each package must cover, in percent of lines that ran.
 *
 * A number here may go UP in the commit that earns it, and never down without
 * a reason in the commit message. Each is set at or just under what that
 * package covers today — one to two points under, which is margin for a
 * machine that takes a different branch, not room to lose work in.
 *
 * Read the low end as a map of where the tests are not: the ones at the top
 * are the ones that spawn something real and are hardest to reach, and each of
 * them has a note saying what is uncovered inside it.
 */
export const FLOOR: Record<string, number> = {
  // What is left of the CLI once the program itself is taken out (see UNSEEN):
  // `commands/voice.ts` and `telemetry.ts` are the two with real gaps.
  'packages/cli': 70,
  // The watch that reads a forge's checks, and the fixing it starts: what is
  // left is the fixing, which starts an agent.
  'packages/extensions/review': 74,
  'packages/harnesses/claude': 77,
  'packages/orchestrator': 77,
  // `src/wire/` is the hole and everything else here is over 89%: the pure
  // layers (`view/` at 97%) are what the goldens hold, and the wiring is what
  // reaches lanes, files and the machine.
  'packages/app': 82,
  'packages/harnesses/codex': 83,
  'packages/extensions/sentry': 84,
  // Went up when `checks_propose` went: what a project checks is read from its
  // own CI and its own hook, so the tool that wrote it down had nothing left to
  // write, and the branchy half of this extension left with it.
  'packages/extensions/checks': 89,
  'packages/forges/scripted': 86,
  'packages/workbench': 86,
  'packages/harnesses/pi': 89,
  'packages/status': 89,
  'packages/forges/github': 90,
  'packages/mcp/http': 90,
  'packages/extensions/deps': 91,
  'packages/mcp/stdio': 91,
  'packages/drivers/tmux': 92,
  'packages/voice/tts': 92,
  'packages/drivers/pty': 93,
  'packages/extensions/core': 93,
  'packages/extensions/resources': 93,
  'packages/extensions/jev': 94,
  'packages/judges/jev': 94,
  'packages/mcp/broker': 94,
  'packages/voice/core': 94,
  'packages/core': 95,
  'packages/forges/core': 95,
  'packages/judges/core': 95,
  'packages/voice/stt': 95,
  'packages/checks/core': 96,
  'packages/harnesses/core': 96,
  'packages/checks/scripted': 97,
  'packages/drivers/core': 97,
  'packages/mcp/core': 97,
  'packages/telemetry': 98,
  'packages/checks/local': 99,
  'packages/judges/scripted': 99,
  'packages/mcp/scripted': 99,
}

/**
 * Packages whose coverage is a fact about the machine as well as about the
 * tests, and so have no one reading a ratchet can hold them to.
 *
 * `harnesses/claude/test/live-lane.test.ts` and
 * `orchestrator/test/claude.test.ts` are `describe.runIf(claude)`: they drive
 * the real Claude Code binary where it is on the machine and are skipped where
 * it is not. That is the right test to have — a harness nobody proved can
 * drive the program it adapts is a harness nobody should ship — and it means
 * `harnesses/claude` reads about 79% on a runner with no Claude Code and about
 * 93% on the laptop of somebody who works on Tade. The floor is the lower one,
 * because a floor has to be true everywhere; the slack rule is skipped, because
 * on half the machines that run it the slack is fourteen points and is nobody's
 * to close.
 *
 * `orchestrator`'s spread is two points rather than fourteen, and it is here
 * for the same reason rather than a smaller one: a floor that has to sit inside
 * a two-point window between what a runner reads and what a laptop does is a
 * floor that goes red on somebody the first time either end moves.
 */
export const MOVES: Record<string, string> = {
  'packages/harnesses/claude': 'its live-lane tests run only where Claude Code is installed',
  'packages/orchestrator': 'claude.test.ts runs only where Claude Code is installed',
}

/**
 * Files this cannot see, and why. Each only ever runs in another process, so
 * the coverage collected here — which is of the vitest worker — reads zero
 * however well it is tested.
 *
 * Excluding one is not a claim that it is covered. It is a claim that the
 * number would say nothing, which is worse than no number: a floor computed
 * over a file the instrument cannot see is a floor that measures the
 * instrument. Where a file here has no test at all that is a hole, and it is
 * named as one in the commit that put it here, because this list is about what
 * can be measured and not about what was.
 *
 * The list cannot rot: an excluded file that shows a covered line fails the
 * gate, because something imports it now and its line here is what stops that
 * counting.
 *
 * What would change it: run the children under `NODE_V8_COVERAGE` and merge
 * what they write into the report. That is real work and it is worth doing —
 * it is 1,536 lines of the CLI, driven by twenty test files, currently
 * invisible.
 */
export const UNSEEN: Record<string, string> = {
  // The `tade` program. Its tests drive it the way a person does — sixteen of
  // the twenty files in `packages/cli/test` spawn `bin.ts` and read what it
  // printed and what it exited with — which is the right test for a program
  // whose exit codes and stdio are the thing under test, and is invisible from
  // inside a worker. What stays measured is the CLI's modules: `native.ts`,
  // `node.ts`, `io.ts`, `version.ts`, `telemetry.ts`, `commands/voice.ts` and
  // `commands/setup-machine.ts` are all imported directly by a test.
  'packages/cli/src/bin.ts': 'the binary',
  'packages/cli/src/program.ts': 'builds the program the binary runs',
  'packages/cli/src/attach.ts': 'puts a real terminal in raw mode',
  'packages/cli/src/format.ts': 'prints for `tade status`, which its test runs as a process',
  'packages/cli/src/with-workbench.ts': 'wraps a command in an open workbench',
  'packages/cli/src/commands/accounts.ts': 'a command of the binary',
  'packages/cli/src/commands/app.ts': 'a command of the binary',
  'packages/cli/src/commands/brief.ts': 'a command of the binary',
  'packages/cli/src/commands/chat.ts': 'a command of the binary',
  'packages/cli/src/commands/check.ts': 'a command of the binary',
  'packages/cli/src/commands/checks.ts': 'a command of the binary',
  'packages/cli/src/commands/config.ts': 'a command of the binary',
  'packages/cli/src/commands/lanes.ts': 'a command of the binary',
  'packages/cli/src/commands/mcp.ts': 'a command of the binary',
  'packages/cli/src/commands/notes.ts': 'a command of the binary',
  'packages/cli/src/commands/proposals.ts': 'a command of the binary',
  'packages/cli/src/commands/schedules.ts': 'a command of the binary',
  'packages/cli/src/commands/setup.ts': 'a command of the binary',
  'packages/cli/src/commands/setup-facts.ts': 'a command of the binary',
  'packages/cli/src/commands/spend.ts': 'a command of the binary',
  'packages/cli/src/commands/summary.ts': 'a command of the binary',
  'packages/cli/src/commands/tasks.ts': 'a command of the binary',
  'packages/cli/src/commands/update.ts': 'a command of the binary',

  // Programs somebody else starts. Each is a path handed to a spawn —
  // `REAPER_PATH`, `HOOK_PATH`, `MCP_PATH`, `TOOLS_MCP`, `secretCommand` — and
  // importing one runs it, which is why no test can hold one in its own
  // process. Two of them are driven for real by a test that spawns them
  // (`tools-mcp.test.ts`, and `print-secret` through `accounts.test.ts`); the
  // five that Claude Code and Codex run have no test at all, which is a hole
  // and not something this list closes.
  'packages/core/src/print-secret.ts': 'run by a program asking for its key',
  'packages/orchestrator/src/tools-mcp.ts': "Tade's tools, served to a harness over stdio",
  'packages/harnesses/claude/src/hook.ts': 'run by Claude Code, once per hook',
  'packages/harnesses/claude/src/mcp.ts': 'run by Claude Code for the life of a session',
  'packages/harnesses/claude/src/statusline.ts': 'run by Claude Code after every reply',
  'packages/harnesses/codex/src/hook.ts': 'run by Codex, once per hook',
  'packages/harnesses/codex/src/mcp.ts': 'run by Codex for the life of a session',
  'packages/harnesses/core/src/reaper.ts': 'runs between Tade and a headless harness',
}

/**
 * How far above a floor a package's coverage may sit before the floor is asked
 * to follow it up. The half that makes the ratchet work: without it the
 * numbers stay at the day they were written and the table becomes decoration.
 *
 * Four points rather than one, because a floor is set one to two points under
 * to begin with, and because a package of a hundred lines moves a point at a
 * time.
 */
export const SLACK = 4

/** One file as the v8 provider reports it: where each statement is, and its hits. */
export interface FileCoverage {
  statementMap: Record<string, { start: { line: number } }>
  s: Record<string, number>
}

/** One file's lines, counted. */
export interface Measured {
  /** Repo-relative, the way both tables spell a path. */
  path: string
  lines: number
  covered: number
}

/** One package's row. */
export interface Row {
  pkg: string
  lines: number
  covered: number
  files: number
  coverage: number
}

/** What the gate found: the rows to draw, and everything wrong with them. */
export interface Read {
  rows: Row[]
  problems: string[]
  lines: number
  covered: number
  coverage: number
}

/**
 * Which package a source file belongs to: `packages/<a>` or `packages/<a>/<b>`,
 * whichever holds the `src/` it is under. Null for anything else.
 */
export function packageOf(path: string): string | null {
  const nested = /^(packages\/[^/]+\/[^/]+)\/src\//.exec(path)
  if (nested) return nested[1] ?? null
  const flat = /^(packages\/[^/]+)\/src\//.exec(path)
  return flat?.[1] ?? null
}

/**
 * Lines that ran, out of lines there are, the way istanbul counts them: a
 * statement lands on the line it starts at, and a line ran if anything on it
 * did. Not the count of statements — two statements on one line is one line,
 * and a percentage per statement reads differently for no reason anybody asked
 * about.
 *
 * `root` is stripped off the absolute paths the report holds, so everything
 * downstream spells a path the way the tables do.
 */
export function measure(report: Record<string, FileCoverage>, root: string): Measured[] {
  return Object.entries(report).map(([absolute, file]) => {
    const hits = new Map<number, number>()
    for (const [id, where] of Object.entries(file.statementMap)) {
      const line = where.start.line
      hits.set(line, Math.max(hits.get(line) ?? 0, file.s[id] ?? 0))
    }
    return {
      path: absolute.startsWith(root) ? absolute.slice(root.length) : absolute,
      lines: hits.size,
      covered: [...hits.values()].filter((count) => count > 0).length,
    }
  })
}

const pct = (covered: number, lines: number): number =>
  lines === 0 ? 100 : (100 * covered) / lines

/** `81.0`, always one place, because two is noise and none is a rounded lie. */
export const said = (n: number): string => n.toFixed(1)

/**
 * The whole gate: the rows, and every problem already saying what to do about
 * it. A coverage gate that says only that a number moved teaches nobody.
 *
 * `tracked` is what git has, and is used for one thing: telling a file that
 * moved from a file that is gone, so the two get different advice.
 */
export function readCoverage(measured: readonly Measured[], tracked: ReadonlySet<string>): Read {
  const problems: string[] = []
  const by = new Map<string, Row>()
  const seen = new Set<string>()

  for (const file of measured) {
    seen.add(file.path)
    if (file.path in UNSEEN) {
      if (file.covered > 0)
        problems.push(
          `${file.path} is excluded as unmeasurable, and ${file.covered} of its ${file.lines} lines ran.\n` +
            'Something imports it now, so it can be measured: delete its line from UNSEEN\n' +
            `(${TABLE}) and let its package's floor account for it.`,
        )
      continue
    }
    const pkg = packageOf(file.path)
    if (pkg === null) continue
    const row = by.get(pkg) ?? { pkg, lines: 0, covered: 0, files: 0, coverage: 0 }
    row.lines += file.lines
    row.covered += file.covered
    row.files += 1
    by.set(pkg, row)
  }
  for (const row of by.values()) row.coverage = pct(row.covered, row.lines)

  // A file the report never mentioned is one `coverage.include` no longer
  // reaches — a rule that quietly stopped applying, which is the thing this
  // whole file is against.
  for (const path of Object.keys(UNSEEN)) {
    if (seen.has(path)) continue
    problems.push(
      tracked.has(path)
        ? `UNSEEN names ${path}, which the coverage report does not mention.\n` +
            'Either `coverage.include` in vitest.config.ts no longer reaches it, or it moved.\n' +
            `Point its line in ${TABLE} at where it went.`
        : `UNSEEN names ${path}, which this repository does not have.\n` +
            `Delete its line from ${TABLE}.`,
    )
  }

  const rows = [...by.values()].sort((a, b) => a.coverage - b.coverage)
  for (const row of rows) {
    const floor = FLOOR[row.pkg]
    if (floor === undefined) {
      problems.push(
        `${row.pkg} covers ${said(row.coverage)}% of its lines and FLOOR does not name it.\n` +
          `Give it a line in FLOOR (${TABLE}) at ${Math.floor(row.coverage - 1)} — at or just\n` +
          'under what it does today. Every package has a floor; that is what makes a new one\n' +
          'a decision rather than a gap.',
      )
      continue
    }
    if (row.coverage < floor) {
      problems.push(
        `${row.pkg} covers ${said(row.coverage)}% of its lines, under its floor of ${floor}.\n` +
          'Cover what this change left behind — and cover it with a test that asserts\n' +
          'something, because a test written to move this number is worse than none.\n' +
          `If the floor is wrong, lower it in FLOOR (${TABLE}) and say why in the commit\n` +
          'message: a floor may go UP in the commit that earns it, and going down is an\n' +
          'argument somebody has to make.',
      )
      continue
    }
    if (row.pkg in MOVES) continue
    if (row.coverage - floor > SLACK)
      problems.push(
        `${row.pkg} covers ${said(row.coverage)}% of its lines and its floor says ${floor} — ` +
          `${said(row.coverage - floor)} points of slack.\n` +
          `Raise it to ${Math.floor(row.coverage - 1)} in this commit (FLOOR, ${TABLE}). This is the ratchet:\n` +
          'the table only holds while the floors follow the coverage up.',
      )
  }

  for (const pkg of Object.keys(FLOOR)) {
    if (by.has(pkg)) continue
    problems.push(
      `FLOOR names ${pkg}, which has no source the coverage report reached.\n` +
        `Delete its line from ${TABLE}, or point it at where that package went.`,
    )
  }

  const lines = rows.reduce((sum, row) => sum + row.lines, 0)
  const covered = rows.reduce((sum, row) => sum + row.covered, 0)
  return { rows, problems, lines, covered, coverage: pct(covered, lines) }
}

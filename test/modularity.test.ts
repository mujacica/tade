import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path/posix'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

// Why a file is allowed to be the size it is.
//
// `app.ts` reached 8,635 lines while the skill that describes it said, in
// prose, that it should be wiring only — because prose does not fail a build,
// and because there was never a moment at which adding the fortieth subject to
// it was visibly a decision. A line count cannot tell logic from wiring. What
// it can do is make that moment visible: a file crossing 800 lines becomes a
// conversation, and `app.ts` reaching 8,635 was never once a conversation.
//
// So: one table, checked in, and a ratchet. The numbers are today's, and they
// may only go down. Giving a file a line of its own is how it gets to be big —
// and arguing for that line in review is the whole of what this test is for.
//
// It runs in `test:smoke`, which is what the commit hook runs: the answer
// arrives while the change is still being made, not an hour later in CI.
//
// The plan the numbers came from is `docs/modularity.md` §7. This test was
// installed before the files moved, deliberately — a ratchet installed after
// the refactor protects nothing that happened before it.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * What each file is allowed to be. A number here may go DOWN in the commit that
 * earns it, and never up. Adding a file to this table is how a file gets big;
 * doing that in review is the conversation this test exists to force.
 */
const BUDGET: Record<string, number> = {
  'packages/app/src/app.ts': 8_700,
  'packages/app/src/live.ts': 1_300,
  'packages/app/src/model.ts': 2_000,
  'packages/app/src/panel-view.ts': 4_300,
  'packages/app/src/panels.ts': 3_300,
  'packages/app/src/screen.ts': 900,
  'packages/app/src/view.ts': 4_300,
  'packages/app/test/app.test.ts': 3_000,
  'packages/app/test/model.test.ts': 1_100,
  'packages/app/test/panels.test.ts': 1_400,
  'packages/app/test/screens/scenarios.ts': 3_500,
  'packages/app/test/view.test.ts': 1_500,
  'packages/core/src/settings.ts': 1_200,
  'packages/drivers/tmux/src/index.ts': 900,
  'packages/extensions/core/src/host.ts': 1_500,
  'packages/extensions/core/test/host.test.ts': 1_000,
  'packages/extensions/jev/src/extension.ts': 1_400,
  'packages/extensions/jev/test/jev.test.ts': 1_100,
  'packages/extensions/review/src/extension.ts': 1_200,
  'packages/harnesses/claude/src/adapter.ts': 1_600,
  'packages/harnesses/codex/src/adapter.ts': 1_700,
  'packages/harnesses/pi/src/adapter.ts': 1_100,
  'packages/orchestrator/src/tools-extension.ts': 1_000,
  'packages/workbench/src/workbench.ts': 2_500,
  'packages/workbench/src/workers.ts': 1_100,
  'packages/workbench/test/workers.test.ts': 1_000,
}

/** Anything not named above. This is the real rule; the table is the exceptions. */
const DEFAULT = 800

/**
 * How far above a file a budget may sit. The half that makes the ratchet work:
 * without it the numbers stay at today's levels forever and the table becomes
 * decoration.
 */
const SLACK = 150

const TABLE = 'test/modularity.test.ts'

/** Repo-relative paths of every `.ts` file git tracks under `packages/`. */
function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'packages'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.endsWith('.ts'))
}

/**
 * How long a file is, or `null` when it is not on disk.
 *
 * Four agents share this checkout, so a file git tracks and nobody has is a
 * deletion somebody has not committed yet — not a file that got too big.
 * Counted the way `wc -l` counts: a trailing newline ends the last line rather
 * than starting another.
 */
function lengthOf(path: string): number | null {
  let text: string
  try {
    text = readFileSync(join(ROOT, path), 'utf8')
  } catch {
    return null
  }
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** `8635` → `8,635`, because a five-figure line count read as digits is a blur. */
const said = (n: number): string => n.toLocaleString('en-US')

/**
 * The assertion, for all of it: nothing to report is the test passing.
 *
 * Thrown rather than expected, because vitest prints a thrown message as it was
 * written and a diff of two long strings does not read. A budget test that says
 * only that a number went up teaches nobody, so every problem gathered here
 * arrives already saying what to do about it.
 */
function report(problems: string[]): void {
  if (problems.length > 0) throw new Error(`\n\n${problems.join('\n\n')}\n`)
}

describe('every file is within its budget', () => {
  it('holds each file to its line, or to the default', () => {
    const problems: string[] = []
    for (const path of tracked()) {
      const lines = lengthOf(path)
      if (lines === null) continue
      const budget = BUDGET[path]
      if (budget === undefined) {
        if (lines > DEFAULT)
          problems.push(
            `${path} is ${said(lines)} lines, ${said(lines - DEFAULT)} over the default of ${said(DEFAULT)}.\n` +
              `Split it — or give it a line in BUDGET (${TABLE}) and say in the commit message why\n` +
              'this file is one that gets to be big. Adding a file to that table is the conversation.',
          )
        continue
      }
      if (lines > budget)
        problems.push(
          `${path} is ${said(lines)} lines, ${said(lines - budget)} over its budget of ${said(budget)}.\n` +
            `Split it, or lower a number somewhere else and say why. A number in BUDGET (${TABLE})\n` +
            'may go DOWN in the commit that earns it, and never up.',
        )
    }
    report(problems)
  })

  it('keeps the numbers following the files down', () => {
    const problems: string[] = []
    for (const [path, budget] of Object.entries(BUDGET)) {
      const lines = lengthOf(path)
      if (lines === null) continue
      if (lines <= DEFAULT) {
        problems.push(
          `${path} is ${said(lines)} lines, inside the default of ${said(DEFAULT)}.\n` +
            `Delete its line from BUDGET (${TABLE}). The table is for files allowed to be bigger\n` +
            'than the default, and this one no longer is.',
        )
        continue
      }
      if (budget - lines > SLACK)
        problems.push(
          `${path} is ${said(lines)} lines and its budget says ${said(budget)} — ${said(budget - lines)} lines of slack.\n` +
            `Lower it in this commit, to around ${said(lines + SLACK)} or less. This is the ratchet: the\n` +
            'table only holds while the numbers follow the files down.',
        )
    }
    report(problems)
  })

  it('names no file this repository does not have', () => {
    // Not "not on disk" — that is somebody else's uncommitted deletion. A file
    // git has never heard of is a line in the table that outlived its file.
    const known = new Set(tracked())
    const gone = Object.keys(BUDGET).filter((path) => !known.has(path))
    report(
      gone.map(
        (path) =>
          `BUDGET names ${path}, which this repository does not have.\nDelete its line from ${TABLE}.`,
      ),
    )
  })
})

// The two import rules. Both are string checks over what git tracks, like
// `source.test.ts` — milliseconds, so they can live in the smoke suite.

const APP = 'packages/app/src/app.ts'
const WIRE = 'packages/app/src/wire/'

/** Where a `from '…'` / `import('…')` in this file points, repo-relative. */
function importsOf(path: string, text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const spec = match[1]
    if (spec === undefined) continue
    out.push(spec.startsWith('.') ? join(dirname(path), spec) : spec)
  }
  return out
}

function textOf(path: string): string | null {
  try {
    return readFileSync(join(ROOT, path), 'utf8')
  } catch {
    return null
  }
}

describe('app.ts is wiring', () => {
  // `app.ts` imports `wire/*`; no `wire/*` imports `app.ts`. This is the rule
  // the skill has always stated in prose, made mechanical, and it is the single
  // check that would have prevented `app.ts` from reaching 8,635 lines.
  //
  // `wire/` does not exist yet — it arrives in slices 7 and 8 of
  // `docs/modularity.md`. The rule is installed first on purpose, so that the
  // first file put there is already held to it. Until then this passes over an
  // empty list, which is the correct answer and not an absent one.
  it('is never imported back by the subjects it wires up', () => {
    const problems: string[] = []
    for (const path of tracked()) {
      if (!path.startsWith(WIRE)) continue
      const text = textOf(path)
      if (text === null) continue
      if (importsOf(path, text).includes(APP))
        problems.push(
          `${path} imports ${APP}.\n` +
            'The arrow only points one way: `app.ts` imports `wire/*`, and a subject in `wire/`\n' +
            'never reaches back for the window. Whatever it needs belongs in its own fields, or on\n' +
            'the context it is handed — not on `App`.',
        )
    }
    report(problems)
  })
})

/**
 * The files that are a pure function of what they are handed.
 *
 * All of them pass today; this pins a property the repo already has and nothing
 * currently defends. `view/*`, `panels/*` and the panel halves that will land
 * under them are covered by prefix, so the rule arrives with the files rather
 * than after them.
 */
const PURE = [
  'packages/app/src/frame.ts',
  'packages/app/src/hits.ts',
  'packages/app/src/layout.ts',
  'packages/app/src/model.ts',
  // `panel-view.ts` is the drawing half of the panels, and dissolves into
  // `panels/<name>/` with the rest of them. Both halves are pure; both stay so.
  'packages/app/src/panel-view.ts',
  'packages/app/src/panels.ts',
  'packages/app/src/plan-graph.ts',
  'packages/app/src/scroll.ts',
  'packages/app/src/scrollbar.ts',
  'packages/app/src/skin.ts',
  'packages/app/src/spend.ts',
  'packages/app/src/ui.ts',
  'packages/app/src/view.ts',
]

const PURE_UNDER = ['packages/app/src/view/', 'packages/app/src/panels/']

/**
 * What a pure file may not contain, and what to do instead.
 *
 * `new Date()` and not `new Date`: a date built from a moment it was handed
 * (`new Date(at)`) is pure, and `view.ts` does exactly that. What is banned is
 * reading the clock.
 */
const IMPURE: { what: string; pattern: RegExp; instead: string }[] = [
  {
    what: "from 'node:",
    pattern: /from 'node:/,
    instead: 'the machine belongs to the caller; take what you need as an argument',
  },
  {
    what: 'Date.now()',
    pattern: /\bDate\.now\(\)/,
    instead: 'take `now` as an argument, the way `deriveState` does',
  },
  {
    what: 'new Date()',
    pattern: /\bnew Date\(\)/,
    instead: 'take the moment as an argument — `new Date(at)` is fine',
  },
  {
    what: 'async',
    pattern: /\basync\b/,
    instead: 'do the waiting in the caller and hand this the answer',
  },
]

describe('pure files stay pure', () => {
  it('reads no clock, imports no machine and waits for nothing', () => {
    const problems: string[] = []
    for (const path of tracked()) {
      const named = PURE.includes(path) || PURE_UNDER.some((dir) => path.startsWith(dir))
      if (!named) continue
      const text = textOf(path)
      if (text === null) continue
      const lines = text.split('\n')
      for (const { what, pattern, instead } of IMPURE) {
        const at = lines.findIndex((line) => pattern.test(line))
        if (at >= 0)
          problems.push(
            `${path}:${at + 1} has \`${what}\`, and this file is pure.\n` +
              `Instead: ${instead}.\n` +
              'A pure file is a function of what it is handed: no I/O, no clock, nothing to await. It\n' +
              'is what lets the goldens prove a drawing change behaviour-free.',
          )
      }
    }
    report(problems)
  })

  it('names no file this repository does not have', () => {
    // A rule that quietly stops applying is the thing this whole file is
    // against. `panel-view.ts` dissolves into `panels/` in slice 5; when it
    // goes, its line here has to go with it rather than sit there meaning
    // nothing.
    const known = new Set(tracked())
    const gone = PURE.filter((path) => !known.has(path))
    report(
      gone.map(
        (path) =>
          `PURE names ${path}, which this repository does not have.\nDelete its line from ${TABLE}, or point it at where that file went.`,
      ),
    )
  })
})

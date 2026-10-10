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
// It went in before a single file moved, deliberately: a ratchet installed
// after a refactor protects nothing that happened before it.
//
// Where a budget carries a note, the note is work that file is still waiting
// for — whoever lowers that number is the person who reads it.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * What each file is allowed to be. A number here may go DOWN in the commit that
 * earns it, and never up. Adding a file to this table is how a file gets big;
 * doing that in review is the conversation this test exists to force.
 */
const BUDGET: Record<string, number> = {
  // Was 1,300. What came out is `reality.ts`: the pure reading of what git and
  // the journal said into the shapes the window draws — text in, values out,
  // no clock and no `Live`. It was never this file's subject, which is the
  // polling and the holding, and it was what left no room for a fact the strip
  // needed. The pacing constants stayed, because how often something is read
  // belongs with the reading of it.
  'packages/app/src/live.ts': 1_150,
  // Was 2,000. What came out is `commands.ts`: the small grammar of what you
  // can *ask* the window for — the list, whether each can be done now, how a
  // typed line splits into a verb and what it is for — which is a different
  // subject from what the window should *show*, and the one the next command
  // added to.
  'packages/app/src/model.ts': 1_950,
  'packages/app/src/wire/extensions.ts': 900,
  // Both lost their SMART QUEUE corner to `packages/app/test/queue-view.test.ts`:
  // what the queue shows and how the side draws it are one subject, and they
  // were being tested as two halves that could disagree.
  // Was 1,000. The typed-command tests went with their subject to
  // `test/commands.test.ts` when `commands.ts` came out of `model.ts`.
  'packages/app/test/model.test.ts': 995,
  'packages/app/test/panels.test.ts': 1_400,
  'packages/app/test/view.test.ts': 1_150,
  // `settingsOf` is one long table. Split by category into
  // `settings/{agents,window,voice,queue,checks,telemetry,keys}.ts`, each
  // exporting one `SettingGroup` and `settingsOf` composing them — mechanical,
  // and the payoff is that `.claude/skills/add-config-key` gets to say "add a
  // row to *this* file" instead of naming a line number in a thousand.
  'packages/core/src/settings.ts': 1_200,
  // Two files' worth of subject: the zod schema every setting in Tade is
  // declared in, and the file that schema is read out of and written back to.
  // The schema is ~700 lines of it and is the half that grows every time
  // anybody adds a setting; `parseConfig`, `loadConfig`, `writeSetting` and
  // `ownerOnly` are the other ~90, need nothing of the schema but its name,
  // and would be `config-file.ts` — after which a new key costs the schema
  // alone and this number goes back under the default.
  'packages/core/src/config.ts': 840,
  // What tmux says about a pane — `readPane`, `scrollingOf`, `pointingOf`,
  // `drawn` — is now `pane.ts`: the part of driving tmux that asks nothing of
  // the world, and the part every question about a pane goes through.
  'packages/drivers/tmux/src/index.ts': 850,
  'packages/extensions/core/src/host.ts': 1_450,
  'packages/extensions/core/test/host.test.ts': 1_000,
  // The three tools that close a finding have left, to `verdicts.ts` beside
  // the rule they enforce, and what let them go was moving the one thing every
  // tool here shares — the `project` parameter, beside `allowed` in `ask.ts`,
  // which already answers "which project may this call be about". The same cut
  // is there for the three that read something back before somebody guesses:
  // `jev_read_request`, `jev_plan_check` and `jev_queue_order` are one subject
  // (advising, never deciding), ~230 lines, and they now need nothing from
  // this file.
  'packages/extensions/jev/src/extension.ts': 1_250,
  'packages/extensions/jev/test/jev.test.ts': 1_000,
  'packages/extensions/review/src/extension.ts': 1_100,
  'packages/harnesses/claude/src/adapter.ts': 1_600,
  'packages/harnesses/codex/src/adapter.ts': 1_700,
  'packages/harnesses/pi/src/adapter.ts': 1_100,
  // 1,000 -> 975 when the template tools moved out to `tools-templates.ts`,
  // which is `tools-config.ts`'s split for the same two reasons: this file was
  // at its budget, and three tools that share one boundary — what the
  // orchestrator may do with a stored workflow — read better in one place than
  // inferred from three descriptions among forty.
  //
  // 975 -> 970 when the `tool_call` gate moved out to `tools-gate.ts`. Same
  // two reasons again: the file was at its budget, and the gate is not a tool
  // — it is the thing asked *before* every one of them, its own and the
  // harness's alike, so it reads as one subject rather than as a fortieth
  // description.
  'packages/orchestrator/src/tools-extension.ts': 970,
  // The one dispatch table every orchestrator method goes through, written out
  // flat: one entry per capability, forty-odd of them, and the uniformity is
  // the property — the whole surface the orchestrator can reach is readable in
  // one place. So it grows by a line or two whenever Tade can do something new,
  // which is exactly what the default cannot express, and it had been sitting
  // at precisely 800 by coincidence rather than by design. What does *not* go
  // here is the saying: how an answer reads to a model belongs beside the fold
  // it describes (`documentsWaitingSays` in core, `dryRunSays`, `usedSays`), so
  // there is one wording of a fact rather than one per caller.
  'packages/orchestrator/src/tool-host.ts': 820,
  // The facade is the point and stays: ~1,700 lines of it are the one object
  // the CLI, the window and the orchestrator all call, average method 19 lines,
  // already delegating to eight split collaborators — splitting a facade
  // produces a facade plus files. What can leave is the world-reading folds,
  // `reconcileSpend`, `lookAtCommits` and `lookAtChecks` with the keyed
  // reconciliation in each (~300 lines), to `workbench/src/reconcile.ts`, where
  // they can be tested as folds over a journal instead of through an open
  // workbench.
  'packages/workbench/src/workbench.ts': 2_495,
  'packages/workbench/src/workers.ts': 1_100,
  // Its harness — a fake adapter, a supervisor and a log — is now
  // `workers-harness.ts`, which is the half of the file that was not about any
  // particular behaviour and is under the default on its own.
  'packages/workbench/test/workers.test.ts': 850,
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
  // The rule was installed before `wire/` existed, on purpose, so that the
  // first file put there was already held to it. Twenty-two subjects later it
  // still holds, and `app.ts` is inside the default budget with no line in the
  // table at all — which is what "wiring only" turned out to weigh.
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
 * What `@tade/web` may not reach, and why the arrow points this way.
 *
 * The away view is handed what it projects — the window implements its reading
 * interface — so the package can be tested without a window, and so there is
 * no cycle between the thing that holds the state and the thing that decides
 * what may leave the machine. It is the same one-way rule as `app.ts` → `wire/*`
 * above, installed with the first file in the package rather than after it.
 */
const WEB = 'packages/web/'
const NOT_FOR_WEB = ['@tade/app', '@tade/workbench']

describe('the away view reads what it is handed', () => {
  it('imports neither the window nor the workbench', () => {
    const problems: string[] = []
    for (const path of tracked()) {
      if (!path.startsWith(WEB)) continue
      const text = textOf(path)
      if (text === null) continue
      const found = importsOf(path, text).filter((spec) =>
        NOT_FOR_WEB.some((name) => spec === name || spec.startsWith(`${name}/`)),
      )
      if (found.length > 0)
        problems.push(
          `${path} imports ${found.join(', ')}.\n` +
            '`@tade/web` defines what it needs to be handed, over `@tade/core` types, and the\n' +
            'window implements it (`packages/web/src/reading.ts`). Reaching the other way makes\n' +
            'the projection untestable without a window and puts a cycle between the thing that\n' +
            'holds the state and the thing that decides what may leave the machine.',
        )
    }
    report(problems)
  })
})

/**
 * The files that are a pure function of what they are handed.
 *
 * All of them pass today; this pins a property the repo already has and nothing
 * currently defends. `view/*` and `panels/*` are covered by prefix, so the rule
 * arrives with a new region or a new panel rather than after it.
 */
const PURE = [
  // The away view's data boundary and its door policy: a schema, a projection,
  // a diff, and every question asked of a request before a route runs — each a
  // function of what it is handed and the moment.
  //
  // `guard.ts` is the one worth saying out loud: a guard that read `req`
  // directly could only be tested by making a request, and then the attacks it
  // exists for get asked once each, for the one route somebody remembered.
  // Pure, the whole cross-product is a table.
  //
  // `stream.ts` and `peers.ts` are the same decision made again for the live
  // stream: what a cursor means and who is listening are both functions of
  // numbers and a moment, so the caps, the fan-out, the backpressure, the
  // stall and the revocation are a table over a fake sink. **A peer holds no
  // timer**, which is what makes "no unbounded timers" mechanical: everything
  // time-based about a stream happens on the window's own beat, and
  // `test/stream.test.ts` asserts neither file names a timer at all.
  //
  // Not here: `reading.ts` (holds the last projection and the revision),
  // `server.ts` (the listener), `request.ts` (reads an `IncomingMessage`),
  // `sessions.ts`/`tickets.ts`/`devices.ts` (they mint secrets and read
  // files), `assets.ts`/`qr.ts`, and `index.ts`, which is the package's door.
  'packages/web/src/delta.ts',
  'packages/web/src/errors.ts',
  'packages/web/src/fields.ts',
  'packages/web/src/guard.ts',
  'packages/web/src/headers.ts',
  'packages/web/src/input.ts',
  'packages/web/src/measure.ts',
  'packages/web/src/page.ts',
  'packages/web/src/peers.ts',
  'packages/web/src/protocol.ts',
  'packages/web/src/reach.ts',
  // The acting half's three pure files: what a verb *is* (`acting.ts`), the
  // closed table of them and how a body becomes one (`verbs.ts`), and
  // everything that has to be true of an act (`acts.ts`). The last is
  // `guard.ts`'s decision made again one layer in: a gate that read `req`
  // could only be tested by making a request, and then the crafted calls it
  // exists for get asked once each, for whichever one somebody remembered.
  // Not here: `acted.ts` (it awaits the window and the receipt store),
  // `receipts.ts` (it is a file) and `serving.ts` (it names `node:http`'s own
  // request and response, because the one thing the window hands over that is
  // not a value is the handler itself).
  'packages/web/src/acting.ts',
  'packages/web/src/acts.ts',
  'packages/web/src/routes.ts',
  'packages/web/src/snapshot.ts',
  'packages/web/src/verbs.ts',
  'packages/web/src/stream.ts',
  'packages/web/src/surface.ts',
  'packages/app/src/commands.ts',
  'packages/app/src/frame.ts',
  'packages/app/src/reality.ts',
  'packages/app/src/happening.ts',
  'packages/app/src/pace.ts',
  'packages/app/src/hits.ts',
  'packages/app/src/layout.ts',
  'packages/app/src/model.ts',
  // The away view's own two: what the window hands the projection, and the
  // panel's state. Both a function of what they are handed.
  'packages/app/src/away.ts',
  'packages/app/src/panels.ts',
  'packages/app/src/plan-graph.ts',
  'packages/app/src/scroll.ts',
  'packages/app/src/scrollbar.ts',
  'packages/app/src/selection.ts',
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
    // against. `panel-view.ts` dissolved into `panels/<name>/` in slice 5, and
    // its line here went with it rather than sitting there meaning nothing.
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

/**
 * What the window runs in its own process, and so may never block in.
 *
 * A window draws four times a second and answers keys in between, on one
 * thread: a child process it waits on stops both, and there is no key that
 * ends the wait — which is why a keychain write that stopped to ask a
 * question came out as a window that had to be killed. `security` was the
 * one that happened; `git`, `ps`, `lsof` and an extension's own commands are
 * all one `execFileSync` away from the same morning.
 *
 * So: everything in the packages the window loads spawns asynchronously, with
 * a deadline. A standalone script the window never imports is its own process
 * and is allowed to be simple — each one is named here, which is also how a
 * new one becomes a decision rather than a habit.
 */
const IN_THE_WINDOW = [
  'packages/app/src/',
  'packages/core/src/',
  'packages/extensions/',
  'packages/mcp/',
  'packages/orchestrator/src/',
  'packages/status/src/',
  'packages/web/src/',
  'packages/workbench/src/',
]

/** Scripts run as their own process, which the window neither imports nor waits on. */
const ITS_OWN_PROCESS = ['packages/harnesses/claude/src/statusline.ts']

const BLOCKING = /\b(execFileSync|execSync|spawnSync|readlineSync)\s*\(/

describe('nothing the window runs blocks it', () => {
  it('spawns no child process synchronously', () => {
    const problems: string[] = []
    for (const path of tracked()) {
      if (!IN_THE_WINDOW.some((dir) => path.startsWith(dir))) continue
      if (path.includes('/test/') || ITS_OWN_PROCESS.includes(path)) continue
      const text = textOf(path)
      if (text === null) continue
      const lines = text.split('\n')
      const at = lines.findIndex((line) => BLOCKING.test(line))
      if (at >= 0)
        problems.push(
          `${path}:${at + 1} waits on a child process on the thread the window draws on.\n` +
            'Instead: spawn it asynchronously and give the wait a deadline, the way everything\n' +
            'else here does. A window that stops answering is worse than the answer being late,\n' +
            'and a program that stops to ask a question of a window that is not drawing can only\n' +
            'be got out of by killing Tade.',
        )
    }
    report(problems)
  })
})

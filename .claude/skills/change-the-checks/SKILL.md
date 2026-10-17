---
name: change-the-checks
description: Change how a project's own checks are read, run and recorded — the Runner port, the reading of CI and the commit hook, the run record, the rollup `deriveState` reads as `tests`, and the ACTIONS page. Use when adding a runner, teaching the reading a new hook manager or a new reason a check cannot run here, changing what a run records or how it carries to a later commit, or when a commit is reported green, red or `unknown` when it should not be.
---

# Changing the checks

A check is a named unit of verification a project **already** defines, and Tade has no list of its
own: what a project checks is read out of its commit hook and its change-triggered CI workflows,
run here through one port, and written down against the commit it ran on. There is no
`.tade/checks.yaml` and nothing writes one. Everything downstream — the rollup `deriveState` reads
as `tests`, the gate before a push, the ACTIONS page, `tade check` — is a query over that reading
and that record.

| Path | What |
|---|---|
| `packages/checks/core/src/port.ts` | the `Runner` port: `Check`, `CheckRun`, `CheckLog`, `Covered`, `RunnerCapabilities`, `RunnerError`, `settled` |
| `packages/checks/core/src/conformance.ts` | `testRunner`: the suite every runner imports and passes |
| `packages/checks/core/src/read.ts` | `readChecks` — hook, then CI, then `test_command`, then nothing; `ChecksRead`, `ChecksSource` |
| `packages/checks/core/src/hooks.ts` | `readHooks`, `HOOK_ID`: the commit hook, as one check whose command is the hook |
| `packages/checks/core/src/related.ts` | `readRelated`, `RELATED_ID`: `test:related` in `package.json`, as the `related` check (`Check.related`) |
| `packages/checks/core/src/ci.ts` | `readWorkflows`, `gateTrigger`, `Reading` (`checks`, `from`, `unread`): what the workflow files *state* about themselves |
| `packages/checks/core/src/choice.ts` | `withChoices`, `chosenAfter`, `Chosen`, `TURNED_OFF`: which of them run on this machine |
| `packages/checks/core/src/identity.ts` | `idFor`, `slug`, `calledAfter`, `normaliseCommand`, `sameCommand`, `followRenames` |
| `packages/checks/core/src/plan.ts` | `planFor`, `inOrder`, `matches`: what applies to a commit, and in what order — the full run, or the related one (`related: true`) |
| `packages/checks/core/src/run.ts` | `runChecks`: the one way a run happens — the lock, the record, the row |
| `packages/checks/core/src/lock.ts` | `takeRunLock`, `waitForRunLock`, `heldBy`, `claim`: one run at a time per worktree |
| `packages/checks/core/src/machine.ts` | `takeMachineSlot`, `waitForMachineSlot`, `SLOT_ENV`, `insideHeldSlot`: `checks.suites` runs at a time on the machine |
| `test/one-suite.ts` | the suite's `globalSetup`: a full vitest run from a shell takes the same machine slot |
| `packages/checks/core/src/running.ts` | `writeRunning`, `clearRunning`, `runningIn`: what is going on *now*, in `checks.running.json` |
| `packages/checks/core/src/records.ts` | `checks.jsonl`: `writeRun`, `readRuns`, `latestAt`, `rollup`, `relatedAt`, `At` |
| `packages/checks/core/src/coverage.ts` | `coverageOf`, `coversCommit`, `carryOver`: a run is about a tree |
| `packages/checks/core/src/outcome.ts` | `readOutcome`: what a run *printed*, read back — `CheckCount`, `CheckPlace` |
| `packages/checks/core/src/say.ts` | `checkLine`, `glyphOf`, `carriedNote`, `whereOf`, `pendingWords`: one wording, wherever a run is read |
| `packages/checks/{local,scripted}` | `makeLocalRunner` (the commands, here) · `makeScriptedRunner` (a table, for tests and demos) |
| `packages/workbench/src/runners.ts` | `RUNNERS`, `makeRunner`: the one registry |
| `packages/workbench/src/checks.ts` | `checksAt`, `runProjectChecks`, `checksGate`, `quickLook`, `pushOrCommit` |
| `packages/core/src/batches.ts` | `batchDue`, `nextToTry`, `culpritOf`: when a batch runs, and whose commit broke a red one — pure |
| `packages/workbench/src/batch.ts` | `treeAt`, `runBatch`, `coveredBy`, `narrowingCommand`, `narrowRed`: the batch's own tree, and narrowing in it |
| `packages/app/src/wire/batches.ts` | `Batches`: the window's pass, and a red batch made one proposal |
| `scripts/related.ts` | Tade's own `pnpm test:related`: vitest's import graph over the changed paths |
| `packages/core/src/checks.ts` | `checksFor`, `batchedFor`, `runsBefore`, `checksTold`, `CHECK_IT_YOURSELF`, `overrideFor`, `overridesFrom`, `overrideProblem` |
| `packages/core/src/config.ts` | `ChecksConfigSchema`: `before`, `on_red`, `full`, `only`, `run_here`, `parallel`, `keep`, `ci`; `test_command` on a project |
| `packages/core/src/gone.ts` | `CHECKS_ARE_READ`: `checks.from_ci` is ignored and said |
| `packages/status/src/tests.ts` | `verifiedAt`, `readTests`: the `tests` signal `deriveState` reads |
| `packages/extensions/checks/src/extension.ts` | `checks_list`, `checks_run`, `checks_log`, `checks_override`, `rollupWord` |
| `packages/app/src/view/actions.ts` | the ACTIONS page: `actionRows`, `checkRows`, `skippedRow`, `NOT_HERE` |
| `packages/app/src/frame.ts`, `live.ts` | `CheckView`, `ActionsView` and the look that fills them |
| `packages/app/src/wire/checks.ts` | the button, the row's own control (`here`), `checks_log` in the conversation |
| `packages/cli/src/commands/{check,checks}.ts` | `tade check <task>` runs them · `tade checks` says what a project checks |

## Rules

- **Reading may only ever narrow what Tade claims.** This is the principle the whole subsystem
  rests on. A workflow is taken as a gate only on facts the file *states about itself* — `on:
  pull_request`, or a push with branches — and everything the reading cannot place is **named** in
  `Reading.unread` rather than run: a job with `environment:`, one asking `permissions: …: write`,
  a step with no `run:`, a step that only prepares the machine (`SETUP`). So the failure mode is
  "Tade checked less than CI does, and said so", never "Tade ran a deploy". Any rule added here
  must be a conjunction of declared facts, and any new rule that is a list of verbs rather than a
  fact is safe only if it may exclusively *exclude*. `unread` is carried all the way through —
  `ChecksRead.problems`, `checks_list`, `tade checks`, and its own rows on the ACTIONS page — so a
  step dropped in silence can never become a belief that Tade looked at it.
- **`unknown` is a first-class answer, and absent is not fine.** `rollup` is over the **required**
  checks with a run **here** at the commit: a required check with no run is `missing`, and so is one
  that is queued, running, skipped or cancelled. A project with no required checks at all is
  `unknown`, never `pass` — "three commits, tests green" has to mean the gate passed and not that
  one of three commands did. This is the bug that draws a red thing green, so anything new here
  must fail towards `unknown`.
- **A check that cannot run *here* keeps its row, with a `skip`, and is `required: false`.** The
  reading says which those are — a step interpolating `${{ … }}`, a step or job behind an `if:` only
  CI can answer, a job with `services:` or `container:` — and they are drawn apart rather than
  dropped, because a page that hides them is a page that quietly claims CI's coverage. Out of
  `required` because a rollup is what a run *here* adds up to: one `${{ secrets.… }}` step left
  required would leave every commit `unknown` for ever. The `skip` is the **bare reason** and never
  a sentence that frames it, so every surface can word it its own way.
- **A step that is not a check at all is not a skipped check.** An action, an install, a deploying
  job, a releasing workflow: it goes in `unread` and nowhere else. There is nothing about it for a
  page about checks to draw, and nothing there to turn on.
- **Which of them run here is a person's answer, in Tade's own config.** The reading knows what a
  repository says and what this machine cannot do; what it cannot know is a decision — not running
  a check here that the project runs, and running one the reading gave up on. Both are
  `projects.<name>.checks.run_here.<id>`, applied in one pure function (`withChoices`) **inside**
  `readChecks`, so the window, the CLI, the state machine and the runner cannot come to four
  answers. Off gives it a `skip` like any other and takes it out of `required`; on lifts the
  reading's skip and **nothing else**, because `required: false` is set for two reasons — CI is
  willing to be red on it, or nothing here could run it — and only the second is what anybody just
  answered. Only what **differs** from the reading is written (`chosenAfter`), so pressing twice
  leaves the file as it was found and a step added to CI tomorrow is checked here tomorrow. An
  entry for a check that is no longer read is ignored, never refused.
- **It is never a file in the repository.** `.tade/checks.yaml` is gone and must not come back under
  another name: a file Tade writes into somebody's tree so that Tade can read it back is the exact
  duplication all of this removed. Tade used to generate CI from that file, which made the drift a
  test could catch and the duplication a person still had to maintain. `checks.from_ci` is `GONE`
  (`CHECKS_ARE_READ`) — ignored and said, never refused, because people have it written down and
  refusing the file takes away everything else they wrote at the same time.
- **A run is about a tree, not a commit id.** It is recorded against the commit that was checked
  out, and an agent's next act is to commit — so what it *read* is recorded too (`coverageOf`):
  that commit's tree, every tracked path whose bytes on disk differed from it, and the untracked
  files that were also there. A later commit carries it (`carryOver`) only when applying that
  record to the run's tree yields **exactly** the commit's tree, because the same commands over the
  same bytes give the same answer. Agents share one checkout, so this has to be exact: a partial
  commit, another agent's file caught in the run and left out of it, anything edited after the run
  — the bytes committed are not the bytes read, and the answer stays `unknown`. Untracked files
  cannot be in the comparison (no tree holds them); they are recorded so a commit that *adds* one
  matches, and one that stays untracked is on disk for the run and for a re-run, so it is not what
  makes the two trees differ. A carry is **said**, never hidden (`carriedNote`). A run with no
  `covered` — a forge's, or one recorded before this existed — speaks for its own commit and no
  other.
- **An id is the step's own name, and a rename is followed.** It is what a person typed, what CI
  shows on its row, and what somebody types at `checks_run`; deriving one from the command reads
  worse and is not even stable (`pnpm exec biome ci .`, `pnpm exec tsc`, `node scripts/coverage.ts`
  share a program). The objection is answered the way `carryOver` answers it one level up: what
  makes a run true is the bytes it read, so a run under an earlier id still stands **when the
  command is the same**. `CheckRun.ran` records the command and `followRenames` relabels a stray
  run — only where exactly one check runs that command, and only onto a check with no run of its
  own, because a relabelling that had to choose would be a guess and a guess here draws a green
  tick. A run written before `ran` existed cannot be followed: the record is append-only, so only
  time cures it.
- **Runs go through Tade, so four agents never start four suites.** Every caller — the CLI, an
  agent's `checks_run`, the window's button, the gate before a push — goes through `runChecks`, and
  the worktree lock, the record and the row in the window come with it. The lock's rule is
  `lockHome`'s: **a lock whose process is gone is not a lock**, so a stale one is taken over rather
  than reported, and nobody is ever told the checks passed because somebody else's run did
  (`RunnerError('busy')`). Waiting is the polite half of the same rule.
- **A worktree is not the machine.** The worktree lock alone let six worktrees run six suites —
  sixty-seven vitest processes on one laptop — so a run with an `alone` check also takes one of the
  machine's slots (`machine.ts`, under Tade's home, `checks.suites` of them, the same stale-pid
  rule), worktree first and then the machine, under one `waitMs`. `checks.suites` is the machine's
  and no project's: `ProjectConfigSchema.checks` omits it, because a bound each project sets for
  itself is one suite per project. The run hands its commands the slot it holds (`SLOT_ENV`), which
  is what lets a project's own runner take the same turn without queueing behind itself — Tade's
  does, in `test/one-suite.ts`, so `pnpm test` typed into a shell waits like `checks_run` does. That
  is the enforceable half; the sentence in the prompt (`checksTold`) is only the polite one.
- **A suite takes minutes, so a run says what it is doing while it is doing it.** `checks.jsonl`
  holds only what finished; what is going on now is a small file beside it
  (`checks.running.json`) that `runChecks` writes at every state change and takes back when
  the run ends — so the window draws which check is going, how long it has been going and how many
  are done, whoever started it. The lock's rule holds here too (`runningIn` clears a record whose
  pid is gone), so a window killed mid-suite leaves nothing claiming anything is running. What a run
  *printed* is read back the same way (`readOutcome`): the counts and the files are in the tail
  already, and a shape nothing recognises reads as **no** counts rather than as an invented one.
- **A related run is a quicker look, never the suite.** A project that says how to run the tests a
  change touches (`test:related`, read by `readRelated` as a fact the manifest states) gets a
  `related` check: never required, never in a full run (`planFor` leaves it out unless asked for by
  name), and the related run is the commit hook and it and nothing else (`planFor(…, { related:
  true })`). Which tests is the project's import graph — Tade's own is vitest's (`scripts/related.ts`)
  — and **never a model's or a judge's**: choosing what not to run is the opposite of adding caution.
  It passing leaves the rollup `unknown`; what is said beside it is `pendingWords` — "related tests
  passed, full run pending" — on the ACTIONS heading, in `checks_list` and in `tade checks`, never a
  green. `paths` narrow the related check alone, each `shellQuote`d, and nothing that starts with `-`.
- **Batched, the full checks run once for every batch of commits** (`checks.full: batched`, and unset
  where the project has a `related` check — `batchedFor`, only ever in a shared checkout, where one
  full run at HEAD covers every task committed before it). The agent is told the related run is what
  "passes its checks" means (`checksTold`'s batch wording); a commit under `checks.before` is held
  to the hook and `related` (`quickLook`), and **a push to the full checks, always** — leaving the
  machine is never batched, and CI and `release.yml` stay full. The window's pass (`wire/batches.ts`,
  paced to `BATCH_LOOK_MS`) asks the pure rule (`batchDue`): HEAD settled (`SETTLE_MS`), not green,
  no batch answered it yet, nothing running, a run that could not start tried again only after
  `RETRY_MS`. Never a second batch beside one, never again at a HEAD a batch answered — red
  included, because the same tree asks the same question.
- **A batch runs in a tree of its own, never in the shared checkout** (`treeAt`): a `git clone
  --shared` under `<home>/projects/<name>/batch`, checked out at exactly the commit, cleaned of what
  a run left, and prepared the way a new worktree is (`readingOf`), the setup only again when a
  manifest or lockfile changed. The checkout holds other agents' half-written files, and a run there
  reads them — most of a night's red runs were exactly that. What is run is what *the commit* says it
  checks (`runIn`), recorded as the checkout's, with `covered` the clean tree, so it carries. The
  same tree is the only place the next rule can happen: the checkout is never moved to another
  commit.
- **A red batch is narrowed by rule, and is one proposal.** The failing tests (`readOutcome`'s files,
  handed to the related check) or a cheap failing check run again at the covered commits, HEAD first
  — a failure that does not come back on its own is a flake and nobody's — then the base, then
  halving (`nextToTry`, `culpritOf`), under one machine slot. A suite that named no failing test (a
  coverage floor) cannot be narrowed and says so rather than running whole again. Whose commit it is
  is its `Tade-Task:` trailer (`coveredBy`), never a guess. It becomes **one** parked task `by:
  extension:checks`, put to the orchestrator now (`putToOrchestrator`) naming the commit, the task and
  every step, with steering that task's agent offered first — **never one agent per covered task**.
- **`checks.before` is honest about what it can hold.** Under `approvals.mode: 'policy'` an agent's
  push with nothing green behind it comes back refused with what is missing (`checksGate`);
  anywhere else the agent is told the rule (`checksTold`) and what happened is written down. The
  default mode is `bypass` and approvals are never Tade's to change, so out of the box this is a
  rule an agent keeps and not a gate that holds one — and that is said where somebody **chooses**
  it (the setting's `means`, the group's `about` in `core/src/settings.ts`), not only in the code
  that enforces it. A setting that reads like a promise Tade does not keep is worse than one it
  does not have.
- **Overruling is an act, not a setting.** `checks_override` with a reason, read back out of the
  journal's `tool_call` lines (`overridesFrom`, `overrideFor`) — so closing the window does not lose
  one and a crash mid-push does not either. A red run that was overruled is **still recorded red**:
  nothing edits a run's state and nothing edits the config behind anybody's back. An agent may
  overrule for its own task and nothing wider (`overrideProblem`), four hours at the most
  (`OVERRIDE_LIMIT_MS`), and a `next push` is spent by the first push after it.
- **Where a project says nothing, Tade invents no gate.** `unknown` stands, which is true, and the
  agent is told so in as many words (`CHECK_IT_YOURSELF`, appended by `composeAgentPrompt`): work
  out what checking this project means, run it, and say what you ran — because nothing recorded a
  run and its word is the only evidence there is. The one escape hatch is deliberately a config key
  and not a file in somebody's repository: `projects.<name>.test_command`, one line, which becomes
  a single required `tests` check.
- **Parsers of other people's formats never throw.** `readWorkflows`, `readHooks`, `readRuns`,
  `readRunning` and `readOutcome` are all readers of somebody else's bytes: unparseable YAML is
  named in `unread`, a record line that will not parse is skipped rather than thrown over, and a
  tail cut mid-line at the front is the normal input. `readChecks` reads **files and nothing else**
  — no processes, no network — because it is called from a draw-adjacent poll and from the CLI with
  no window open.
- **The vocabulary rule (R2) is strict here.** "workflow", "job", "step", "pipeline" and "action"
  are GitHub's and GitLab's words and appear only inside an implementation; on screen a person
  reads their own by declaration (`Runner.words`). Branch on `capabilities` — `containers`,
  `services`, `matrix`, `secrets`, `cancel`, `fidelity` — never on `runner.id`.
- **A matrix is one check, run once, here.** The reading must never turn a 2×OS matrix into two
  checks. The caveat that a local run is the commands CI runs and never CI's matrix is true under
  every row, so it is a clause on the heading — `ActionsView.notes`, put there by `live.ts` and
  drawn once above the rollup — and never a footnote under each row.

## The ACTIONS page

What an agent did and whether it holds up is one page, beside its screen (`actionRows`). Its own
commits are the ones whose `Tade-Task:` trailer names it, drawn apart from everybody else's rather
than counted in a header; in a shared checkout what is uncommitted is said to be nobody's to
attribute rather than claimed as this agent's. A check is what ran, when, against which commit, how
long it took and what it counted, with the tail of a failure read on the page — and `unknown` is
drawn as `unknown`.

The checks are **two categories, because one list was a wall.** Every row carried where it came
from, whether it can run here and why one is skipped; each sentence was true and together they were
what somebody asked to have taken away. So the question is asked once — does Tade run this on *this
machine*? — and `skip` is the whole of the answer, whoever gave it.

- What runs here is the page: a tick, one cell of a mark for how long it took beside the figure
  (`spark`), when, what it counted, and the first file a failure named.
- What does not is **one fold** (`NOT_HERE`), shut unless somebody opens it, with the reason a value
  beside a name rather than a sentence under one — in the same `▸`/`▾` with a count the sidebar's
  sections use, through the same `sectionOpen`, because it is the same act and nobody should learn
  it twice. `ActionsView.unread` is in there too, since a step the reading could not call a check
  at all is exactly that.
- Everything a row could otherwise say is **behind** the row: the command, the rest of the files,
  the tail, the whole log.
- Nothing in `view/actions.ts` reads a file or asks a forge: it is a pure drawing of what `live.ts`
  already answered.

## Steps

**A new runner** (containers, `act`, a remote). Implement `Runner` in `packages/checks/<name>`,
import `testRunner` from `@tade/checks-core/conformance` and pass it, declare every capability
honestly — `fidelity` is the port's word for how close to CI a tick is, declared for the sentence a
surface puts beside one (nothing reads it yet; the caveat drawn today is `ActionsView.notes`) — and
add one line to `RUNNERS` in `packages/workbench/src/runners.ts`. Never `new` one at a
call site; `makeRunner` is the only door. `scripted` is registered and chosen by nobody: checks that
always pass are worse than no checks, so whoever wants it names it.

**A new place a project says what it checks** (another hook manager, another forge's CI). Add it to
`HOOKS` in `hooks.ts`, or to `readWorkflows`; then, in order:

1. Make the new rule a **fact the file states**, and put everything it cannot place in `unread` with
   a sentence naming the thing and why.
2. Give each check an id through `idFor` so two rows can never share one, and a `from` so the row
   can say where it came from.
3. Decide `required` from what the file declares (`continue-on-error`, and whether it can run here
   at all) — never from the step's wording.
4. Add a table case to `packages/checks/core/test/ci.test.ts` or `read.test.ts` for what it reads
   **and** for what it refuses, because the refusals are the invariant.
5. Nothing else changes: `readChecks` is the one reader, and the window, the CLI, `verifiedAt` and
   the runner all go through it.

**A new reason a check cannot run here.** Give it a `skip` with the bare reason and
`required: false` in `ci.ts`, and stop: `withChoices`, the rollup, the record, the runner and the
`NOT_HERE` fold already treat a skipped check as exactly what it is. Do not add a second notion of
exclusion — that is the bug this shape exists to make impossible.

**Something new on a run.** Add the field to `CheckRun` in `port.ts` as **optional**, read it
hand-checked in `records.ts`'s `asRun` (absent means "cannot say", never a default that looks like
an answer), write it in `run.ts`, and say what its absence means in the doc comment: the record is
append-only, so every run already written has none of it and only time cures that.

**A change to what carries.** `coverage.ts` only. Keep `coversCommit` pure and table-tested
(`test/coverage.test.ts`); keep the git calls inside `coverageOf`/`carryOver` budgeted (`MOST_DIRTY`,
`MOST_UNTRACKED`, `MOST_TREES`, and a timeout on every call), and return `null` rather than a
partial record — a run with no coverage costs the carry and nothing else, where a wrong one draws a
tick nobody earned.

**A config key.** Follow `add-config-key`: it goes on `ChecksConfigSchema` (so a project can answer
for itself through `checksFor`), needs a row in `settingsOf`, and needs a `means` that is honest
about what it can hold. If it is a key Tade stops reading, it goes in `GONE` with the sentence that
replaced it — ignored and said, never refused.

**A tool.** Follow `add-orchestrator-tool` / `add-extension`: the tools live on `checksExtension`,
they read Tade's own config from `ctx.home` rather than from `extensions.checks` (one place to
change the rule), and a tool fails by throwing.

**Anything drawn.** `CheckView`/`ActionsView` in `frame.ts` first, filled in `live.ts`, drawn in
`view/actions.ts`, then a screen scenario in `packages/app/test/screens/scenarios/agents.ts` and
`pnpm screens` (accept on purpose) — the pictures are part of the change, not a follow-up; see
`redraw-the-pictures`.

**If the `tests` signal moves.** `verifiedAt` (`packages/status/src/tests.ts`) is what `deriveState`
reads as `tests`, through `followRenames` → `carryOver` → `rollup`, with the old `tests.json`
as the fallback for a project that has no checks or has never run one through Tade. Changing it is
changing task state: follow `change-task-state`.

Then: the invariant in `AGENTS.md` if a rule changed (one line, pointing here), the agent-facing
words in `packages/extensions/checks/skills/run-the-checks/SKILL.md` if what an agent should do
changed, and `pnpm check` **on its own** — the suite spawns real git and real processes with short
timeouts, and anything CPU-heavy beside it starves them into what looks exactly like a regression.

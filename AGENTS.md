# Tade — agent guide

Tade is a voice-first control room for coding agents: it runs them as pi in lanes (terminals),
derives task status from observable state, and is driven by an orchestrator you talk to. It owns no
state of its own — tmux owns the processes, pi owns the conversations, git owns the work — which is
why closing it is harmless. **You may be a Tade worker editing Tade itself.**

**This file is short on purpose, and is held to a size** (`test/guide.test.ts`, which carries the
argument). Every agent reads all of it, so an invariant here is **one or two lines: the rule, and
where it is enforced**; why, the measurements and what it used to be go in a comment beside that code,
in its `.claude/skills/` recipe, or in a test. **Finishing work does not mean appending here.**

## Commands

- `pnpm check` — the full gate (biome ci, tsc, then the suite with its coverage floors). Run it
  before calling work done.
- `pnpm test` — vitest. Must stay under 30s with zero network calls.
- `pnpm coverage` — the suite plus the floors in `scripts/coverage.ts` (`--table` prints every
  package). This is what the `tests` check runs.
- `pnpm exec biome check --write .` formats and fixes; `pnpm tade <args>` runs the CLI from source.
- `pnpm test:smoke` — the domain, and the tests that hold this repository to its own word. A second or
  two, and what the pre-commit hook runs.
- `TADE_LIVE=1 pnpm vitest run packages/orchestrator/test/live.test.ts` — the only test that uses a
  real model, and the only evidence a model can pick the right tool from the descriptions we wrote.
  Costs money, skipped by default; `pnpm release` refuses without a green receipt for HEAD.

**The commit hook is the fast gate, and CI is the real one.** `.githooks/pre-commit` runs biome,
`tsc` and `test:smoke` in four or five seconds, because a hook people wait on is a hook people pass
`--no-verify` to. A green hook is not a green `pnpm check` and never stands in for one.

**Run the suite on its own.** It spawns real git and PTY processes with short timeouts, so anything
CPU-heavy alongside it starves them and they time out — which looks exactly like a regression and is
not one. Never conclude the suite is broken from a run that shared the machine.

**A test never counts what the machine did in a fixed sleep.** A number over a stretch of wall clock
is a number about the runner. Pace by the thing being counted; the safe shapes are a rate with a
ceiling and a "said once" over a wait (`packages/app/test/wire/frame.probe.test.ts`).

**Agents share this checkout.** Read a file again immediately before editing it. Commit only files
you changed yourself, each added by path — never `git add -A`, `git add .` or `git commit -a` — and
never run what throws others' work away: `git stash`, `git checkout`/`restore` of files,
`git reset --hard`, `git clean`.

There is **no build step**. Node ≥22.18 runs `.ts` directly (type stripping). Consequences:
- Relative imports use the `.ts` extension: `import { x } from './x.ts'`.
- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Type-only imports use `import type`.
- The published tarball is the one place this is not true — see the `cut-a-release` skill.

## The four rules

1. **R1: every port is an interface plus a registry.** A port lives with its subsystem —
   `drivers/core`, `harnesses/core`, `voice/core`, `extensions/core` — next to the conformance suite
   its implementations must pass. Implementations are registered by name in one registry map; call
   sites never `new` a concrete one.
2. **R2: no port interface uses an implementation's vocabulary.** It's `write(lane, bytes)`, never
   `sendKeys`. Check every method name against this before implementing.
3. **R3: capabilities are declared, never sniffed.** Branch on `driver.capabilities.focus`, never on
   `driver.id === 'tmux'`. A Biome plugin (`biome/no-port-id-check.grit`) fails lint on this.
4. **R4: conformance suites come first.** Each port has a shared suite beside it in its `core`
   package; every implementation must import and pass it.

## Read the recipe before you change anything

`.claude/skills/` holds the recipe for every recurring change, with the reasoning behind each invariant
attached to the decision it governs. Load the matching one rather than working from this file alone.

| Changing | Skill |
|---|---|
| a `tade` subcommand · a config key or secret · an event type | `add-cli-command` · `add-config-key` · `add-event-type` |
| an extension · an MCP server · a reporter or telemetry | `add-extension` · `add-mcp-server` · `add-reporter` |
| an orchestrator tool · a workbench operation | `add-orchestrator-tool` · `add-workbench-operation` |
| a driver · a harness · a status probe · a task's state | `add-workspace-driver` · `add-worker-adapter` · `add-status-probe` · `change-task-state` |
| a judge · the checks · the reviews · an intake source | `add-judge` · `change-the-checks` · `change-the-reviews` · `add-intake-source` |
| the queue, schedules and watches · spend and plan limits | `change-the-queue` · `change-the-spend` |
| a workflow template or a persona | `add-template-or-persona` |
| the window · the README's pictures | `change-the-window` · `redraw-the-pictures` |
| voice · transcription · a provider transcript | `add-voice-intent` · `add-transcriber` · `add-transcript-parser` |
| the release · what the machine must have | `cut-a-release` · `set-up-the-machine` |

## Invariants

### Deriving, not remembering

- **Status is a query, not a memory.** `deriveState` (`core/src/state.ts`) is a pure function of
  probe results: no I/O, no clock reads (take `now`), no async.
- `status` never throws. Failures degrade to a partial answer plus `warnings[]`.
- **Every statistic is a fold over the journal** (`runtimeFrom`, `spendFrom`, `statsFrom`); nothing
  holds a stopwatch or a tally.
- **`unknown` is a first-class answer and is never drawn as nought**: `UNRECORDED`, `cannot tell`, `—`
  rather than `$0.00`, `≥` for a figure some of whose answers could not say.
- **A probe that could not look is not a probe that found nothing** (`problemWith`): not installed,
  failed, timed out — three cases, never one, and a failed look degrades to the last scan that could
  rather than to an empty list, which everything above reads as "nothing is running".
- **Two things are written down because they cannot be asked again**: `commit_seen` keyed by sha
  (`git log` answers differently after a rebase) and `check_ran` keyed by run id (`checks.jsonl` dies
  with its task).

### Git, tests and fixtures

- Tests use **real git repos** built by `test/fixtures/mkrepo.ts`. **Never mock git.**
- **A fixture must not be kinder than reality** — `mkrepo` puts nothing of Tade's in a checkout and
  writes no ignore rule; its task files go in `repo.home`.
- Git is invoked directly with `--porcelain=v2` / `-z`. No git wrapper libraries.
- Parsers of external formats (provider transcripts) return `null` on unknown shapes, never throw.

### The journal, and what is told rather than derived

- **`events.jsonl` is the truth**; the SQLite index is derived, must be rebuildable from it, and is
  always safe to delete. Raw lane output never goes in the journal — only sampled byte counts. Under
  subscriber backpressure, `trace` events drop first and `blocking` events never.
- **Compaction drops samples, and only samples** (`SAMPLED_TYPES`) — by type, never by urgency, which
  is about subscribers, and nothing droppable left is a `warning`, not a deleted record.
- **Notes are the one thing Tade is told rather than derives**: verbatim in `<home>/memory.jsonl`,
  append-only, a bad line skipped rather than thrown over. Never lowercase or reword one; a `summary`
  may be written *beside* a note, never made out of its text. `intent_spoken` likewise.
- **The registry keeps a dead lane's spec so the work can be put back**, so it forgets only one whose
  task is gone (`forgettable`) — never a live one, never one marked `lost`.

### Tasks, the queue and efforts

- **A task is finished when the journal says so** (`task_done`); the rule is `done` in its task file.
  Never infer it from a turn ending — an agent that asked a question looks the same — or from an agent
  having stopped, which is `review`.
- **A task may say what it produces** (`produces`): a name, the document goes in the task's own
  folder, never committed (`producesPath`), and an untriaged one never ages out of the briefing
  nor is destroyed unasked (`documentsIn`, `document_triaged`).
- **Queued work is a task with `start` in its task file.** The window starts it by rule
  (`readyToStart`), never a model deciding again, and writes why. **Evidence may only ever hold**: the
  start-time look at the trees reaches that rule through `queueStateOf`, and a written `order` is only
  a preference among the ready.
- **A persona says what an agent is told, never what it is allowed**, and a template is a stored
  `Plan` `checkPlan` keeps: a published version is an immutable snapshot, and using one makes
  **parked** work (`add-template-or-persona`).
- **A task name is never used twice** (a new agent given an old one's name carries on its
  conversation), and **a task's id is in its task file, not its branch** — Tade never renames a branch
  it did not make.
- **Whose a commit is, is read out of the `Tade-Task:` trailer, never guessed.** "Unattributed" is
  always allowed; uncommitted work in a shared checkout is nobody's.
- **An effort is the fold of the task files that name it** (`TaskFile.effort`, `effortsIn`) — one
  ordinary task per repository, each with its own branch, checks, review and done rule; no
  `Tade-Effort:` trailer and no effort-level rule or state. A plan may span repositories, so paths are
  compared only inside one project, no ref is handed across one, and same effort is never permission.

### Where agents work

- **Agents work where the *project* says, and the machine's answer is only its default.**
  `workspaceFor(config, project)` (`core/src/project.ts`) is the one reader; nothing asks the machine.
  `checkout` (the default) is every agent in the project's own checkout; `worktree` is a worktree and
  branch each. **Nothing that runs git on a task's directory may assume the directory is the task's
  alone — ask `task.workspace`.**
- **Nothing Tade writes is inside a project** (`core/src/home.ts`, held by `test/own-files.test.ts`):
  task files, context, attachments, check runs and locks live under `<TADE_HOME>/projects/<name>/`, so
  no project needs a `.gitignore` line and none is written; `removeOwnIgnore` takes back one an older
  Tade wrote, whose `.tade/` is **not read or migrated**.
- **Closing a project is not forgetting its work**: it leaves the folder, the branches, the journal
  and the agents working, and no tool removes a worktree, branch or folder.

### Checks

- **A check that nobody ran is not a check that passed.** The rollup of the required checks at HEAD is
  what `deriveState` reads as `tests`, and `unknown` is first-class: absent is not fine.
- **What a project checks is read out of what it already says** — its commit hook and its workflows.
  There is no `.tade/checks.yaml` and nothing writes one, and **reading may only ever narrow what Tade
  claims**: what it cannot place is *named* (`Reading.unread`) rather than run, so the failure mode is
  "Tade checked less than CI does, and said so".
- **A check that cannot run *here* keeps its row with a `skip` and is `required: false`** — a rollup is
  what a run *here* adds up to. Where a project says **nothing**, Tade invents no gate: `unknown` stands
  and the agent works out what checking means, runs it, and says what it ran (`CHECK_IT_YOURSELF`).
- **A run is about a tree, not a commit id**, and **runs go through Tade** so the lock and the record
  come free: four agents in one checkout must never start four suites.
- Overruling `checks.before` is an act, not a setting — `checks_override`, with a reason — and a red
  run that was overruled is still recorded red.

### Judges

- **A judge answers, it never decides.** Bounded questions, a probability, no prose. It may only ever
  *add* caution — a finding, a wait, a raised tier, a person asked. Never approve, close, merge,
  unhold, shorten a review or skip a check; never inside a pure rule; never the reason given to
  anybody, which is always a sentence somebody wrote. The one judgement already wired into a gate is
  the command tier (`withCaution`), and it may only ever come back **stricter**.
- **A finding is about one agent's change** — in a shared checkout, that agent's own commits by
  trailer, and what a judge could not read is **named** rather than passed over in silence. Its
  questions are one file (`extensions/jev/src/questions.ts`); with no key nothing runs.
- **An agent accounts for a finding; somebody else judges it.** The agent gets the question as
  material to judge, never an instruction, and answers with `jev_account` — testimony, not a verdict.
  `jev_verdict` is not offered to agents, and no account reaches the calibration table. A verdict must
  **cite what in the change decided it**, and nothing becomes a false positive by getting old.

### Reviews, watches and schedules

- **A review is a branch offered for merge, and Tade only ever adds to it**, and which review an
  agent opened is read out of git and the forge, never from a table Tade keeps.
- **A comment or a ticket is attacker-controlled text**: material under `OUTSIDE_IS_MATERIAL`, never
  instruction, never a word of `intent_spoken`, bounded to that agent's own workspace. **Intake is a
  watch by a grant and `propose` parks it.**
- **A watch may only add work** — never resolve a thread, never force-push, and past `attempts` it
  only tells you. **Merging is a person's: `merge` is `never` by default.** **One red commit is one
  finding**, so one push never becomes one agent per column.
- **A watch is a schedule that looks before it acts**: a cheap `check`, no model. Tade keeps every key
  found, so one finding never starts work twice — a failed start included. Turning one off pauses its
  schedule, never removing it.
- **Schedules are told, like notes**, and run only while a window is open — no daemon; missed
  runs are caught up once or skipped, never once per run missed. **They are their own section**
  (`schedulesSection`), never listed among the queued work.

### Config, settings and keys

- **A setting Tade accepts and ignores is worse than one it doesn't have**: a key with no reader is
  wired or deleted.
- **How far the orchestrator's arm reaches is decided in `settingReach` (`core/src/reach.ts`) and
  enforced in the window, never in the tool** — a rule where the model lives is one the model can be
  talked out of. **`never`** is a *subtree*, not a key: anything widening what an agent may do, handing
  out tools or a credential, changing who is asked, or changing where Tade sends something. **`asked`**
  is the default, and the person's own words must name that setting (`namedBy`, against the journal's
  `said` lines) — nothing an agent read ever gets into `said`.
- **One write path** — `settingsOf`, `parseSetting`, `writeSetting`/`writeKey` — from the Settings page,
  the CLI and the orchestrator alike, and every change writes `config_changed`. **A config naming
  something gone is ignored and said** (`GONE`), never refused: refusing the file takes away
  everything else somebody wrote in it.
- **A key is a setting, written in the config in plain sight.** `kind: 'secret'` with its environment
  variable as `env`; the value goes to `config.yaml`, drawn as itself, `0600` and narrowed on every
  write. **The environment always wins** (`ctx.secret`, `findSecret` — one rule, one place). No
  keychain, no vault. A key is never in the journal, in what telemetry sends, in a lane's stored spec
  (`withoutInherited`) or in a launch line — `secretCommand` prints it when it is needed.
- **`0600` keeps the file from other people, and an agent is not another person.** Agents run as you,
  with nothing containing them, so **any agent can read `config.yaml` and every key in it.** That is a
  decision, and the rule is that it is **said where somebody is deciding**, in one sentence written
  once (`KEYS_AND_AGENTS`, short clause `SEEN_BY_AGENTS`, `core/src/secrets.ts`), carrying the way out
  in the same breath. **Nothing anywhere may go back to saying the file is one only you can read.**
- **Tade does not sandbox anything, and says so rather than half-owning it.** Containment is the
  harness's or the agent's; what does the work is the approval tiers, the worktree as the policy
  boundary, and saying so where somebody is deciding (`SERVER_RUNS_AS_YOU`).

### Telemetry and money

- **Tade reports its own trouble, never your work.** What may be sent is an allow-list (`KEPT`,
  `telemetry/shape.ts`): names, counts and Tade's own words. Your words, an agent's, task titles,
  prompts and notes are never in it; paths scrub to `~`. A reporter never throws or blocks.
- **Watching for trouble never decides what it costs** (`watchProcess`): an uncaught exception ends
  Tade with the terminal handed back, and **a promise nobody awaited is reported and nothing else**.
- **Priced, guessed by the harness, and priced here from tokens are three claims never added in
  silence** (`pricedOf`, a mark each; rates in `core/src/prices.ts`, dated, overridable, never
  fetched). **A plan is not money**: a harness on one reports none, what it used up is `PlanWindow`,
  what it would have cost at list is `usdOnPlan`, and neither is in a total.
- **What a run was is written down, never read out of a model's name — and never out of a route's
  wish**: the provider is the harness's declared answer (`WorkerAdapter.provider`).

### Harnesses, lanes and drivers

- **Under `pty` lanes are Tade's own children and die with it; under `tmux` they do not.** Which it is,
  is `capabilities.detach` — never branch on the driver's name.
- **A lane is alive only if the driver hands it back** — a live pid proves something is running, not
  that this driver can drive it. Never report a lane alive without evidence, and keep its spec.
- **`detach()` closes the window; `shutdown()` stops the work**, and **what Tade draws itself dies with
  Tade** (`reaped`) — agents keep working, which is what makes closing Tade harmless.
- **A harness says how it does things, and why not**: what a person may ask of a running agent is a
  capability with a sentence in `why`, read everywhere through `offer()`, and whatever touches a
  harness's own records asks its adapter.
- **An agent is a lane with pi in it**, named `<task>/agent`, in a session whose id never changes. **A
  model is chosen per harness and resolved by the harness it is for** (`resolveModel`), never handed
  across, and only **new** agents start on it. **An account is the harness's own sign-in**: a
  subscription token never passes through Tade. **Nothing may ask pi anything while its extensions
  load** — a throw there takes the agent down.
- **An opening instruction is said once** (`LaunchSpec.opening`), never written into the lane's spec,
  so a relaunch or a reopen is silent. **Opening the window starts nothing new, and brings back what
  was working**: an agent running when Tade closed is marked `lost` and reopened where it left off.
- **A tool fails by throwing.** Anything else reaches the model as an empty answer that looks like
  success.
- **There is no server.** The one socket is the `ToolHost`: window to its own child agents,
  undiscoverable, dead when the window closes. Anything else wanting to call it means a daemon again.
  **Everything Tade starts runs detached**, in its own process group, so whoever started one ends it.
- **One window per home, and questions never need it.** Opening the workbench locks `TADE_HOME`, so
  anything that only reads — `status`, `logs`, `notes`, `summary`, `spend` — reads the files directly
  (`readJournal`, `Memory.open`) and never opens the workbench. `attach` puts the terminal in raw
  mode, so every exit path, signals included, runs the same `restore()`, safe to call twice.

### The orchestrator

- **Tade tells the orchestrator; it never talks over it.** What happened waits and goes with the next
  thing you say, under "What they said:"; what needs it now goes after its current turn.
- **The orchestrator is a harness choice like any other** (`orchestrator.harness`): the same
  `Orchestrator` over the same signals, never branched on a harness's name. It must be drivable
  headlessly (`capabilities.headless`) and take Tade's own tools (`orchestratorTools`, declared once).
  Nothing it does is gated, so it runs unsupervised.
- **It picks its conversation back up; it is never introduced again.** One session whose id never
  changes (from `ORCHESTRATOR_TASK`) — never "continue the newest". Interrupting it may never be a way of restarting it.
- **`composeBriefing` has a shape rather than a budget**: it caps per project and **counts what it
  left out**, because a flat cap loses four repositories *without a word*. Two things it may **never**
  say: which project you are looking at, and a branch or worktree path — both go stale in a minute.
- **Every agent is told it runs in Tade** (`composeAgentPrompt`): its task, where it works and who else
  does, `agents.commit`, `agents.instructions`, your notes, its context file — appended to the
  harness's own instructions, never replacing them.
- **Nothing goes wrong silently.** A refused request, a retry, an extension that threw, a turn that
  ended with nothing said — each reaches the transcript in words someone can act on. A conversation
  that goes quiet is the worst failure it has, because it looks like thinking.
- **Where you are is said every turn, as a fact, and never remembered** (`whereYouAre`), **above** the
  `What they said:` heading — it is Tade's sentence and must never be recorded as the person's.

### The window

The whole of it is the `change-the-window` skill. The rules that break things quietly:

- **Nothing the window runs waits on a child process.** It draws four times a second and answers keys
  in between, on one thread, so everything in the packages it loads spawns asynchronously and **every
  wait has a deadline** (`inTime`) — an extension's `ready()` included.
- **The pure files** (`frame.ts`, `model.ts`, `view.ts`, `view/*`, `panels/*`, `skin.ts`, `ui.ts`, …)
  **contain no `node:` import, no clock read and no `async`**, held by `test/modularity.test.ts`,
  which also holds `app.ts` → `wire/*` one way only.
- **Tade stays light, and proves it**: what it polls is cheap and shared, and anything on a timer or
  drawn every frame has a performance test.
- **Escape stops what is thinking; ctrl+c throws away what you typed; neither does the other's job**
  (`escapeMeans`, always exactly one thing). **What is on the line is the orchestrator's, not the
  focus's** (`orchestratorDraft`), and the line is pi's editor: changed only by pressing the keys a
  person would press, never by reaching into its state.
- **Everything that scrolls scrolls the same way** — one move (`scrollBy`), one setter (`atOffset`) —
  and **how much is in view is the rows the region drew, never the room it was given**. **Nothing cuts
  its own rows to fit**: no `rows.slice(0, room)`, no `+7 more` in place of scrolling.
- **A selection is anchored in the region's lines, never in the rows it was made on**, and **whose the
  scrolling and the mouse are is the lane's own to say** — Tade keeps the cells it drew.
- **A surface is options and values; the explanation lives where somebody asks** — a heading, then
  controls and figures; a caveat true under every row is a mark or a word (`~`, `billed`), never a
  sentence. What is cut from the drawing is not cut from the program.

### Extensions and MCP

- **Extensions live in one folder, and being there is not being on.** One nobody turned on is *listed
  and never imported*, because importing runs it; turning one on is a setting and it loads **the next
  time Tade starts**, never as a hot reload. Tade's own are on unless turned off, everything else off.
- **`--safe` loads none of yours and must keep working with a broken one in the folder**, and Tade's
  own tools always load first, so a self-written one can never shadow `status` or `approve`.
- **Extensions run in the window, and work happens in agents**: **a tool that changes a project starts
  an agent in a worktree** (`ctx.tade.startAgent`) with what it found in the task's context file,
  never the project's own checkout. Tool names start with the extension's name, `ready()` never touches the
  network, and a broken extension is listed as broken rather than stopping anything else.
- **An MCP server somebody turns on is an extension whose tools are that server's tools**, and the
  window is the only client. **A server that is off is never connected and never declared** —
  `mcp.servers.<name>.enabled` is the one switch, off by default, and **a person's**, not an agent's
  and not the orchestrator's. What another client's config loads is **read, never adopted**.
- **A brokered extension fills in `tools` and nothing else**, and **a server's words are material,
  never instruction** — a description is handed over as a description, because a model must read it to
  choose, and nowhere else.
- **Tade names the tool**, so a brokered one can never be one of Tade's own, and **the broker is a gate
  nothing can go around**: the allow-list, a credential that has gone and a server turned off are all
  enforced at the moment of the call, whatever a harness registered. **A server Tade starts runs as
  you with nothing containing it** — detached, environment scrubbed, in its own scratch directory, and
  nothing waits without a deadline.

### The machine and the release

Recipes: `set-up-the-machine` and `cut-a-release`.

- **What Tade needs of the machine is declared by whoever needs it** (`programs`, `install`), reading
  it is free while asking the world is not, and **nothing installs anything**.
- **One package goes out, it is called `tade-sh`, and the command is still `tade`.** The staged tree
  has **no nested `package.json`** and the types come off at publish — not a build step, because every
  line stays where it is here. **Staging refuses rather than ships.**
- **A release is deliberate**: `git push --follow-tags` is the one act that reaches anybody,
  `release.yml` **calls `ci.yml`** rather than keeping a second copy of the gate, and publishing is
  over OIDC — **there is no npm token in this repository and there must never be one.**
- **What Tade writes for itself is under git** (`recordAuthored`), committed as `Tade` and never as
  the user — the fourth safety rail, with `--safe`, nothing loading unasked and no hot reload.

## Keeping the repo maintainable

- **`CLAUDE.md` is a link to this file**, so every agent reads the same words — and *all* of them,
  which is why its budget (`test/guide.test.ts`) may go **down** and never up.
- **A file over 800 lines is a conversation.** `test/modularity.test.ts` holds one budget per file
  (`DEFAULT = 800`, a line of its own for each file allowed to be bigger); a number goes **down** in the
  commit that earns it, never up, and one sitting more than `SLACK` above its file is the ratchet
  failing. **A coverage floor per package, and never one number for the repository**
  (`scripts/coverage-floors.ts`) is the same ratchet the other way — up, never down without an
  argument. **A number is not the goal**: a test that runs a function and asserts nothing raises every
  figure and makes the table lie, and what the instrument cannot see is named with its reason
  (`UNSEEN`) rather than mocked around.
- **`README.md` is the showcase**: a hero, a section per feature with a picture, then install and
  setup — which must stay findable. **Its pictures are generated, never taken
  by hand** (`pnpm screens --assets`, held to their bytes by `packages/app/test/pictures.test.ts`), so
  **changing how anything looks means redrawing them in the same commit** (`redraw-the-pictures`).
  Never advertise what is not built — that goes under Planned, at its port.
- **There is no `docs/` folder, and adding one is going backwards**: a plan lives in the work, then
  in the commit and the review, then in whatever fails when it stops being true.
  `test/guide.test.ts` fails if one comes back, and prints where the reasoning goes instead.
- **`.claude/skills/` holds the recipes** (the table above). Add or update one when you create a new
  extension point, or when a change teaches you something a recipe should have said — that, and a
  comment beside the code, is where reasoning goes now. Not `<TADE_HOME>/skills`, which is what Tade
  itself has learned.
- **Third-party notices are generated**: after changing dependencies run `pnpm notices`, or a test
  fails while the file is behind the lockfile and the script it is made from.

## Where things go

Every subsystem is a folder under `packages/` whose `core` holds the port and the conformance suite,
with the siblings implementing it: `drivers/*` (`WorkspaceDriver` — `pty`, `tmux`), `harnesses/*`
(`WorkerAdapter` — pi, Claude Code, Codex), `voice/*`, `judges/*` (`jev` answers), `forges/*`
(`github`), `checks/*` (`Runner`), `mcp/*` (`McpTransport`, naming, the broker), `extensions/core`
(`TadeExtension` and its host) and `telemetry` (`Reporter`). Most have a `scripted` sibling for tests.

The rest: `core` is the domain (object model, state machine, config, policy, memory, prompts);
`status` observes reality; `workbench` is what Tade holds while open (lanes, journal, notes, agents);
`extensions/*` are the ones that ship; `orchestrator` is the thing you talk to; `app` is the window;
`cli` is the `tade` binary. Outside it, `test/fixtures` has `mkrepo.ts` and transcript samples.

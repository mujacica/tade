---
name: change-the-queue
description: Change how work waits, starts, repeats and finishes — the SMART QUEUE, done rules, plans, schedules and watches. Use when adding a done rule, a way to change queued work, a kind of schedule, or when queued work, a schedule or a watch does the wrong thing.
---

# Changing the queue

Work that is not running yet is still Tade's to keep track of: queued work waiting on other work
or a time, schedules that make work on a clock, and watches that look for work to make. None of it
is a daemon and none of it is a model deciding again: the window applies pure rules to the task
files, `schedules.jsonl` and the journal on every look at the tasks, and writes down what it did.

| Path | What |
|---|---|
| `packages/core/src/done.ts` | when a task is finished: `finishedFrom`, `ruleMet`, `workedFrom` |
| `packages/core/src/queue.ts` | `Queued`, `queueStateOf`, `readyToStart`, `inWrittenOrder`, `startFrom`, `collidesNow`, `checkPlan`, `overlaps`, `QUEUE_CHANGES` |
| `packages/core/src/produces.ts` | what a task produces instead of code: `producesProblem`, `producedIn`, `producedClause` |
| `packages/core/src/effort.ts` | one change across repositories: `effortsIn`, `effortSays` |
| `packages/core/src/schedule.ts` | `When`, `ScheduleDoes`, `runsOf`, `dueNow`, `watchedFrom`, `newFindings`, `standingSchedules`, `scheduleIdOf`, the words for each |
| `packages/core/src/events.ts` | `task_done`, `effort_named`, `queue_*`, `schedule_*`, `watch_*` |
| `packages/workbench/src/workbench.ts` | writing it down: `markDone`, `planTasks`, `startQueued`, `holdQueued`, `setSchedule`, `fireSchedule`, `watchChecked`, `watchFound` |
| `packages/workbench/src/schedules.ts` | `schedules.jsonl`: every change a line, with who made it; `readEverMade` |
| `packages/workbench/src/tasks.ts` | `by`, `done`, `start` and `produces` in a task file; `producedDetail`; `beginFrom` for stacked worktrees |
| `packages/app/src/live.ts` | `QUEUE_READS`: what the rules read, from the whole journal; `lookAtTrees` at the moment of starting |
| `packages/app/src/app.ts` | the passes: `advanceQueue`, `runSchedules`, `fire`, `lookWith`, and `queueTools` for the orchestrator |
| `packages/app/src/wire/schedules.ts` | the one door: `Schedules.set`, `mayWatch`, `turnWatch`, `writeStanding` |
| `packages/app/src/queue.ts` | what is said: the schedule card's facts, what the orchestrator is told, why an empty list is empty (`queueEmptySays`) |
| `packages/app/src/queue-view.ts` | what the SMART QUEUE shows: the scope, `shownBy` |
| `packages/app/src/schedules-view.ts` | a watch's trouble and when it may stop being drawn: `hush`, `unhush`, `wasHushed` |
| `packages/app/src/view/queue.ts`, `view/plan.ts`, `plan-graph.ts` | the SMART QUEUE, the cards, the plan |
| `packages/app/src/view/schedule.ts` | SCHEDULES: the section, a rule's row, a watch's card |
| `packages/orchestrator/src/tools-extension.ts`, `tool-host.ts` | `tade_done`, `tade_plan`, `tade_queue`, `tade_queue_change`, `tade_schedule` |
| `packages/extensions/core/src/port.ts`, `host.ts` | `ExtensionWatch`, and the host that looks with one |
| `packages/extensions/deps/src/updates.ts` | the worked example of a watch that edits a project |

## Rules

- **Rules are pure and live in core.** Whether work is ready, a schedule is due or a finding is new
  takes facts and `now` and returns an answer. Test the rule in core; the window only applies it.
- **Queued work is a task.** A task file with `start` — never a second store. It is made when it is
  planned, in the project's own workspace, and started by `startQueued`.
- **A task is finished when the journal says so** (`task_done`), and the rule is the task's own:
  `done` in its task file — `said`, `idle`, `committed`, `merged`, `manual` (`DONE_RULES` and
  `DONE_RULE_MEANS` in `core/src/model.ts`) — chosen by whoever made the task. Its agent says it
  (`tade_done`), a person or the orchestrator marks it, or the window sees the rule met and writes
  that down once. Never infer it from a turn ending, because an agent that asked a question looks
  exactly the same, nor from a checkout agent having stopped, which status already calls `review`. A
  squash-merged branch counts as merged: its commits are nowhere in the base, so where there is no
  ancestry to follow Tade asks whether merging it would still change anything (`status/src/git.ts`).
- **A task may say what it produces, and a document is not a change to the code.** An agent sent to
  plan, audit or research writes one, and a task finishing reached the orchestrator as a single
  line — the summary its agent wrote — with nothing saying a document existed or where, so a person
  had to say "the research agent is done, go and read it" every single time. So a task names it
  (`produces` in its task file, written when the task is made like `done` and `start`), its agent is
  told where to write it and to commit it (`composeAgentPrompt`), and the line that says it finished
  carries the path and whether the file was actually there (`producedDetail` — which checks the path
  again on the way into the journal, because the file on disk is somebody's to hand-edit). **On
  `task_done` rather than looked up afterwards**, because the journal is the only thing that
  remembers: the task's folder goes when the task does, and a window that was shut when an agent
  finished still has to open knowing there is something to read — which is what the briefing's own
  section is for, uncapped like `held`, because a document lost to a per-project cap is the whole
  bug back again. What happens to it afterwards is answered by where it may be: `producesProblem`
  refuses anything under `.tade/`, which git ignores and Tade removes with the task, so it is an
  ordinary file the agent commits and that survives on its branch. What has been done about one is
  **derived, never remembered** (`producedIn`): work made since it finished that waits on it, and
  its own agent being started again — the two marks the two useful answers leave — so "nothing has
  been done about it yet" (`actedOnSays`) stops being said the moment something has. There is no
  research mode and no lifecycle of its own: a task is a task, and this is one optional field on it.
  And Tade **tells, it never starts**: what to do about an analysis is a judgement, and a rule that
  queued work off a document would fill the queue with guesses.
- **A plan may span repositories, so nothing in it may assume one.** An agent's project is its own
  (`PlannedAgent.project`, the plan's when unsaid, through `projectOf` — so every plan written
  before the widening means what it meant), a wait is a qualified id and resolves anywhere, and what
  a project answers about itself is asked per project (`PlanContext.workspace`, `workspaceFor`). Two
  rules are easy to get wrong and are worth re-reading before touching either: `overlaps` compares
  paths **only inside** one project (two `src/index.ts` in two repos are two files, and warning that
  they collide is a lie the widening would otherwise have invented), and `startFrom` never hands a
  ref across one — the upstream map is flat because a wait is, so without the project a task in
  `sentry-cli` waiting on one in `sentry` was handed `sentry`'s branch name for `git worktree add`,
  which fails in the good case and in the bad one finds a ref of that name that is somebody else's
  work entirely. A cross-repo wait is a wait on *when*, and the other repository's commits are not
  this one's to build on.
- **What a plan guessed is checked against the tree before anything starts.** `touches` is one
  reading of the code, made when the plan was written; by the time work is about to start, agents
  have been changing files for an hour. So the window looks (`lookAtTrees`) at the moment of
  starting — and only then, and only at the projects the rule already says something is ready in:
  what is changed and not committed, and what each agent with a run still open has committed since
  it started, whose is read back out of the `Tade-Task:` trailer and never guessed. Overlap it did
  not expect holds it (`collidesNow`), through the one hold path there is. Only in a shared
  checkout: with a worktree each, nothing is being changed under anybody, and what two branches do
  to one file is a merge, which the plan already said. **Evidence may only ever hold**: it reaches
  `readyToStart` through `queueStateOf`, so it can never start what the rule would not, never jump a
  wait, never unhold and never exceed `max_parallel` — and held work is not ready, so it never takes
  the slot of work behind it. It heals rather than waiting on a person: the look that finds the
  files settled starts the work, and until somebody looks again the last hold written stands
  (`writtenCollision`), so every reader says the same thing.
- **An effort is a name for related work, never a lock on a file.** A change that spans repositories
  is a name, the sentence, and one ordinary task per repository — never a task with several
  workspaces, because a lane has one `cwd`, `done: merged` has no meaning across three branches, and
  the `Tade-Task:` trailer would stop naming one history. It lives **nowhere new**: `TaskFile.effort`
  is one optional field and an effort is the *fold* of the task files that name it (`effortsIn`), so
  a removed task leaves it correctly smaller and there is nothing to keep in sync — a table would be
  wrong the moment somebody removed one. `effort_named` records the slug and the sentence
  **verbatim**, once, for the same reason `intent_spoken` is journalled: nothing else can recover the
  sentence. There is no `Tade-Effort:` trailer, no effort-level done rule, merge, review or branch —
  a fourth rule above three rules is a rule that will disagree with them and nothing could say which
  was right — and **no state**: until every task in it has finished it has a *list* (`effortSays`),
  because "two of three" is not something anybody can act on and *which one is not* is. The tree
  evidence must not learn the word either: "different effort" is not collides harder, and — the
  dangerous one — "same effort" is never permission. Two agents in one effort editing one file in
  one checkout is the same accident as any other.
- **The queue is shown as the tree it resolves to.** `queueTree` (`app/src/model.ts`) orders queued
  work by the path it is on — what comes next first, and under each piece whatever waits on it —
  from the states the rules derived, never from the plan alone; `queueRows` is that list as the
  view has it (`queue-view.ts`), which asks one question: a scope, `all` or `next`, a position in that
  tree. The side shifts each piece right of what it waits on (`queueStems`), and a card draws the chain with `chainOf` + `drawPlan`, the same
  drawing the plan view uses. **Clicking queued work opens its card, never starts it**: starting is
  `queue-start` through `queueTools().change`, so the journal says who started it and why.
- **Queued work and standing rules are two sections, and the split is what makes either readable.**
  SMART QUEUE (`queueSection`) is work: one thing that will start once, with a place in the tree, a
  reason it waits and an agent that will be told something. SCHEDULES (`schedulesSection`,
  `view/schedule.ts`) is rules: each fires again and again, has no place in the tree and nothing waits
  on it. They shared a section because both are "things that have not happened yet", which is the
  whole of what they share — with eight schedules across two projects the queue was mostly not a
  queue, and the two kinds were told apart only by a glyph. **So the queue has no control over what
  is on a clock.** There was a `timed` switch, invented because the schedules crowded out the work
  waiting on us; what is left on a clock in the queue is one-off work waiting on a time instead of on
  another task, as much the queue's as anything in it, and a switch over it would be a second way of
  saying what the section boundary says. A rule's row holds: how often, whether firing makes work or
  tells somebody (`scheduleMakes` — the difference between an agent at 3am and a sentence to read),
  when it next fires, when it last looked and what that came to, and its project where the list is
  more than one project's. **A look that failed says so in words and may be hushed** — keyed by the
  reason (`hush`, `wasHushed`), dropped by a look that worked (`unhush`, in `doLookWith`), so a watch
  failing the same way every ten minutes is said once rather than every ten minutes — and hushing
  takes the sentence, never the `!` or the heading's count, because a broken watch a person cannot see
  is what a section exists to prevent.
- **Write it down, then do it.** `schedule_fired` before a schedule's task is made, so a window that
  stops half way never runs it twice; `watch_found` for every finding, a failed start included, so
  one finding never makes work twice; `watch_checked` for every look — how much it found, which was
  new, how much waits for the next look and where that look starts, or why it could not look — which
  is how a watch keeps nothing itself. Starting queued work writes why (`queue_started`, with what
  it waited on, and `reopened` where its agent already had a conversation to pick back up), and
  holding it writes what held it (`queue_held`: what it was waiting on, a start that failed, or the
  files that had changed under it and whose).
- **Read from the whole journal.** Live keeps only the last 500 events; anything a rule reads goes
  in `QUEUE_READS`, or a busy morning makes the queue forget.
- **One pass at a time.** Each pass is single-flight (`advancing`, `scheduling`, `lookingWith`), and
  what is being started is remembered until the journal says it started.
- **Nothing happens silently, and nothing is said twice.** What the window did is a transcript line
  and news for the orchestrator (`addNews`), which goes with the next thing said to it; what needs
  it now is `tell()`, delivered after its turn. A hold is said once (`holdSaid`); a watch that
  cannot look is said when it starts going wrong, not at every look.
- **People decide what was held.** The orchestrator is told and asks the person; their choice is a
  `queue_changed`, read back by the rule.
- **An order is a written fact, and only a preference.** `inWrittenOrder` reads the last `order`
  somebody wrote and the window sorts what it hands `readyToStart` with it — so it changes which of
  the ready ones goes first and nothing else. It can never jump a wait, unhold a hold, resume a
  pause or exceed `max_parallel`, and nothing recomputes it: the last line written wins, so nothing
  can be starved by something newer looking better. A model may suggest one; a person or the
  orchestrator writes it down, with a reason of their own.
- **Only while a window is open.** What came due while none was is caught up once or skipped, as
  the schedule says (`dueNow`), never once per run missed.
- **A standing watch is written once, and removed it stays removed.** A watch may declare that it
  stands (`standing`), and then the window writes it — once, per project, through the same
  `setSchedule` everything else goes through (`standingSchedules`, written by `writeStanding` on the
  pass that runs what is due). From that moment it is ordinary: in the queue, and pausable,
  changeable and removable like any other — and because `schedules.jsonl` is append-only, the id it
  held is a fact that outlives it (`readEverMade`, which nothing rotates, unlike the journal), so a
  schedule somebody took away is never written back. Three refusals and no judgement: the watch says
  it stands, its extension can look *right now*, and nothing has ever been written under that id.
  The middle one is what makes the no-key case exact — with no key the extension is not ready, so
  there is no schedule at all rather than one failing every ten minutes. A watch may only declare it
  where being on costs nothing anybody has to agree to: no credential of somebody else's, nobody
  outside told anything, and a look that finds nothing spending nothing. Its first look is one
  interval away rather than the moment it is written, so opening Tade is never a reading of
  everything.
- **One door for turning a watch on, and one id for naming it.** Every way in goes through
  `Schedules.set` — the first minute, the Extensions page, `tade_watch_change` and `tade_schedule` —
  so `WATCH_REACH` is checked there (`mayWatch`) and not in each tool: a rule with a door beside it
  that nobody guards is worse than no rule, because it reads like a promise. What it does not hold
  is the queue's own pause and remove, and `WATCH_REACH` says so rather than papering over it. All
  of them name the schedule the same way (`scheduleIdOf`), so the Extensions page's button turns off
  what the first minute turned on; and that id is how a watch remembers what it has found, which is
  why turning one off **pauses** it rather than removing it — remade, it would come back with no
  memory and start work on everything it had already dealt with.
- **Whether the machine has a network is one answer, held once, and never a watch's to guess.**
  A watch that reaches off this machine says so (`ExtensionWatch.network`, carried onto
  `WatchOffer`), and the scheduler asks its reach before it runs one (`mayRun`, `Network` in
  `app/src/wire/network.ts`, over the pure fold in `core/src/network.ts`). Offline, the look **does
  not happen**: no request, no `watch_checked`, no red line, and `since` untouched — so the first
  look once the network is back finds everything since and the missed runs catch up like any
  schedule's. It went in because four watches on four timers each discovered one night's outage by
  making a request and waiting for it to fail, a dozen times from one watch alone. Two rules hold it
  honest. **One endpoint being down is never the machine being offline**: nothing a service *said* —
  a 404, a 500, an auth failure, a rate limit — may pause anything, which is why `ForgeError`
  separates `server` (it answered) from `network` (nothing came back), `commit.ts` separates
  `would not answer` from `unreachable`, and only the second is thrown as `Unreachable`. And the
  failure is never the evidence, only the prompt: what decides is a look at *this machine* — an
  interface that is a way out (`anyRoute`), then a name lookup of the host that watch needed
  (`reachedResolver`, `dns.resolve` and never `lookup`, whose cache answers the wrong question).
  The one line is said on the edge and only there (`reachSaid`), because a window that has quietly
  stopped looking must still be legible.
- **Which projects there are is asked at every look, and a project that is not open is nothing to
  watch.** A watch names its project and resolves it when it looks, so the list it is resolved
  against is read from the config each time (`projectsOf`; the window hands the host each new config
  through its one write path, `Settings.use` → `ExtensionHost.useProjects`) and never held from when
  the extensions loaded — a held list is how `there is no project called zahlenzauber (there is tade,
  tade-web)` came to be said about a project that had been open for an hour, by three watches, every
  ten minutes, until Tade was started again. The other half is the opposite case: a watch outlives
  the project it names, because closing a project leaves its schedules exactly where they are, so a
  look at a closed one is a look at nothing (`nothingToWatch`). That is not a failed look — nobody
  has anything to do about a project somebody closed on purpose — so it is a `watch_checked` with a
  `said` and no `problem`, on the same terms as every other quiet fact: said once, when it starts
  being true, and the watch keeps everything it has found for when the project is opened again.
- **A watch that edits the project is defined by what it will not do.** `deps.updates` is the worked
  example, and every decision in it is about the morning after, because a daily robot that edits
  manifests is the kind of thing people turn off after one bad morning. **Patch and minor, never
  major**: those two promise not to break you and the checks say within the hour when they did, where
  a major promises the opposite and is somebody's decision — so majors are *named* (`majorsSaid`, and
  by the agent when it finishes) and never bumped by a clock. **The patches are one commit and each
  minor is its own**: twenty agents in one checkout is twenty installs racing one lockfile, twenty
  bumps in one branch is a diff nobody reads, and a minor that breaks something has to be
  identifiable, which a wall of them is not. **A package at a version is the key**, so a bump that
  failed is not tried again tomorrow and a release after it is new information; past
  `extensions.deps.attempts` bumps of one package in a fortnight (`TRYING_DAYS`) it is told about and
  never tried again — the review watches' rule, over a window long enough for a daily look to see
  yesterday. **Nothing red is committed**: the value is not the bump, it is the evidence that the
  project still works on it, so the agent runs the project's own checks through `checks_run` and
  where it cannot make them green it puts the manifests back and says so. And **never in a checkout
  other agents share**: `sharesTheCheckout` reads `workspaceFor` before anything else is read, said
  once rather than at every look, and names both ways out — set the project's `workspace` to
  `worktree`, or turn the watch on with `in_checkout` to say it may. A config nobody could read
  counts as the checkout, because that is the machine's own default and guessing the safe-looking
  answer here would be guessing the one that lets a clock rewrite a shared tree.
- **Every word for the orchestrator is in one place**: `app/src/queue.ts` and core's `describe*`.
  The view draws `QueuedView` and `ScheduleView` and nothing else.

## Steps

**A done rule.** Add it to `DONE_RULES` and `DONE_RULE_MEANS` (`core/src/model.ts`), decide it in
`ruleMet` (`done.ts`, with a test in `done.test.ts`), refuse it where it cannot hold (`createTask`
refuses `committed` and `merged` in a shared checkout), and add it to the `done` enum in
`tools-extension.ts`. Accept the orchestrator's golden `tools.json`.

**A way to change queued work.** Add it to `QUEUE_CHANGES`, make `queueStateOf` read the
`queue_changed` it writes, word it in `queueTools().change`, and give the queued card or its menu a
button (`queueMenuItems`, the `queue-*` actions in `App.run`).

**A kind of schedule.** Add it to `ScheduleDoes`, do it in `fireSchedule` (workbench) and `fire`
(window), word it in `scheduleView`, say whether firing makes work or tells somebody
(`scheduleMakes`), take it in `tade_schedule` and `queue/schedule`, draw it on the row
(`scheduleRow`) and the card (`renderSchedule`) and in `tade schedules`. Test it in
`workbench/test/schedules.test.ts` and through the window in `test/wire/schedules.test.ts`.

**A watch.** It belongs to an extension: follow `add-extension`. Tade's side — turning it on,
looking, the journal, the queue, telling people — needs nothing new. Three places offer it and all
three go through the same rules, so none of them wants code of its own: the first minute
(`watchesToOffer` in `core/src/watches.ts`, drawn by `cli/src/commands/setup-watches.ts`), the
Extensions page (`Turn on` / `Turn off`, through `Schedules.turnWatch`), and the orchestrator
(`tade_watches`, `tade_watch_change`, held to `WATCH_REACH`). What a new watch decides is only what
it declares — `standing` where being on costs nothing anybody has to agree to, and `offers: 'ask'`
where it starts nothing, which is also what decides whether the first minute ticks it. Most watches
fail the bar for standing and are offered instead: `deps.vulnerabilities` starts an agent per
vulnerable package, and work queued by a clock nobody agreed to is the surprise at three in the
morning. Ticked in the first minute is only ever a watch that tells you something and starts
nothing — pressing enter without reading has to mean being told, never four agents in four lanes by
morning.

Tests: the queue's own list is `packages/app/test/queue-view.test.ts`, the standing rules are
`packages/app/test/schedules-view.test.ts` — two files because they are two subjects, which is the
same reason they are two sections.

Then: a screen scenario for anything drawn (`test/screens/scenarios/queue.ts`, `pnpm screens`, accept on
purpose), one line of invariant in `AGENTS.md` if a rule changed — with its argument here rather than
there — and `pnpm check` on its own.

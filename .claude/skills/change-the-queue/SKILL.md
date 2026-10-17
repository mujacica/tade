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
| `packages/core/src/queue.ts` | `Queued`, `queueStateOf`, `readyToStart`, `choicesFor`, `startFrom`, `collidesNow`, `atWorkFrom`, `checkWaits`, `QUEUE_CHANGES` |
| `packages/core/src/queue-order.ts` | the written order, only ever a preference among the ready: `writtenOrder`, `inWrittenOrder`, `orderFirst` |
| `packages/core/src/plan.ts` | a plan before it is made: `checkPlan`, `overlaps`, `wholePackage` |
| `packages/workbench/src/packages.ts` | which folders a plan names are packages, looked up in the tree: `packagesOf` |
| `packages/core/src/produces.ts` | what a task produces instead of code: `producesProblem`, `producesPath`, `documentsIn`, `documentsToCompact`, `producedClause` |
| `packages/workbench/src/documents.ts` | triage (an approval needs the person's line), `deleteDocument`, `cleanupDocuments`, `settleDocuments` on open, `removedDocument` |
| `packages/workbench/src/agent-tools.ts` | `tade_document_ready`: an agent handing its document over before it finishes |
| `packages/core/src/effort.ts` | one change across repositories: `effortsIn`, `effortSays` |
| `packages/core/src/schedule.ts` | `When`, `ScheduleDoes`, `runsOf`, `dueNow`, `watchedFrom`, `newFindings`, `standingSchedules`, `scheduleIdOf`, `DECIDES` and `decidesOf`, the words for each |
| `packages/core/src/proposals.ts` | what a schedule, a watch or an agent's leftovers put to the orchestrator instead of starting: `relatedWork`, `describeProposals`, `describeLeftovers`, `proposalsIn`, `PROPOSAL_DECISIONS` |
| `packages/core/src/leftovers.ts` | what an agent found and did not fix: `readLeftovers`, `leftoverWork`, `AGENT_TEXT_IS_MATERIAL`, `leftoversIn`, `whereFile` |
| `packages/core/src/events.ts` | `task_done`, `effort_named`, `queue_*`, `schedule_*`, `watch_*`, `proposal_decided`, `leftovers_reported` |
| `packages/workbench/src/workbench.ts` | writing it down: `markDone`, `planTasks`, `startQueued`, `holdQueued`, `setSchedule`, `fireSchedule`, `watchChecked`, `watchFound` |
| `packages/workbench/src/found.ts` | a finding or a schedule's run made into work — queued, or parked as a proposal: `makeFoundWork`, `fireAgentSchedule` |
| `packages/workbench/src/leftovers.ts` | `tade_leftovers`, and `tade_done`'s `leftovers`, each item made parked work: `reportLeftovers` |
| `packages/workbench/src/queue-changes.ts` | `changeQueued`: a choice about queued work, and `after` and `retell` written into its task file; `handOnWaits` for a removal |
| `packages/workbench/src/schedules.ts` | `schedules.jsonl`: every change a line, with who made it; `readEverMade` |
| `packages/workbench/src/tasks.ts` | `by`, `done`, `start` and `produces` in a task file; `producedDetail`; `beginFrom` for stacked worktrees |
| `packages/app/src/live.ts` | `QUEUE_READS`: what the rules read, from the whole journal; `lookAtTrees` at the moment of starting |
| `packages/app/src/app.ts` | the passes: `advanceQueue`, `runSchedules`, `fire`, `lookWith`, and `queueTools` for the orchestrator |
| `packages/app/src/wire/schedules.ts` | the one door: `Schedules.set`, `turnWatch`, `writeStanding`, and `where` |
| `packages/app/src/wire/queue-holds.ts` | what holds work as it starts besides the rule: `planHold`, `intakeSays`, `plansFor` (asking first), `probingNow`, `standsFor` |
| `packages/app/src/wire/watch-tools.ts` | the orchestrator's `tade_watches` and `tade_watch_change`, held to `WATCH_REACH` (`mayWatch`) |
| `packages/core/src/watch-where.ts`, `app/src/wire/watch-where.ts` | one machine per repository: `watchWhere`, `watchingIn`; `whereNow`, `notLooking` |
| `packages/app/src/wire/proposals.ts` | what a look's findings become, and a decision carried out: `actOnFound`, `offerProposals`, `putToOrchestrator`, `workNow`, `decideProposal` |
| `packages/app/src/wire/leftovers.ts` | what an agent left, told to the orchestrator the moment it is written down: `offerLeftovers` (from `tellNow`, `wire/handed.ts`) |
| `packages/app/src/wire/batches.ts`, `core/src/batches.ts` | the full checks once a batch, and a red batch made one proposal (`change-the-checks`) |
| `packages/app/src/queue.ts` | what is said: the schedule card's facts, what the orchestrator is told, why an empty list is empty (`queueEmptySays`) |
| `packages/app/src/queue-view.ts` | what the SMART QUEUE shows: the scope, `shownBy` |
| `packages/app/src/schedules-view.ts` | a watch's trouble and when it may stop being drawn: `hush`, `unhush`, `wasHushed` |
| `packages/app/src/view/queue.ts`, `view/plan.ts`, `plan-graph.ts` | the SMART QUEUE, the cards, the plan |
| `packages/app/src/view/schedule.ts` | SCHEDULES: the section, a rule's row, a watch's card |
| `packages/orchestrator/src/tools-extension.ts`, `tools-queue.ts`, `tool-host.ts`, `host-queue.ts` | `tade_done`, `tade_plan`; `tade_queue`, `tade_queue_change`, `tade_schedule`, `tade_proposal_decide` |
| `packages/cli/src/commands/queue.ts` | `tade queue` start, wait, pause, resume, order, after, retell: `changeQueued` as yours, refused while a window holds the home |
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
  told the one path to write it at (`composeAgentPrompt`), and the line that says it finished
  carries that path and whether the file was actually there (`producedDetail` — which checks the name
  again on the way into the journal, because the file on disk is somebody's to hand-edit). **On
  `task_done` rather than looked up afterwards**, because the journal is the only thing that
  remembers: a window that was shut when an agent finished still has to open knowing there is
  something to read — which is what the briefing's own
  section is for, uncapped like `held`, because a document lost to a per-project cap is the whole
  bug back again. **Where it goes is the project's documents folder in Tade's home**, one folder per
  task (`producesPath` → `<home>/projects/<p>/documents/<task>/`): `produces` is a *name*,
  `producesProblem` refuses anything that is a path out of that folder, and nothing of it is in the
  repository or in a commit. It used to be a path in the repository, committed — which charged every
  project Tade touched an oauth-scope audit in its history — and then the task's own folder, which
  `removeTask` deletes: thirteen of sixteen documents on one machine went with their agents that way.
  **A document outlives its task**: removing one writes `kept: true` on `task_removed`, and a document
  an agent told under the old rule left in its task folder is moved out first (`document_moved`), on
  removal or on the next open. What deletes one is a person asking (`deleteDocument`, with their
  reason) or the cleanup (`cleanupDocuments`, on open and via `tade_documents_cleanup` / `tade
  documents cleanup`), which takes only what `documentsToCompact` allows: **triaged**, at least
  `documents.keep_days` ago, everything queued off it finished, its agent not started again — never an
  undecided one. Each is a `document_deleted` line, so "what happened to it" is always answerable.
  Anything that genuinely is the project's — a README, a skill, a changelog — is an ordinary change
  and never was this field. Both the agent's sentence and the tool's description say the home
  and say *not committed*, because one place saying the repository is one place agents will believe.
  What has been done about one is
  **derived, never remembered** (`producedIn`): work made since it finished that waits on it, and
  its own agent being started again — the two marks the two useful answers leave — so "nothing has
  been done about it yet" (`actedOnSays`) stops being said the moment something has. There is no
  research mode and no lifecycle of its own: a task is a task, and this is one optional field on it.
  And Tade **tells, it never starts**: what to do about an analysis is a judgement, and a rule that
  queued work off a document would fill the queue with guesses.
- **A document is handed over when it is ready, not only when its task ends.** The commonest reason
  a plan goes back to somebody is a question — which of these, is this right — and an agent that
  asked one is not finished, so `task_done` could not carry it without starting what waits on it.
  So its agent calls `tade_document_ready` with the one thing it needs decided (`asked`) and, by
  default, stops (`waits`). It is one of Tade's own agent tools, registered by every harness that
  registers `tade_done` and answered in the window like an extension's (`answerAgentTool`,
  `workbench/src/agent-tools.ts`), so a refusal — nothing produced, nothing written yet — reaches
  the agent as a failed call. The line is `document_ready`, `blocking` while it waits; `documentsIn`
  puts the document on the waiting list at once, and a finish in the run that was answered keeps the
  answer (`handed`) rather than asking the person again. **The window tells the orchestrator now**
  (`eventTell`, `app/src/inbox.ts`), not as news: news waits for somebody to speak, and a planner
  waiting on "A or B?" is waiting for exactly that, so the two would wait on each other. A finish
  with a document written is told now too. What it is told is the rule at the moment — read it, say
  where things stand, put what is next to the person, queue nothing first — and `RULES` says the
  same, because what follows a document is the person's, put to them, never the orchestrator's.
- **Work may wait on the person approving a document** (`after` with `approved`): plan, they
  approve, build. Finished *and* approved, in either order (`approvedFrom`, read off `documentsIn`'s
  newest document of that task, so the queue and the waiting list never disagree), and a document
  handed over again is a new question that takes the approval back. It only ever holds — `waiting`
  with `approval` — and it is refused where nobody could ever approve, on work that produces
  nothing (`checkPlan`, `checkWaits`, `templateProblems`). **An approval is the person's**:
  `triageDocument` takes `approved` from anybody but the person only with `said`, a line of theirs
  the journal has them saying lately (`LINES_LOOKED_BACK`) — the `namedBy` barrier, because text an
  agent read can never reach a `said` line, and a document asking to be approved is the case it is
  for. Work made to wait for an approval is not anybody having acted on the document
  (`task_created`'s `approval`), so it stays on the list until they decide. The built-in
  `plan-approve-build` template is the shape.
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
  this one's to build on. Work that says where it begins (`start.from`, written from a watch's
  `WatchAgent.from`) begins there and nowhere else: it is a change to one branch — a review that
  conflicts — and anything merged in under it would be pushed to that review with the fix.
- **The plan's own project is a default, and a plan that spans repositories may not lean on it.**
  Where one agent names another repository and another names none, `checkPlan` refuses the plan and
  names the ones that said nothing — because inheriting is right in a one-repo plan and silently
  wrong the moment it is not, and a task in the wrong project looks exactly like one somebody meant
  to put there. Twice a plan of two connected halves was written with a project on one agent and
  none on the other, and the other half landed in the first's repository. The refusal is the second
  line of defence: the prompt (`RULES`) and the tool's own description say the field is a default
  before a model writes one, because what is only sometimes right reads like the answer.
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
  (`writtenCollision`), so every reader says the same thing. **A look git could not answer is not
  one that found the files settled** (`Reality.unread`): it read as nothing dirty and nothing
  committed, and let held work go on a look that never happened. Each half it could not read is the
  last that could (`TreeReads`, `checkout-look.ts`), the hold written stands and that look may only
  add one, and the queue says why once per project until a look can read it. **Who is at work is `atWorkFrom`**: a
  run `RuntimeFold` still calls open (so `QUEUE_READS` carries `AT_WORK_READS`, every end of a run),
  of a task the last look listed, whose *own* workspace is the checkout, and unfinished — so a name
  in a hold is always a task the tools take. Reading only `run_started` and `run_exited`, it kept a
  CI fix removed in a worktree of its own in every hold in tade's checkout for a day.
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
- **Starting parked work picks it up, in one act** (`pickUpToStart`, `workbench/src/parked.ts`).
  Work a watch or a template makes parked waits for somebody to say go, and *Start now* — the card,
  the menu, a queue row's ▶, the away view's `start`, `tade_queue_change` — is saying it: the park
  is lifted as whoever asked (`state_change` with `by`), then the start is written, and the queue's
  own pass starts it with every other hold still in front of it and said. A start is also newer
  than the pauses written before it — its own, and its project's whole queue for that one piece
  (`choicesFor`'s `startedAt`) — and a pause written after it holds again. Both used to stand: the
  row's ▶ was a resume, which lifts no park, and six presses on 2026-10-16 started nothing. Nothing
  parked starts by rule (`queueStateOf` reads the park first, `startQueued` refuses one), and work
  from outside this machine is the one park a start lifts only for the person at it (`NotYours`).
- **Write it down, then do it.** `schedule_fired` before a schedule's task is made, so a window that
  stops half way never runs it twice; `watch_found` for every finding, a failed start included, so
  one finding never makes work twice; `watch_checked` for every look — how much it found, which was
  new, how much waits for the next look and where that look starts, or why it could not look — which
  is how a watch keeps nothing itself. Starting queued work writes why (`queue_started`, with what
  it waited on, and `reopened` where its agent already had a conversation to pick back up), and
  holding it writes what held it (`queue_held`: what it was waiting on, a start that failed, or the
  files that had changed under it and whose).
- **Read from the whole journal.** Live keeps only the last 500 events; anything a rule reads goes
  in `QUEUE_READS`, or a busy morning makes the queue forget. Except what a schedule did:
  `schedule_fired`, `watch_checked` and `watch_found` go to `ScheduleFold` (`app/src/schedule-fold.ts`),
  which keeps how many times each schedule ran, every finding, where the next look starts and only
  the newest runs and looks to draw — two lines a look were 24 MB of a window. A rule that needs more
  of them than that is a new tally there, never the lines back in the queue's list.
- **One pass at a time.** Each pass is single-flight (`advancing`, `scheduling`, `lookingWith`), and
  what is being started is remembered until the journal says it started.
- **Nothing happens silently, and nothing is said twice.** What the window did is a transcript line
  and news for the orchestrator (`addNews`), which goes with the next thing said to it; what needs
  it now is `tell()`, delivered after its turn. A hold is said once (`holdSaid`); a watch that
  cannot look is said when it starts going wrong, not at every look.
- **What would collide is forecast, told once, and only ever told.** Status looks
  (`status/src/conflicts.ts`): with a worktree each, `git merge-tree --write-tree` between each pair
  of live branches and each branch against a base that moved, kept by the pair of commit ids so a
  beat where no branch moved spawns nothing; in a shared checkout, two agents whose harness said they
  wrote one changed file (`writes` on `tool_call`, kept by `Doings`, carried on the liveness table)
  and neither write older than the last commit of it (`hunksFrom`). Every `Project.conflicts`, marked
  `⇄` on both agents and in the plan. **Across machines** too, where one repository is a project
  here and on a remote: this machine's live branches against that one's, merged in this home's
  mirror (`elsewhere`, `wire/mirrors.ts`), the other side named `<task> on <machine>` and never a
  task id the tools take — the side here is the one told (`whoYields`), with where to fetch the
  other branch from, because the side there is that machine's and reached only through its own
  orchestrator. Nothing is held or said on the other machine. The queue's pass tells it
  (`wire/forecast.ts`): a `conflict_forecast` line first, so it is said once per collision and
  again only for a new file, and a `gone` line when it heals. It goes by `tell()`, not news, because the person asked for the
  orchestrator to resolve it without them, and news waits for them to speak; `conflictSays` names
  the one call (`whoYields` picks who gives way, by rule) and whose it is to make is `queue.holds`.
  **It never holds, starts or stops anything**: a forecast is evidence, and what to do about two
  live agents is a judgement — the orchestrator's, with a tool behind every option it is offered.
- **Who decides what was held is the person's setting, `queue.holds`.** `orchestrator` (the
  default): it decides and says what it did; `ask`: it is told and asks them. Either way the
  choice is a `queue_changed`, read back by the rule, and it is words in what the orchestrator is
  told — its prompt (`describePosture`) and every hold (`heldMessage`, which reads the config at the
  hold, so it is newer than the prompt) — never a gate: it may do the same things under both, which
  is why it is `asked` and not `never` (`reach.ts`). It went in because the hold said "ask the
  person" right after the person had said that was the orchestrator's to decide, and the default
  became `orchestrator` because they asked for that on every machine, with `ask` theirs to choose
  in Settings. It is set by the person, never on a reading of their note: each value tells the
  orchestrator to offer the other when somebody says they want it. And **a hold
  says what is true and what to call**: the tree's heals by itself, so its message says so, names
  the agents at work in that checkout by the ids the tools take (`Reality.working`), and spells the
  one `after` call that makes it a wait on one of them — never a choice with no tool behind it.
- **A plan is refused whole, names included, and every reason in one answer.** `makePlan` asks
  `guardName`'s rule (`sameConversation`, with each harness's `keyOf`) of every agent before
  anything is written — a name any task has had, one that would carry on its conversation, two in
  the plan that would be one — and says them all with a free numbered name each. `effort_named` is
  written after that, and only when the sentence is new. Asked one task at a time as each was made,
  a plan made its first task, threw on its second, and the next attempt was refused over the task
  it had left behind. What still fails after the checks (a disk, git) is named, not removed:
  removing never gives a name back, and what was made is a prefix that waits only on what exists.
- **A brief the agents share is said once, and a blank left for it is refused.** `Plan.context`
  (`tade_plan`'s own `context`) is written beside every task file, ahead of an agent's own. With
  nowhere to put it, on 2026-10-13 thirteen prompts each ended in `PAGE_BRIEF`, and the repair was
  seventeen removals. So `checkPlan` refuses one placeholder in two or more prompts that nothing
  said or spelled out (`placeholdersIn`): a rule, never a judge, since refusing must be the same
  every time. It refuses one of the 43 plans the orchestrator had made by then, and it is that one
  (`test/fixtures/plans/page-brief.json`); widen the shapes only against that history.
- **A plan's warnings are only collisions somebody could act on.** What it is checked against is
  work still going or waiting to go (`planBusyOf` in the window, `busyFrom` for a dry run): never
  finished work, whose agent sits at its prompt and which status calls `blocked`, and "waiting on
  you" only where an approval is pending or an agent stopped without saying it was done. Each
  `PlanBusy` carries its `after`, so the walk follows existing waits and an agent is never warned
  about what it already waits on through a queued chain. There is one line per task run into, with
  how many more of the plan's agents run into it and which; a folder named whole is said once, as
  whose; and an agent whose `touches` is a whole package — the repository, a folder a manifest is
  in, its `src`, or a folder holding packages, looked up by `packagesOf` and never guessed from a
  path's shape — is warned about on its own. On 2026-10-11 one plan came back with 44 warnings and
  none of them were real: 28 named finished work, 11 named work the agent already waited on, and 5
  named an orphan that names checked first no longer leaves. `packages/app/test/plan-warnings.test.ts`
  holds that plan to none.
- **A plan is changed by writing on the work it made, never by removing it and planning it again.**
  `after` adds to what queued work waits on, or with `replace` swaps it; `retell` changes what its
  agent is told or what it says it will touch. Both write the task file's `start` — the one place
  queued work keeps them — under `aloneOn`, then a `queue_changed` line with who and what it was.
  Waits are checked by `checkPlan`'s rules across every task there is (`checkWaits`): each named
  task exists, nothing waits on itself, no loop through other queued work — and the check and the
  write are one act per home, so two waits written at once cannot close a loop between them.
  Adding a wait answers no trouble (it may only make a start later), and clears a start-anyway.
  There is **no rename**: a task's id is its folder, its conversation and its trailer, and renaming
  one is the reuse `guardName` exists to stop. It went in because on 2026-10-11 two holds became
  nineteen removals, twenty creations, three refused plans and an orphan: with no way to put a wait
  on work already made, removing it and planning it again was the only way to say "after that one",
  and every removal held everything downstream of it. The orchestrator is told so in one standing
  line (`CHANGED_IN_PLACE`, `core/src/compose.ts`), whoever decides holds; `tade_steer` says queued
  work has no agent to tell, and `tade_remember` that a note scoped to a task is in what its agent
  is told when it starts — the person's words added without changing what it was asked to do. Three
  cases in `live.test.ts` (add to it, fix its prompt, make it wait) hold a real model to it.
- **A change answers with where the work stands after the queue has looked again** (`nowSays`),
  never with what it meant to do: `wait` looks again from now and is not "wait for the files", so
  on work the tree still holds it is held again in the same second, and an answer of "waits again"
  is what sent the orchestrator off to re-plan. `remove` names what waited on it. What that look
  holds is written down as ever but told to the orchestrator in the answer it is reading
  (`answering`), not again a turn later. **What started is every start since the change was
  written, by any pass** (`settle`'s `since`): Live hears each journal line as it lands, so a pass
  already under way reads the change too and may be the one that starts the work — counting only
  the fresh pass answered a start that worked with "not queued any more".
- **A removal says what becomes of what waited on it** (`dependents`). `hold`, the default, is what
  removing always did: each is held on the task that went until somebody answers. `inherit` hands
  the removed task's waits on to each, in the place of the wait on it (`inheritWaits`), written into
  its task file with a `queue_changed` `after` line that names the task removed (`inherited`) and
  what it waited on before — so taking one task out of a chain holds nothing after it, where every
  removal used to spread through everything downstream. It is not checked the way a written wait is,
  because it can neither close a loop nor make a start later (everything it now waits on, it already
  waited on through the task removed), and for the same reason it leaves a start-anyway standing. A
  wait on work already gone is handed on as it was, never dropped. The removal runs inside the lock
  waits are written under (`handOnWaits`), so nothing can be made to wait on the task while it goes,
  and the queue's passes leave the waiting work alone until it has its new waits (`handing`).
- **An order is a written fact, and only a preference.** `inWrittenOrder` reads the last `order`
  somebody wrote and the window sorts what it hands `readyToStart` with it — so it changes which of
  the ready ones goes first and nothing else. It can never jump a wait, unhold a hold, resume a
  pause or exceed `max_parallel`, and nothing recomputes it: the last line written wins, so nothing
  can be starved by something newer looking better. A model may suggest one; a person or the
  orchestrator writes it down, with a reason of their own.
- **Work nobody here asked for waits on a nearly full plan** (`planTooTight`, `core/src/limits.ts`),
  asked at the moment of starting like the trees and through the one hold path: a request from outside
  always (`intakeStands`), and work a schedule or a watch made — `by: schedule:<id>` in its task file,
  carried on `Queued.by` and never looked up in a journal fold that forgets — where
  `queue.hold_scheduled` says so, on by default (`planHold`, `wire/queue-holds.ts`). It is what stops a
  night of watches on a box with nobody there from spending the morning's window. Each difference is
  argued where it is written. For scheduled work **an unknown plan does not hold**, because both
  subscription harnesses only say how full a plan is as their agents run, so holding on unknown would
  hold the one start that could make it known, for good. For outside work **an unknown plan lets one
  start through at a time** (`StartSays`: `probe`, saying in `queue_started`'s `why` that is why it
  went; any other `waits` for it, `probingNow`) — it held every one, which on a restarted VPS whose only
  work comes from outside was nothing ever starting; a wait is not a hold, needs no answer, and is said
  once (`waitSaid`), and once the plan is known the ordinary rule decides. A harness that can be asked
  without running anything (`anytime`, `askLimits`) is asked first, with a deadline (`plansFor`,
  `ASK_PLANS_MS`), and its answer preferred. And the hold is told with **its own answer**
  (`HoldTold.plan`, `ANSWERS.plan`), never "start it anyway" — a start while the window is that full is
  held and told again, which offered to the orchestrator is a loop. Work somebody asked for here is
  never held by it. The queue knows what came from outside only because `QUEUE_READS` carries
  `INTAKE_EVENTS`: without them every request read as yours and started with nothing asked.
- **What a schedule or a watch would start is the orchestrator's to decide** (`decidesOf`,
  `core/src/proposals.ts`, `wire/proposals.ts`). A watch only knows its keys, and one red commit is one
  key — so `review.branch-checks` put an agent on red CI on main, and ten minutes later put a second
  one on the next red commit, in the same checkout, while the first was still fixing the first
  (`tade/check-ubuntu-latest-failing-on-main-a`, `tade/check-macos-latest-failing-on-main-the`,
  2026-10-15). Whether a second agent helps is a judgement, and the orchestrator is the one with every
  task in front of it. So the work is made **exactly as before** — the same task, prompt, context the
  watch fetched and links — but **parked**, which is already what a proposal is (as intake under `propose`
  is), and `watch_found` / `schedule_fired` say `proposed: true`. The orchestrator
  is told **now** (`tellOrKeep`'s shape, never news, because the work waits on exactly this): what was
  found, its key, and what may already be on it — `relatedWork`, three facts and never a reading of
  meaning: made by the same schedule, sharing a link (the finding's links go on `watch_found` for
  this), or a name that starts the same way — each with where it stands and how long its agent has
  run (`RuntimeFold.openRuns`). It answers with **one tool**, `tade_proposal_decide`: `start` (the
  park lifted, the queue starts it), `after` (a wait written *while it is still parked*, then the
  park lifted — so "properly scheduled with the queue", never a hold by hand), `steer` (the agent on
  the task named is told, what this one would have read is added to its context file, and this one is
  removed) or `leave` (removed), each through the queue's own door, and then `proposal_decided` with
  `because` in its own words — the only record a `leave` has. The keys are untouched: a proposal is
  a finding found, so one finding is still offered once whatever became of it. **Nothing about it
  can start work silently or drop a finding**: with no orchestrator running, or a tell that failed,
  the work stays parked, the reason is said on screen as trouble and the message is kept as news;
  `proposalsIn` folds every proposal and what settled it — a decision, a person picking it up,
  a run starting, a removal — and the briefing lists the undecided ones uncapped, so a window shut
  before anybody decided opens knowing. With the window closed nothing looks, so nothing is found.
  **Intake is the one finding that is never a proposal**: its owner's grant is already the person's
  rule about whether that source's work starts (`takeIntake`), so under `propose` it waits on them,
  and the orchestrator cannot lift that park (`NotYours`). Work a watch says is always decided
  (`WatchAgent.parked` — `jev.mistakes`'s checks) is the opposite: a proposal **even under
  `decides: itself`**, because no rule may start it. It used to be parked "for a person" and was
  never put to anybody, so four `check-for-*` tasks waited on the person on 2026-10-16. A check the
  orchestrator proposes itself (`tade_propose_check`) is one too, marked on its own `task_created`
  with no schedule behind it, and decided with the same tool. And
  it is a setting on the schedule, `decides: orchestrator | itself`, absent meaning the orchestrator
  so every schedule written before it is routed: `itself` is the old way, for a schedule somebody
  wants run unwatched, and `Schedules.set` refuses `decides` where nothing starts (an ask, a watch
  that only tells) rather than keep a word nothing reads.
- **What an agent found and did not fix is a proposal too** (`core/src/leftovers.ts`). Agents leave
  what is outside their task — rightly — and used to say so only in their last message, where nobody
  acted on it: `bind: lan` refusing the phone's own address, the away cookie never renewed, Debian
  told to `brew install whisper-cpp` (2026-10-16). Every agent that can say it is done is told, in one
  line, to report it instead: `tade_done`'s `leftovers`, or `tade_leftovers` before then, each item a
  `title`, `where`, `why` and `sure`. Each becomes a task in the reporter's project, `by:
  agent:<task>` — an origin of its own, never "you" — made **parked**, its prompt Tade's sentence
  and the agent's words in its context file under `AGENT_TEXT_IS_MATERIAL`, because a report is
  material and never instruction. The report is **one** `leftovers_reported` line on the reporting
  task naming the task each item became; `proposalsIn` reads a proposal per item, and anything that
  looks a proposal up by its own task's lines reads the reports too (`linesAbout`). The window tells
  the orchestrator at once (`tellNow` → `offerLeftovers`), with what may be on each: `relatedWork`'s
  facts plus two for a leftover — another left at the same file (`whereFile`), a task whose
  `touches` cover it — and never the reporter itself, which said it is not on it. It is decided with
  `tade_proposal_decide` like any other, and an undecided one is in the briefing, uncapped and never
  aged. Sending the same report again — the tool, then `tade_done` with the same list — makes
  nothing twice: titles are compared per reporting task.
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
- **A watch on an outside source looks from one machine per repository** (REMOTE-TADE.md §9.5,
  `watchWhere`). Where one repository is a project here and on a remote, a review, a red build, a
  Sentry issue or a Slack request is found from both, and "one red commit is one finding" is two
  proposals to two orchestrators. So a watch that says it looks at the repository (`about:
  'repository'` — declared, never read off `network`, because Jev reaches a model and reads this
  machine's agents, which every machine has its own of) looks from the machine its project names (`projects.<name>.watches`: `here` or a remote), and
  unsaid from the remote where the repository is a project too — the machine that never closes — or
  here where none or several are. **Evidence may only hold**: a remote whose projection says it
  looks with the same watch on the same repository (`ProjectRow.watching`, built by `watchingIn` from
  this machine's own looks, matched by `repositoryNamed` through `Mirrors.sameAs`) keeps this
  machine's off whatever the key says, and the sentence says what to turn off where. A remote not
  heard from since the window opened holds what the last look said (`last`), as a tree's hold stands
  until a look can read it. Not looking is a quiet look (`notLooking`): `watch_checked` with `on` and
  `said`, said when it starts being true or says something new, and **no cursor** — the first look
  back here starts from the last moment the other machine had it (`Watched.elsewhereAt`, handed as
  `turnedOn`), because what came before was that machine's to find and its keys are not this
  machine's. A remote that starts looking is written down on the next pass (`handedOver`), not at
  the watch's next turn; `Schedules.set` and `turnWatch` refuse to turn on what another machine looks
  with, and `writeStanding` does not write it, so it is written the day it is this machine's. The
  row says `on vps` and the card `RUNS ON`; `tade_watches` says it per project; the Extensions page
  says `on vps` where its button was, and why beneath it (`WatchOfferView.elsewhere`, asked of
  `Schedules.where`), because a press there could only be refused. **No remote is called `here`**,
  the word `watches` uses for this machine: `tade remote add` refuses it (`NewRemoteName`), and a
  config that has one keeps working without it, the block ignored and said (`gone.ts`).
- **Work moves between machines by git, and the conversation never does** (REMOTE-TADE.md §9.2,
  `wire/moves.ts`, `wire/hand-over.ts`; the far half is `web-take.ts` behind `/api/take`). Queued
  work started on a remote instead ("Start on vps" on its card, `tade_task_move`) is the same task
  file made there — words, prompt, context, links, done rule, `at` — and removed here once taken,
  **parked meanwhile** so this queue cannot start it in the gap. A running task is handed over:
  asked there first (`check`), its agent told to commit what is its own and push, the window looking
  on its beat until origin has it and a turn has ended since — never on a guess that it is done —
  then made there with `start.from` on that branch (in a worktree there, whatever that project's
  workspace, because `start.from` means nothing in a shared checkout) and stopped and parked here,
  with `task_moved` here and `task_taken` there. **A hand-over in flight is a journal line**
  (`task_handing`, asked and then `ended` or `task_moved`), because it is asked just before a lid
  closes: the next window picks up what is open (`handOversOpen`) and counts its time from then, a
  sleep with the window open is not counted, and every let-go is written so none is taken up twice.
  The Mac finishes it, never the remote unasked — only this machine can tell the push was the last
  and stop the agent here. **No wait crosses machines**: work that waits on
  anything, or that anything waits on, stays, and the refusal says how to change that. The machine
  there fetches with **its own credentials** and a dry-run push says whether it could push back;
  the link never forwards an agent (`NO_AGENT`).
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
  where it cannot make them green it puts the manifests back and says so. And **a tree of its own,
  whatever the project says**: a bump is one set of manifests, one install and one lockfile, so the
  work says it cannot share a tree (`WatchAgent.alone`) and `watchFound` gives it a worktree and a
  branch even where every agent in that project works in the project's own checkout. That is what
  the watch used to *refuse* instead, and the refusal was the whole of why it did nothing at all in
  a project set up the ordinary way. `alone` may only ever **narrow** where work goes — there is
  no value on it that moves work into a tree the project did not already name. A project that can
  only be installed where it is checked out says `in_checkout`, and then the look **holds** rather
  than failing: `busyCheckout` finds nothing and says why while that tree has uncommitted work in it
  or an agent at work there, nothing can see which (no window is a hold, never permission), and it
  offers **one bump per look** so two agents never install in one tree. A config nobody could read
  counts as the checkout, because that is the machine's own default and guessing the safe-looking
  answer here would be guessing the one that lets a clock rewrite a shared tree.
- **A batch of full checks is a pass of the window's, never queued work** (`wire/batches.ts`, on the
  task beat, paced to `BATCH_LOOK_MS`, single-flight): it starts a run, never an agent, under the
  pure rule `batchDue` (core's `batches.ts`), and the next batch starts when HEAD has moved past the
  last. **A red one is a proposal like a watch's finding** — one parked task `by: extension:checks`,
  told now through `putToOrchestrator`, narrowed by rule to the commit that broke it and the task its
  trailer names, and steering that task's agent is offered first; never one agent per covered task.
  `change-the-checks` has the rest.
- **A replay is paced by the queue, never beside it** (`core/src/replay.ts`, `wire/replays.ts`): its
  entrants wait on the one `atOnce` places before them (`after`), `at` puts it off, and the queue's
  own pass first runs `replaysLook` — the ceiling, entrants whose agent stopped (finished so the
  chain moves, scored on what they left), and one grading run at a time through the checks' own
  door — then refreshes before `readyToStart`, so nothing a ceiling stopped is started in the same
  pass. Its record (`REPLAY_EVENTS`) is in `QUEUE_READS`, the whole journal, never a tail.
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

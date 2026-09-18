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
| `packages/core/src/queue.ts` | `Queued`, `queueStateOf`, `readyToStart`, `startFrom`, `checkPlan`, `QUEUE_CHANGES` |
| `packages/core/src/schedule.ts` | `When`, `ScheduleDoes`, `runsOf`, `dueNow`, `watchedFrom`, `newFindings`, the words for each |
| `packages/core/src/events.ts` | `task_done`, `queue_*`, `schedule_*`, `watch_*` |
| `packages/workbench/src/workbench.ts` | writing it down: `markDone`, `planTasks`, `startQueued`, `holdQueued`, `setSchedule`, `fireSchedule`, `watchChecked`, `watchFound` |
| `packages/workbench/src/schedules.ts` | `schedules.jsonl`: every change a line, with who made it |
| `packages/workbench/src/tasks.ts` | `by`, `done` and `start` in a task file; `beginFrom` for stacked worktrees |
| `packages/app/src/live.ts` | `QUEUE_READS`: what the rules read, from the whole journal |
| `packages/app/src/app.ts` | the passes: `advanceQueue`, `runSchedules`, `fire`, `lookWith`, and `queueTools` for the orchestrator |
| `packages/app/src/queue.ts` | what is said: the schedule card's facts, what the orchestrator is told |
| `packages/app/src/view.ts`, `plan-graph.ts` | the SMART QUEUE, the cards, the plan |
| `packages/orchestrator/src/tools-extension.ts`, `tool-host.ts` | `tade_done`, `tade_plan`, `tade_queue`, `tade_queue_change`, `tade_schedule` |
| `packages/extensions/core/src/port.ts`, `host.ts` | `ExtensionWatch`, and the host that looks with one |

## Rules

- **Rules are pure and live in core.** Whether work is ready, a schedule is due or a finding is new
  takes facts and `now` and returns an answer. Test the rule in core; the window only applies it.
- **Queued work is a task.** A task file with `start` — never a second store. It is made when it is
  planned, in the project's own workspace, and started by `startQueued`.
- **Write it down, then do it.** `schedule_fired` before a schedule's task is made, so a window that
  stops half way never runs it twice; `watch_found` for every finding, a failed start included, so
  one finding never makes work twice.
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
- **Only while a window is open.** What came due while none was is caught up once or skipped, as
  the schedule says (`dueNow`), never once per run missed.
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
(window), word it in `scheduleView`, take it in `tade_schedule` and `queue/schedule`, draw it on
the card (`renderSchedule`) and in `tade schedules`. Test it in `workbench/test/schedules.test.ts`
and through the window in `app.test.ts`.

**A watch.** It belongs to an extension: follow `add-extension`. Tade's side — turning it on,
looking, the journal, the queue, telling people — needs nothing new.

Then: a screen scenario for anything drawn (`test/screens/scenarios.ts`, `pnpm screens`, accept on
purpose), the invariant in `AGENTS.md` if a rule changed, and `pnpm check` on its own.

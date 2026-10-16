---
name: add-workbench-operation
description: Add something Tade can do to lanes, tasks, agents, notes or the journal. Use when the CLI, the window or the orchestrator needs a capability that does not exist yet.
---

# Adding a workbench operation

The workbench is an object, not a service. `Workbench` (`packages/workbench/src/workbench.ts`) is
what Tade holds while it is open — the lanes, the journal, the notes, the agents — and callers get
it by opening it, using it and closing it. There is no wire format to design and no client to keep
in step.

| File | Role |
|---|---|
| `packages/workbench/src/workbench.ts` | the operation itself |
| `packages/workbench/src/registry.ts` | lane state and its persistence |
| `packages/workbench/src/events.ts` | the journal |
| `packages/workbench/src/tasks.ts` | the task file: what a task is, what it is called, what it produces |
| `packages/workbench/src/memory.ts` | notes — the one thing Tade is told rather than derives |
| `packages/workbench/src/notes.ts` | retiring a note, and the cleanup that retires what needs no judgement |
| `packages/orchestrator/src/tool-host.ts` | only if an orchestrator tool needs to call it |
| `packages/workbench/src/ignore.ts` | only if the operation writes a new kind of file into a project |

## Steps

1. Add the method to `Workbench`. Keep it thin: guards, then one call into the registry, the log,
   the memory or `tasks.ts`. Business logic belongs in those, or in `core` if it is a decision.
2. Journal anything that changed the world, after it changed. The journal is how "what happened"
   gets answered later, and an operation missing from it is invisible forever.
3. Test it in `packages/workbench/test/` against a real workbench on a tmp home
   (`Workbench.open({ home })`), never a mock. Use `until()` from `@tade/drivers-core/conformance`
   rather than sleeping.
4. Expose it where people reach it: the CLI (see `add-cli-command`), the window
   (`change-the-window`), or the orchestrator (`add-orchestrator-tool`).

## Rules

- **Opening the workbench takes the home.** One window per `TADE_HOME`: a second `open` is refused
  with `HomeBusyError`. So an operation that only *reads* — the journal, the notes, git — must not
  need it. Use `readJournal(home)` or `Memory.open(home)` and leave the lock alone; a question you
  cannot ask while a window is open is a question people will stop asking.
- **A new file Tade writes about a project goes in Tade's home, never in the project.** `projectDir`,
  `taskDir` and `recordsDir` (`core/src/home.ts`) are the only roots: the project's folder for
  anything about the checkout everybody shares, the task's for anything about one task's own
  directory. There is no ignore rule any more and nothing may bring one back — a file under a
  project's `.tade/` needed one, and the one Tade used to append is taken back out
  (`removeOwnIgnore`, `ignore_removed`), which is the only thing Tade still changes in somebody
  else's repository. The exception that proves the rule is a file that is genuinely the *project's*:
  a person edits it, it means the same on another machine, and something holds it honest. There has
  never been one — `checks.yaml` was the closest, and it is gone because what a project checks is
  read out of its own CI and its own commit hook rather than written down twice.
- **Never report a lane as alive without evidence from the driver.** A live pid says something is
  running, not that we can drive it. `reconcile` asks the driver and takes its answer.
- **`close()` lets go; `stopEverything()` ends the work.** Closing Tade must never stop agents that
  the driver says can outlive it.
- **A name a person gave something is kept; anything else is a guess.** `setTitle(worktree, title,
  named)` (`tasks.ts`) writes `title_named: true` in the task file when a person chose the name, and
  that name is what the agent's session is given. A title taken from the first thing somebody asked
  only fills a blank, and is replaced the moment a better one comes — so never write one over a
  `title_named` task, and never pass `named` for a guess.
- **A note is kept verbatim, and a headline is written beside it rather than out of it.**
  `Memory.remember(text, scope, by, now, summary)` appends `text` exactly as it arrived; `summary` is
  optional, a few words on what the note is about and what it does, written by whoever takes the note
  down — the orchestrator as it calls `tade_remember`, a person on the note's own page. It is never
  derived from the text: a summary drawn at drawing time is a guess at what somebody meant, made four
  times a second, and the whole reason notes are verbatim is that nothing can recover that. Every
  note taken before `summary` existed has none, so it stays optional and those are drawn in their own
  words.
- **The same words are one note, however often they arrive.** `Memory.remember` reads the file
  first (the CLI writes it from another process), and where a live note already has those exact
  words it writes nothing and hands that note back marked `already: 'noted'` — or, about something
  it does not reach yet, appends one `also` line rather than a second copy (`'widened'`). Every
  caller says which: the tool's answer, the window's flash, voice, the CLI. The causes this closed,
  measured on a real `memory.jsonl` of 36 notes: one sentence about three tasks written once per
  task, in parallel tool calls of one turn (4 sentences, 9 lines), and a note left about everything
  by mistake and written again about its task eight seconds later — which went on being told to
  every agent in every project. A note about several things is one note: `scope`, then `also`.
  So anything that writes a note's words *again* — the window's headline edit — forgets the old
  line **first**, or it finds the old note and writes nothing.
- **A note is retired, never deleted, and never reworded.** `Memory.retire` appends a `retire`
  line with the sentence, and `retireNote` (`notes.ts`) writes `note_retired` after it — the note's
  moment, scopes and headline, never its words, for `context_added`'s reason. A retired note is in
  nothing anybody is told — `recall`, `all()`, the briefing, an agent's prompt — and read on
  asking: `all({ retired: true })`, `tade notes --all`, `tade_notes` with all, the window's RETIRED
  NOTES. `forget` is still the person taking a note back altogether.
- **The cleanup retires only what needs no judgement** (`notesToRetire`, core, pure; run on every
  open by `settleNotes`, like `settleDocuments`): the same words again about the same, and a note
  every scope of which is a task finished or gone for longer than `notes.keep_days`. Never a note
  about a project or everything, never one whose task is still there and not finished, and a task
  file it cannot look at is a task. Superseded, contradicted, no longer true are judgements: the
  orchestrator proposes them and retires one only on a line the person said lately (`theirLine`,
  the check a document approval uses), so it is never silent and never on something it read.
- **`reflected` is the only record that a finished task was looked back over**, which is why
  `needsReflection` (`core/src/reflect.ts`) reads it out of the journal instead of remembering it, and
  why it may not be dropped: without it Tade looks again and spends a turn per finished task every
  morning. It is `trace` urgency and is *not* in `SAMPLED_TYPES` — see `add-event-type`.
- Every mutation of lane state is persisted by the registry and appended to the journal, in that
  order.
- Don't log raw lane output as events. Output stays in the driver's scrollback and is sampled as
  byte counts, so a chatty agent can't bloat the journal.

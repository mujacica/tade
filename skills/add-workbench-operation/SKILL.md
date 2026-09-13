---
name: add-workbench-operation
description: Add something Wilco can do to lanes, tasks, agents, notes or the journal. Use when the CLI, the window or the orchestrator needs a capability that does not exist yet.
---

# Adding a workbench operation

The workbench is an object, not a service. `Workbench` (`packages/workbench/src/workbench.ts`) is
what Wilco holds while it is open — the lanes, the journal, the notes, the agents — and callers get
it by opening it, using it and closing it. There is no wire format to design and no client to keep
in step.

| File | Role |
|---|---|
| `packages/workbench/src/workbench.ts` | the operation itself |
| `packages/workbench/src/registry.ts` | lane state and its persistence |
| `packages/workbench/src/events.ts` | the journal |
| `packages/orchestrator/src/tool-host.ts` | only if an orchestrator tool needs to call it |

## Steps

1. Add the method to `Workbench`. Keep it thin: guards, then one call into the registry, the log,
   the memory or `tasks.ts`. Business logic belongs in those, or in `core` if it is a decision.
2. Journal anything that changed the world, after it changed. The journal is how "what happened"
   gets answered later, and an operation missing from it is invisible forever.
3. Test it in `packages/workbench/test/` against a real workbench on a tmp home
   (`Workbench.open({ home })`), never a mock. Use `until()` from `@wilco/drivers-core/conformance`
   rather than sleeping.
4. Expose it where people reach it: the CLI (see `add-cli-command`), the window
   (`change-the-window`), or the orchestrator (`add-orchestrator-tool`).
5. Update `README.md` in the same change.

## Rules

- **Opening the workbench takes the home.** One window per `WILCO_HOME`: a second `open` is refused
  with `HomeBusyError`. So an operation that only *reads* — the journal, the notes, git — must not
  need it. Use `readJournal(home)` or `Memory.open(home)` and leave the lock alone; a question you
  cannot ask while a window is open is a question people will stop asking.
- **Never report a lane as alive without evidence from the driver.** A live pid says something is
  running, not that we can drive it. `reconcile` asks the driver and takes its answer.
- **`close()` lets go; `stopEverything()` ends the work.** Closing Wilco must never stop agents that
  the driver says can outlive it.
- Every mutation of lane state is persisted by the registry and appended to the journal, in that
  order.
- Don't log raw lane output as events. Output stays in the driver's scrollback and is sampled as
  byte counts, so a chatty agent can't bloat the journal.

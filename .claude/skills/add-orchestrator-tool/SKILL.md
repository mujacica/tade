---
name: add-orchestrator-tool
description: Add or change a tool the orchestrator can call (status, task create, run start, steer, approve, deny...). Use when the thing you talk to should be able to do something new.
---

# Adding an orchestrator tool

Tools live in `packages/orchestrator/src/tools-extension.ts`, which pi loads into the orchestrator
session with `-e`. Each tool is a name, a description the model reads, a JSON Schema, and a function.

## Rules

- **Self-contained file.** pi loads it directly under its own module resolution, so it imports
  nothing from the Wilco workspace — that is why the daemon's JSON-RPC framing is hand-rolled at the
  bottom of the file rather than imported. Keep it that way.
- **Actions go to the daemon; questions about state go through `wilco status`.** There is one
  implementation of how state is derived, and the orchestrator should see exactly what a human sees.
- **The description is the interface.** The model chooses tools by reading it, so say when to use
  the tool, not just what it does. `wilco_task_create` tells it to pass the human's words verbatim,
  because that field can never be reconstructed later.
- **Return text or JSON; never throw.** Errors come back as `{ output, isError: true }` so the model
  can choose another route. A tool that throws kills the turn.
- **Approval tools are not shortcuts.** `wilco_approve` exists so a human's spoken "yes" can be
  carried out; its description must keep it to that, never to the model approving its own work.
- The orchestrator runs **unsupervised** (`supervise: false`): its own tool calls are not gated, so
  a tool that does something irreversible needs to be as careful as the gate would have been.

## Steps

1. Add the tool with `tool(name, description, schema, run)` in the extension.
2. If it needs a new daemon capability, add that first (see the `add-daemon-method` skill).
3. Test it in `packages/orchestrator/test/tools.test.ts` against a real pi and a real daemon: the
   fake model in `test/fixtures/fake-model.ts` issues the tool call, and the assertion is that the
   effect really happened (an event in the log, a worktree on disk), not merely that pi accepted it.
4. `pnpm check`, then update the README if the orchestrator gained a user-visible ability.

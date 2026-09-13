---
name: add-orchestrator-tool
description: Add or change a tool the orchestrator can call (status, task create, run start, steer, approve, deny...). Use when the thing you talk to should be able to do something new.
---

# Adding an orchestrator tool

Tools live in `packages/orchestrator/src/tools-extension.ts`, which pi loads into the orchestrator
session with `-e`. Each tool is a name, a description the model reads, a JSON Schema, and a function.

## Rules

- **Self-contained file.** pi loads it directly under its own module resolution, so it imports
  nothing from the Wilco workspace — that is why the JSON-RPC framing is hand-rolled at the bottom
  of the file rather than imported. Keep it that way.
- **Actions go back through the `ToolHost`; questions about state go through `wilco status`.** The
  orchestrator is pi in its own process, so a tool that *does* something calls back over the host
  socket (`packages/orchestrator/src/tool-host.ts`) to the window holding the workbench. That socket
  is a channel between a parent and its own children, not a service: nothing discovers it, nothing
  outside the process tree may use it, and it dies with the window. If something that is not our own
  child would ever want to call it, it has stopped being a channel and become a daemon again.
  Questions go through `wilco status` so there is one implementation of how state is derived and the
  orchestrator sees exactly what a human sees.
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
2. If it needs a capability Wilco does not have, add that first (see `add-workbench-operation`),
   then expose it as a method on the `ToolHost`.
3. Test it in `packages/orchestrator/test/tools.test.ts` against a real pi and a real workbench: the
   fake model in `test/fixtures/fake-model.ts` issues the tool call, and the assertion is that the
   effect really happened (an event in the log, a worktree on disk), not merely that pi accepted it.
4. `pnpm check`, then update the README if the orchestrator gained a user-visible ability.

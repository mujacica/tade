---
name: add-orchestrator-tool
description: Add or change a tool the orchestrator can call (status, task create, run start, steer, approve, deny...). Use when the thing you talk to should be able to do something new.
---

# Adding an orchestrator tool

Wilco's own tools live in `packages/orchestrator/src/tools-extension.ts`, which pi loads into the
orchestrator session with `-e`. Each tool is a name, a description the model reads, a JSON Schema,
and a function.

**A tool about something outside Wilco** — a service, a project's files, a registry — is not one of
these: it is an extension (see `add-extension`), which agents can use too and the window can run.

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
  because that field can never be reconstructed later, and to pass the `context` and `links` it
  gathered, which become `.wilco/context.md` in the agent's worktree.
- **Answer with `content`; fail by throwing.** pi reads a tool's `{ content: [{ type: 'text', text }] }`
  and nothing else, and marks a call failed only when it throws — the thrown message is what the
  model reads, so make it say what to do instead. The `tool()` helper does both: return a string or
  JSON from `run`, throw an `Error` with a reason. (Returning `{ output }` once gave the model an
  empty answer from every tool, and no test noticed, because only the effect was checked.)
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
   effect really happened (an event in the log, a worktree on disk), not merely that pi accepted it —
   and that the model was told the answer (`model.requests[1]` holds the tool message).
4. If the prompt should mention it, change `ROLE` or `RULES` in `packages/core/src/compose.ts`, and
   accept the golden with `WILCO_UPDATE_GOLDEN=1 pnpm vitest run packages/orchestrator/test/golden.test.ts`.
5. `pnpm check`.

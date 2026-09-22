---
name: add-orchestrator-tool
description: Add or change a tool the orchestrator can call (status, task create, run start, steer, approve, deny...). Use when the thing you talk to should be able to do something new.
---

# Adding an orchestrator tool

Tade's own tools live in `packages/orchestrator/src/tools-extension.ts`, which pi loads into the
orchestrator session with `-e`. Each tool is a name, a description the model reads, a JSON Schema,
and a function.

**A tool about something outside Tade** — a service, a project's files, a registry — is not one of
these: it is an extension (see `add-extension`), which agents can use too and the window can run.

## Rules

- **Self-contained file.** pi loads it directly under its own module resolution, so it imports
  nothing from the Tade workspace — that is why the JSON-RPC framing is hand-rolled at the bottom
  of the file rather than imported. Keep it that way.
- **Actions go back through the `ToolHost`; questions about state go through `tade status`.** The
  orchestrator is pi in its own process, so a tool that *does* something calls back over the host
  socket (`packages/orchestrator/src/tool-host.ts`) to the window holding the workbench. That socket
  is a channel between a parent and its own children, not a service: nothing discovers it, nothing
  outside the process tree may use it, and it dies with the window. If something that is not our own
  child would ever want to call it, it has stopped being a channel and become a daemon again.
  Questions go through `tade status` so there is one implementation of how state is derived and the
  orchestrator sees exactly what a human sees.
- **The description is the interface.** The model chooses tools by reading it, so say when to use
  the tool, not just what it does. `tade_task_create` tells it to pass the human's words verbatim,
  because that field can never be reconstructed later, and to pass the `context` and `links` it
  gathered, which are written beside the task (`.tade/context.md` in a worktree,
  `.tade/tasks/<name>/context.md` in a shared checkout) for the agent to read first. Everything
  under `.tade/` is ignored by the project, so what you write there is the agent's to read and
  nobody's to commit — if it has to outlive the task, it goes where the thing it describes is.
- **Answer with `content`; fail by throwing.** pi reads a tool's `{ content: [{ type: 'text', text }] }`
  and nothing else, and marks a call failed only when it throws — the thrown message is what the
  model reads, so make it say what to do instead. The `tool()` helper does both: return a string or
  JSON from `run`, throw an `Error` with a reason. (Returning `{ output }` once gave the model an
  empty answer from every tool, and no test noticed, because only the effect was checked.)
- **Approval tools are not shortcuts.** `tade_approve` exists so a human's spoken "yes" can be
  carried out; its description must keep it to that, never to the model approving its own work.
- The orchestrator runs **unsupervised** (`supervise: false`): its own tool calls are not gated, so
  a tool that does something irreversible needs to be as careful as the gate would have been.
- **A tool that changes Tade itself is held to a boundary, and the boundary is not in the tool.**
  The orchestrator reads attacker-controlled text all day, so anything that could widen what an
  agent may do, hand a third party tools or a credential, change who is asked, or change where
  Tade sends something is `never` its to write — see `settingReach` in `packages/core/src/reach.ts`
  and the invariant in AGENTS.md. Most of the rest needs the person's own words, checked against
  the journal's `said` lines rather than against an argument the tool was passed. Both checks live
  in the window (`wire/settings.ts`, `wire/projects.ts`): a rule that runs inside the model's own
  process is a rule the model can be talked out of. Say the limit in the tool's description too,
  in the words of the refusal — a limit a model only learns by being refused costs a turn every
  time — and write the change down (`config_changed`) with what it was before, so somebody who was
  not watching can find it and undo it.

## Steps

1. Add the tool with `tool(name, description, schema, run)` in the extension.
2. If it needs a capability Tade does not have, add that first (see `add-workbench-operation`),
   then expose it as a method on the `ToolHost`.
3. Test it in `packages/orchestrator/test/tools.test.ts` against a real pi and a real workbench: the
   fake model in `test/fixtures/fake-model.ts` issues the tool call, and the assertion is that the
   effect really happened (an event in the log, a worktree on disk), not merely that pi accepted it —
   and that the model was told the answer (`model.requests[1]` holds the tool message).
4. If the prompt should mention it, change `ROLE` or `RULES` in `packages/core/src/compose.ts`, and
   accept the golden with `TADE_UPDATE_GOLDEN=1 pnpm vitest run packages/orchestrator/test/golden.test.ts`.
5. `pnpm check`.

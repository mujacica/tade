---
name: add-orchestrator-tool
description: Add or change a tool the orchestrator can call (status, task create, run start, steer, approve, deny...). Use when the thing you talk to should be able to do something new.
---

# Adding an orchestrator tool

Tade's own tools live in `packages/orchestrator/src/tools-extension.ts`, which pi loads into the
orchestrator session with `-e`. Each tool is a name, a description the model reads, a JSON Schema,
and a function.

**A tool answers about now; the briefing is a snapshot.** `composeBriefing` hands the orchestrator
what the world looked like when the window opened, with times on it, and says so — so anything that
has to be true *at the moment of asking* belongs in a tool and not in the briefing. `tade_status` is
the one that answers it, which is why the briefing may never say which project somebody is looking
at, or a branch or worktree path: both go stale within the minute, and a remembered location is the
same class of bug as a remembered branch.

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
  gathered, which are written beside the task (`context.md` in `taskDir(home, task)`) for the agent
  to read first. None of that is in the project, so what you write there is the agent's to read and
  nobody's to commit — if it has to outlive the task, it goes where the thing it describes is.
- **A tool somebody asks for by name needs a rule in the prompt, and not only a description.**
  `tade_project_open` had a full description for a year and the orchestrator still reached for a
  terminal when somebody said "open the X project" — twice in one week — because nothing in `RULES`
  said that opening a project was one of its own acts, so the model answered out of what it knows
  about shells. A rule earns its place by saying which words mean that tool and what it is reached
  for *instead of*, and by saying what the reach actually is: a model left to guess at that comes
  out with "I am not allowed to" about something it may do. `RULES` in
  `packages/core/src/compose.ts`, and the golden is the diff somebody reviews.
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
  and the one-line invariant in AGENTS.md, whose argument lives in `add-config-key`. Most of the rest needs the person's own words, checked against
  the journal's `said` lines rather than against an argument the tool was passed. Both checks live
  in the window (`wire/settings.ts`, `wire/projects.ts`, `wire/schedules.ts`): a rule that runs
  inside the model's own process is a rule the model can be talked out of. A thing that is not a
  config key is decided there anyway — a watch is `WATCH_REACH`, beside `settingReach` — because
  the question is the same question, and the check goes at the one door every way of doing that act
  goes through, not only at the new tool's: a gate with an unguarded door beside it reads like a
  promise Tade does not keep. Say the limit in the tool's description too,
  in the words of the refusal — a limit a model only learns by being refused costs a turn every
  time — and write the change down (`config_changed`) with what it was before, so somebody who was
  not watching can find it and undo it.

- **A tool that acts on one thing changes that thing alone, and never a default on the side.**
  `tade_agent_model` and `tade_agent_thinking` switch one running agent and write nothing under
  `workers.routes`. They used to keep the choice on the project's route for new agents, which was a
  config write nobody had asked `tade_setting_change` for; the person decided a switch is one agent.
  So each answer says that new agents keep the project's default and that the default is a setting,
  and `RULES` says which tool changes a default — `tade_setting_change` on that row, on their words.
  Without that, a model asked for a new default switches an agent and calls it done. Defaults are
  settings the orchestrator may change when asked (each route's model and thinking, and each
  harness's under it); which provider a route sends work to is not a default and stays `never`
  (`add-config-key`). A new tool that seems to need a default changed beside its act is two acts:
  do the one asked for, and name the row for the other.

- **A tool that takes the person's own words out of what is told takes a line of theirs.**
  `tade_notes_retire` is refused in the window unless `said` is something the journal has them
  saying lately (`theirLine`, `host-notes.ts`) — the check `tade_document_triage` makes of an
  approval. So the description tells the model to propose first and retire once they agree, and
  leaves what needs no judgement (a note about gone work, the same words twice) to the cleanup
  that runs on open, so no turn is spent on it. A tool that writes something the person said
  answers when nothing was written: `tade_remember` with the same words says "already noted",
  because a model shown a fresh note goes on to write the next one.

- **Everything put to the orchestrator to decide is decided with one tool.** A schedule's run, a
  watch's finding, a check it proposed and what an agent found and did not fix (`leftovers.ts`) are
  all `tade_proposal_decide` — start, after, steer or leave, with a sentence why — never a tool per
  source. A new kind of proposal teaches `proposalsIn` to read it and says itself in that tool's
  description and in `RULES`; it adds nothing to the tool list or to `origin.ts`'s tables, and the
  golden diff is two sentences.

- **A tool that spends money for the person takes their words and their ceiling.** `tade_replay`
  is refused in the window unless a `said` line asks for an eval (`REPLAY_START`, `replayNamedBy`),
  and the host refuses it with no `ceiling_usd` before the window is even asked — a ceiling the
  model made up is a ceiling nobody set, so the description tells it to ask for one.

## A tool is reachable from away only if somebody decided it is

`packages/orchestrator/src/origin.ts` holds **two closed tables**: which of Tade's own tools a turn
from a paired device may call, and what each `ToolHost` method may do with the parameters it
carries. Both are **exhaustive and asserted against the real lists** (`test/origin.test.ts`), and
both **default to no** — so a tool or a method added without a line fails that test, and at runtime
an unnamed one is refused.

- **A new tool needs a line in `REMOTE_TOOLS`, and the honest default is `local`.** The four clauses
  the `local` half is written with — it executes, it grants, it publishes, it reads wider — are
  grouped rather than written per entry, because the argument really is the same for each.
- **A new `ToolHost` method needs a line in `REMOTE_METHODS`**, with how its project is found. A
  method that reads a task id resolves to the **empty string** where there is no project half, never
  `null`: `null` means *deliberately about no project* (a note about everything), and those two being
  one value is a hole a bare name walks through.
- **A tool that shells out to the CLI reaches no method at all** (`tade_notes`, and `tade_updates`
  where no window answers `updates/read`), so the tool table is the only gate for it — which is
  why reads whose answer is wider than a read grant are `local` even though they change nothing.
- **A tool whose effect is on another machine is `local` with a clause of its own** (`OWNS_ELSEWHERE`,
  `tade_remote_tell`): what it carries is this machine's owner session there, which reaches what that
  machine's keyboard does, and the arm of the turn that called it is not carried with it — so a
  phone's words passed on would arrive with the keyboard's reach. The window holds it to a line of the
  person's naming that machine (`REMOTE_TELL_REACH`, `remoteNamedBy`), and says it there as this
  machine's orchestrator's words, never the person's. `origin.test.ts` holds both refusals.
  `tade_task_move` is the same shape for work rather than words (`REMOTE_MOVE_REACH`): it goes
  through the window's one door for moving work (`wire/moves.ts`), the door the queued card's
  "Start on <machine>" presses too, so the gate is in front of the act and not of the tool.
- **A tool that reads can name another machine; a tool that acts never does.** `tade_status`,
  `tade_documents`, `tade_intake`, `tade_intake_show` and every extension tool that declares `reads`
  (`tools-listed.ts` adds the parameter) take `machine` (`ON_MACHINE`, `tools-remotes.ts`) and then
  call a `remote/*` method in `host-remotes.ts` — `local` with `READS_ELSEWHERE`, since reading
  through an owner session is wider than any phone's grant there. The window answers out of what it
  holds of that machine (`wire/remote-reads.ts`): as of when it last said, a request's own words
  left out as they are here, a document handed over as a path to a copy. Anything that would change
  something there is `tade_remote_tell`'s, through that machine's own orchestrator.
- Only where a turn runs under a remote arm does any of this apply. A local turn is checked against
  nothing, which is the type saying it rather than a comment promising it (`Arm`) — and so is an
  **owner device's** turn (`{ how: 'owner' }`, minted only by `tade web pair --owner` over SSH and
  usable only on this machine), whose reach is the keyboard's while `whoOf` still names the device.
  So a gate asks `narrowedArm(arm)`, never `arm.how === 'local'`: the second answers an owner as a
  phone, which is the narrowing the owner channel exists to lift.

## Steps

1. Add the tool with `tool(name, description, schema, run)` in the extension.
2. If it needs a capability Tade does not have, add that first (see `add-workbench-operation`),
   then expose it as a method on the `ToolHost`.
2b. Give it a line in **both** tables in `origin.ts` — `REMOTE_TOOLS` for the tool, `REMOTE_METHODS`
   for the method — or `test/origin.test.ts` fails. `local` with one of the four clauses is the
   answer for almost everything.
3. Test it in `packages/orchestrator/test/tools.test.ts` against a real pi and a real workbench: the
   fake model in `test/fixtures/fake-model.ts` issues the tool call, and the assertion is that the
   effect really happened (an event in the log, a worktree on disk), not merely that pi accepted it —
   and that the model was told the answer (`model.requests[1]` holds the tool message).
4. If the prompt should mention it — and anything a person asks for by name should, per the rule
   above — change `ROLE` or `RULES` in `packages/core/src/compose.ts`, and accept the golden with
   `TADE_UPDATE_GOLDEN=1 pnpm vitest run packages/orchestrator/test/golden.test.ts`.
5. `pnpm check`.

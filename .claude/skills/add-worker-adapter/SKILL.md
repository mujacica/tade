---
name: add-worker-adapter
description: Add or change a worker adapter — the thing that runs a coding agent and reports what it is doing (pi today; another harness later). Use when supporting a new agent harness, or changing the signals and approval gate.
---

# Adding a worker adapter

The port is `packages/harnesses/core/src/port.ts`. The reference implementation is
`packages/harnesses/pi`. An adapter's job is to run an agent and answer two questions honestly:
**what is it doing, and may it do this?**

## Three ways in, and which to implement

| Method | What it is for |
|---|---|
| `launchSpec(spec)` | what to run, so Tade can put the agent in a lane. Placing the process is the driver's job, not the adapter's. |
| `supervise(spec)` | open the channel that launch reports back over. Called *before* the lane starts, so the first signal has somewhere to land. |
| `start(spec)` | run the agent headless under our own protocol, as our child. Only for an agent whose interface Tade draws itself — the orchestrator. Declare `capabilities.headless` when you implement it, and take Tade's own tools as modules (`nativeExtensions`) or an MCP server (`mcp`), because that is how the orchestrator is given them. |

Workers use the first two: an agent is pi in a terminal, visible, surviving the window under a
driver that can. If you only implement `start`, you have built something that dies when Tade
closes, which is the thing this design exists to avoid.

## The contract

- Emit `WorkerSignal`s: `started`, `turn_started`, `titled`, `message`, `message_delta`, `tool_call`,
  `tool_result`, `extension_call`, `permission_request`, `turn_done`, `failed`, `problem`, `idle`,
  `context`, `usage`, `exited`. These are zod schemas because they cross a socket. A process that
  exits before it answers anything says why with `failed`, from what it wrote to stderr — never leave
  a caller to time out. A turn the provider refused is `turn_done` with `status: 'error'` and the
  provider's `reason`; anything else that goes wrong while the agent carries on (a retry, a harness
  extension that threw) is `problem`. Both end up in front of the person — the orchestrator's
  refusals once ended in silence, because nothing carried the reason.
- **A request a provider in between refuses is rewritten in the harness**, not worked around in the
  config: pi's are in `harnesses/pi/src/compat.ts`, loaded into every pi Tade starts, each with a
  test of the payload before and after.
- Accept `WorkerCommand`s back: `decision`, `steer`, `queue`, `abort`, `shutdown`, `name`, `model`,
  `extension_result`. `name` and `model` change only this agent's session: never the harness's default
  for new sessions, which is how one agent's model once leaked into every other.
- Honour `WorkerSpec.extras`: instructions appended to the agent's own, the list of extension tools
  it may call (register them, and send `extension_call` when one is used, waiting for
  `extension_result`), and the skills and native extensions extensions ship for this harness.
- Declare `capabilities` truthfully, as *how* rather than whether: each thing a person can ask of a
  running agent is `live`, `idle` (Tade holds it until the turn ends), `restart` (Tade starts the
  agent again on the same conversation) or `none`. Everything short of full carries a sentence in
  `why`, in the harness's own words; the conformance suite fails without one. The window, the
  orchestrator's tools and voice all read them through `offer()` — `none` is not drawn and is
  refused with that sentence, `restart` is done by `restartAgent`. `permissionGate: false` means
  approvals cannot be trusted for that harness — never fake it.
- Say what each tool does (`effectOf`): `read`, `write`, `exec` or `other`. The policy judges by
  that and never learns a harness's tool names; `exec` is judged by its command.
- Own the harness's own record: `conversationKey` (two tasks with the same key share a
  conversation), `hasConversation` (whether coming back needs an opening instruction), `spent`
  (the ledger read on opening). Nothing outside the adapter reads a harness's files.
- Say where a contained agent must write (`sandboxWrites`): the folder it keeps conversations in,
  and a prefix for a file it replaces through a temporary sibling. Leave one out and a sandboxed
  agent runs, answers, and quietly keeps nothing — no session to come back to, no spend.

- Own its accounts, if it can have more than one (`capabilities.accounts`): an adapter is made
  per account (`HarnessOptions.account`: a folder, and for an API key a *command* that prints it),
  says who it is signed in as (`account`), hands back its own sign-in to run where a person can see
  it (`signIn`, with a sentence saying what they will be asked), makes a new account's folder ready
  (`prepareAccount`), and carries a task's conversation to another account (`carryConversation`).

## What Claude Code taught (`packages/harnesses/claude`)

When the harness has nothing of ours inside it, everything comes through what it offers — hooks,
its status line, an MCP server — handed to it for one run (`--settings`, `--mcp-config`), and
everything said to it is typed into its lane. Each of these was found the hard way:

- **One line must both start and continue a session.** Claude Code refuses `--session-id` for an id
  it has and `--resume` for one it has not, so the launch line is a small `sh -c` that looks for the
  transcript first. The id is a UUID made from the task's name.
- **A flag that takes several values swallows the opening prompt** (`--mcp-config`, `--add-dir`):
  put them first on the line, never last.
- **Unset what a parent session tells its children.** Started from inside a Claude Code
  (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, …) it takes itself for a child and keeps
  no transcript. An inherited `ANTHROPIC_API_KEY` stops it at a dialog in its lane.
- **Anything that stops it before its first hook looks like an agent thinking**: the folder-trust
  dialog, the bypass-mode warning, first-run onboarding. Answer them before launch (`trust.ts`,
  `skipDangerousModePermissionPrompt`), never by typing into the dialog.
- **Never type a command that changes a default.** `/model` saves itself as every new session's
  model; change a model by restarting on the same conversation (`model: 'restart'`).
- **Type one thing at a time**, pasted (bracketed) so several lines arrive as one, Enter after it,
  all through one queue per lane.
- **No hook runs when a turn is cut short**, and the Stop hook runs *before* the last of the reply is
  in the transcript: say the abort yourself, and count tokens after the status line is drawn.
- **A contained agent that cannot write its own folder runs and keeps nothing**: declare
  `sandboxWrites`, prefixes included.
- **Subscriptions are the user's own, through the harness's own sign-in.** Tade runs the unmodified
  binary, never reads or stores a subscription token, and an API key it keeps is read by the harness
  through a command, so it is never written into a launch line.

## Being the thing you talk to

A harness can run the orchestrator when three things are true, and it says so rather than being
asked by name:

- **`capabilities.headless`** — it can be a child of Tade's process, speaking a protocol rather
  than drawing a terminal (pi's `--mode rpc`, Claude Code's `-p --input-format stream-json`).
  `start(spec)` maps that protocol to the same signals a lane agent sends, deltas included: the
  window draws the conversation itself. Spawn it through `reaped()` — it has no lane to carry on
  in, so it must not outlive Tade even when Tade is killed outright.
- **`capabilities.mcp` or `capabilities.nativeExtensions`** — some way to be handed Tade's own
  tools. They are declared once in `orchestratorTools` and served to pi as registered tools and to
  an MCP-speaking harness by `tools-mcp.ts`; an adapter never declares a tool of its own.
- **`modelOf(run)`** — what it is actually thinking with, which the window shows. A harness whose
  `model` is `restart` is started again on the same conversation when somebody changes it, which
  `Orchestrator.capabilities` is what tells the window to do.

Everything else the orchestrator needs is already neutral: `extras.instructions` for what Tade is
and what it missed, `spec.env` for what its tools need to find their way back, and the run's task
name for the one conversation it keeps.

## Rules

- **Never infer state from rendered output.** A signal comes from a structured channel (an
  in-agent extension, a hook, a protocol message) or it doesn't exist. If a harness can't tell you
  a turn ended, report `unknown` rather than guessing.
- **What to do when Tade is unreachable depends on the mode, and the agent is told which**
  (`TADE_APPROVALS`). Under `policy` the gate fails closed: block, because an agent running
  unsupervised is worse than one that stalls. Under `bypass` — the default — nothing was ever going
  to be held, and under a driver whose lanes outlive the window losing Tade is ordinary rather than
  a fault, so the agent carries on and the journal catches up later. Deciding this at the moment of
  disconnection instead of at launch is how a gate turns itself off without anyone noticing.
- **Whatever the harness records for itself is the ledger.** Tade reads pi's own session files to
  account for turns that happened while nothing was listening, so an adapter should prefer the
  harness's durable record over anything it reports live.
- **Be inert when unsupervised.** If the supervision environment variables are absent, the agent
  must behave exactly as if Tade were not installed.
- **`permission_request.summary` must be exact.** It is read back to a human before they approve a
  destructive command, so it carries the real command, not a paraphrase.
- **Keep in-agent code self-contained.** Code loaded *into* the agent (a pi extension, a hook
  script) runs under that tool's module resolution, not ours: no workspace imports. The Tade side
  validates what arrives.
- **The adapter never owns credentials.** Model, provider and auth belong to the harness, which is
  what keeps subscriptions, API keys and local models all working.

## Steps

1. Implement `WorkerAdapter` in `packages/harnesses/<name>/src/adapter.ts`, and pass
   `testHarness` from `@tade/harnesses-core/conformance` in its tests before anything else.
2. Write the in-agent half if the harness has one, plus the channel that carries its signals.
3. Test without a model first: prove the agent loads your code, connects, and answers control
   commands. That catches loading, resolution and framing bugs on their own.
4. Then test the gate with a fake OpenAI-compatible provider so a real agent makes a real tool
   call, deterministically and offline.
5. Register the adapter where workers are chosen (`Workbench.adapterFor`), and add it to the
   `harness` enum in `packages/core/src/config.ts`.
6. `pnpm check`.

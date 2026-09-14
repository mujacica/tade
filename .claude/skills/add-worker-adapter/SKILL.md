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
| `launchSpec(spec)` | what to run, so Wilco can put the agent in a lane. Placing the process is the driver's job, not the adapter's. |
| `supervise(spec)` | open the channel that launch reports back over. Called *before* the lane starts, so the first signal has somewhere to land. |
| `start(spec)` | run the agent headless under our own protocol, as our child. Only for an agent whose interface Wilco draws itself — the orchestrator. |

Workers use the first two: an agent is pi in a terminal, visible, surviving the window under a
driver that can. If you only implement `start`, you have built something that dies when Wilco
closes, which is the thing this design exists to avoid.

## The contract

- Emit `WorkerSignal`s: `started`, `turn_started`, `titled`, `message`, `message_delta`, `tool_call`,
  `tool_result`, `extension_call`, `permission_request`, `turn_done`, `failed`, `idle`, `context`,
  `usage`, `exited`. These are zod schemas because they cross a socket. A process that exits before
  it answers anything says why with `failed`, from what it wrote to stderr — never leave a caller to
  time out.
- Accept `WorkerCommand`s back: `decision`, `steer`, `queue`, `abort`, `shutdown`, `name`, `model`,
  `extension_result`. `name` and `model` change only this agent's session: never the harness's default
  for new sessions, which is how one agent's model once leaked into every other.
- Honour `WorkerSpec.extras`: instructions appended to the agent's own, the list of extension tools
  it may call (register them, and send `extension_call` when one is used, waiting for
  `extension_result`), and the skills and native extensions extensions ship for this harness.
- Declare `capabilities` truthfully. `permissionGate: false` means approvals cannot be trusted for
  that harness, and the policy engine must treat it accordingly — never fake it.

## Rules

- **Never infer state from rendered output.** A signal comes from a structured channel (an
  in-agent extension, a hook, a protocol message) or it doesn't exist. If a harness can't tell you
  a turn ended, report `unknown` rather than guessing.
- **What to do when Wilco is unreachable depends on the mode, and the agent is told which**
  (`WILCO_APPROVALS`). Under `policy` the gate fails closed: block, because an agent running
  unsupervised is worse than one that stalls. Under `bypass` — the default — nothing was ever going
  to be held, and under a driver whose lanes outlive the window losing Wilco is ordinary rather than
  a fault, so the agent carries on and the journal catches up later. Deciding this at the moment of
  disconnection instead of at launch is how a gate turns itself off without anyone noticing.
- **Whatever the harness records for itself is the ledger.** Wilco reads pi's own session files to
  account for turns that happened while nothing was listening, so an adapter should prefer the
  harness's durable record over anything it reports live.
- **Be inert when unsupervised.** If the supervision environment variables are absent, the agent
  must behave exactly as if Wilco were not installed.
- **`permission_request.summary` must be exact.** It is read back to a human before they approve a
  destructive command, so it carries the real command, not a paraphrase.
- **Keep in-agent code self-contained.** Code loaded *into* the agent (a pi extension, a hook
  script) runs under that tool's module resolution, not ours: no workspace imports. The Wilco side
  validates what arrives.
- **The adapter never owns credentials.** Model, provider and auth belong to the harness, which is
  what keeps subscriptions, API keys and local models all working.

## Steps

1. Implement `WorkerAdapter` in `packages/harnesses/<name>/src/adapter.ts`.
2. Write the in-agent half if the harness has one, plus the channel that carries its signals.
3. Test without a model first: prove the agent loads your code, connects, and answers control
   commands. That catches loading, resolution and framing bugs on their own.
4. Then test the gate with a fake OpenAI-compatible provider so a real agent makes a real tool
   call, deterministically and offline.
5. Register the adapter where workers are chosen (`Workbench.adapterFor`), and add it to the
   `harness` enum in `packages/core/src/config.ts`.
6. `pnpm check`.

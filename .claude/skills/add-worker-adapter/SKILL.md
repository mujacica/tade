---
name: add-worker-adapter
description: Add or change a worker adapter — the thing that runs a coding agent and reports what it is doing (pi today; another harness later). Use when supporting a new agent harness, or changing the signals and approval gate.
---

# Adding a worker adapter

The port is `packages/core/src/ports/worker.ts`. The reference implementation is
`packages/harness-pi`. An adapter's job is to run an agent and answer two questions honestly:
**what is it doing, and may it do this?**

## The contract

- Emit `WorkerSignal`s: `started`, `turn_started`, `message`, `tool_call`, `tool_result`,
  `permission_request`, `turn_done`, `idle`, `context`, `exited`. These are zod schemas because
  they cross a socket.
- Accept `WorkerCommand`s back: `decision`, `steer`, `queue`, `abort`, `shutdown`.
- Declare `capabilities` truthfully. `permissionGate: false` means approvals cannot be trusted for
  that harness, and the policy engine must treat it accordingly — never fake it.

## Rules

- **Never infer state from rendered output.** A signal comes from a structured channel (an
  in-agent extension, a hook, a protocol message) or it doesn't exist. If a harness can't tell you
  a turn ended, report `unknown` rather than guessing.
- **The gate fails closed.** If the supervisor becomes unreachable while a tool call is held, block
  it. An agent running unsupervised is worse than an agent that stalls.
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

1. Implement `WorkerAdapter` in `packages/harness-<name>/src/adapter.ts`.
2. Write the in-agent half if the harness has one, plus the channel that carries its signals.
3. Test without a model first: prove the agent loads your code, connects, and answers control
   commands. That catches loading, resolution and framing bugs on their own.
4. Then test the gate with a fake OpenAI-compatible provider so a real agent makes a real tool
   call, deterministically and offline.
5. Register the adapter where workers are chosen, and add it to the route config in
   `packages/core/src/config.ts`.
6. Update the agents section of `README.md`, then `pnpm check`.

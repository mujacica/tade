# Wilco — agent guide

Wilco is a local daemon that runs coding agents in lanes (PTYs), derives task status from
observable state, and is driven by an orchestrator. **You may be a Wilco worker editing Wilco itself.**

## Commands

- `pnpm check`: the full gate (biome ci, tsc, vitest). Run it before calling work done.
- `pnpm test`: vitest (must stay under 30s with zero network calls).
- `pnpm exec biome check --write .` formats and fixes.
- `pnpm wilco <args>` runs the CLI from source.

**Run the suite on its own.** `pnpm check` runs the gate in sequence for a reason: the tests spawn
real git and PTY processes with short timeouts, so anything CPU-heavy running alongside them —
`tsc` over the monorepo, most obviously — starves those processes and they time out. That looks
exactly like a regression and is not one: 13 such failures over 485s became 465 passing in 8s once
the suite had the machine to itself. Never conclude the suite is broken from a run that shared it.

There is **no build step**. Node ≥22.18 runs `.ts` directly (type stripping). Consequences:
- Relative imports use the `.ts` extension: `import { x } from './x.ts'`.
- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Type-only imports use `import type`.

## The four rules

1. **R1: every port is an interface plus a registry.** Interfaces live in `packages/core/src/ports/`.
   Implementations are registered by name in one registry map; call sites never `new` a concrete one.
2. **R2: no port interface uses an implementation's vocabulary.** It's `write(lane, bytes)`,
   never `sendKeys`. Check every method name against this before implementing.
3. **R3: capabilities are declared, never sniffed.** Branch on `driver.capabilities.focus`, never on
   `driver.id === 'tmux'`. A Biome plugin (`biome/no-port-id-check.grit`) fails lint on this.
4. **R4: conformance suites come first.** Each port has a shared suite in
   `packages/driver-conformance`; every implementation must import and pass it.

## Other invariants

- **Status is a query, not a memory.** `deriveState` (`core/src/state.ts`) is a pure function of
  probe results: no I/O, no clock reads (take `now`), no async.
- `status` never throws. Failures degrade to a partial answer plus `warnings[]`.
- Tests use **real git repos** built by `test/fixtures/mkrepo.ts`. Never mock git.
- **A fixture must not be kinder than reality.** If the fixture differs from what a user's machine
  looks like, it hides bugs instead of finding them: `mkrepo` deliberately leaves `.wilco/`
  untracked, because a real repository does, and excluding it once concealed a broken teardown.
- Git is invoked directly with `--porcelain=v2` / `-z`. No git wrapper libraries.
- Parsers of external formats (provider transcripts) return `null` on unknown shapes, never throw.
- `intent_spoken` is stored verbatim. Never paraphrase or normalise it.
- **Notes are the one thing Wilco is told rather than derives**, and so the one exception to "status
  is a query": nothing can recover them, so they are kept verbatim in `<home>/memory.jsonl`,
  append-only, and a line that won't parse is skipped rather than thrown over. Never lowercase or
  reword one — `parseUtterance` recovers the original casing for exactly this reason, and it took a
  test with a capital letter in it to notice that it didn't.
- No hot reload of extensions. Activation requires a daemon restart.
- **Under the `pty` driver lanes are the daemon's children**, so they die with it; under `tmux` they
  do not. Which it is, is `capabilities.detach` — never branch on the driver's name. Either way:
  never report a lane as alive without evidence, and keep its spec so it can be relaunched.
- **events.jsonl is the truth**; the SQLite index is derived and must be rebuildable from it. Raw
  lane output never goes in the log (it lives in the lane's scrollback), only sampled byte counts.
- Under subscriber backpressure, `trace` events are dropped first and `blocking` events never.
- `attach` puts the user's terminal in raw mode: every exit path, signals included, must run the
  same `restore()`, and it must be safe to call twice.

## Keeping the repo maintainable

- `README.md` describes what works today. Update it in the same change as the behaviour.
- `.claude/skills/` holds step-by-step recipes for recurring changes (new CLI command, config key,
  state rule, transcript parser, ...). Use the matching skill, and add or update one when you create
  a new extension point.

## Where things go

| Path | Contents |
|---|---|
| `packages/core` | zod schemas, object model, state machine, port interfaces, config |
| `packages/probes` | git · liveness · agent-events · adoption |
| `packages/daemon` | `wilcod`: socket, lane registry, event log |
| `packages/driver-*` | `WorkspaceDriver` implementations |
| `packages/driver-conformance` | shared suites for every port |
| `packages/worker-acp` | ACP worker adapter |
| `packages/orchestrator` | orchestrator extensions and prompt composition |
| `packages/harness-pi` | the pi harness: worker adapter, signal channel, supervision extension |
| `packages/surface-voice` | attention policy, intent grammar, earcons and spoken summaries |
| `packages/app` | the window: project panes, orchestrator strip, push-to-talk |
| `packages/cli` | the `wilco` binary |
| `test/fixtures` | `mkrepo.ts`, provider transcript samples |

Exit codes: `0` ok, `1` runtime error, `2` invalid input/config.

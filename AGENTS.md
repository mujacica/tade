# Wilco — agent guide

Wilco is a voice-first control room for coding agents: it runs them as pi in lanes (terminals),
derives task status from observable state, and is driven by an orchestrator you talk to. It owns no
state of its own — tmux owns the processes, pi owns the conversations, git owns the work — which is
why closing it is harmless. **You may be a Wilco worker editing Wilco itself.**

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

1. **R1: every port is an interface plus a registry.** A port lives with its subsystem —
   `drivers/core`, `harnesses/core`, `voice/core` — next to the conformance suite its
   implementations must pass. Implementations are registered by name in one registry map; call sites
   never `new` a concrete one.
2. **R2: no port interface uses an implementation's vocabulary.** It's `write(lane, bytes)`,
   never `sendKeys`. Check every method name against this before implementing.
3. **R3: capabilities are declared, never sniffed.** Branch on `driver.capabilities.focus`, never on
   `driver.id === 'tmux'`. A Biome plugin (`biome/no-port-id-check.grit`) fails lint on this.
4. **R4: conformance suites come first.** Each port has a shared suite in
   `packages/drivers/core`; every implementation must import and pass it.

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
- **A sandbox that cannot be applied fails the run**, never silently runs the worker unconfined:
  a config that says `seatbelt` and a machine that ignores it is worse than not offering it. It
  contains writes only (the worktree, temp, build caches) — reads are a policy concern, not this.
  The orchestrator is never sandboxed; it has to drive your terminal.
- **No hot reload of extensions.** Wilco writes proposals into `extensions/proposed/` and they do
  nothing until a human moves them; an activated one loads the next time Wilco starts. `--safe`
  loads none of them and must keep working with a broken one sitting in `active/` — safe mode that
  only works when nothing is wrong is not a recovery path. Wilco's own tools always load first, so a
  self-written one can never shadow `status` or `approve`.
- **A setting Wilco accepts and ignores is worse than one it doesn't have**, because it reads like a
  promise. If a config key has no reader, either wire it or delete it.
- **Under the `pty` driver lanes are Wilco's own children**, so they die with it; under `tmux` they
  do not. Which it is, is `capabilities.detach` — never branch on the driver's name. Either way:
  never report a lane as alive without evidence, and keep its spec so it can be relaunched.
- **`detach()` closes the window; `shutdown()` stops the work.** Closing Wilco must never be what
  stops your agents, so the ordinary exit path detaches. Where lanes cannot outlive us and cannot be
  found again (`detach: false`, `adopt: false`), releasing them *is* ending them — leaving processes
  nobody can see, drive or stop is the one outcome worse than both.
- **A lane is alive only if the driver hands it back.** A live pid proves something is running, not
  that this driver can drive it: a fresh driver knows nothing about a window it did not open. Ask
  the driver on open (`list` for what it already holds, `adopt` for what it can find) and take its
  answer over the process table.
- **One window per home, and questions never need it.** Opening the workbench takes a lock on
  `WILCO_HOME`, because two writers would interleave in one journal. So anything that only reads —
  `status`, `logs`, `notes`, `summary`, `spend` — must read the files directly (`readJournal`,
  `Memory.open`) and never open the workbench. A question you cannot ask while a window is open is a
  question people stop asking.
- **There is no server.** The one socket left is the `ToolHost`: a channel from the window to its
  own child agents, undiscoverable and dead when the window closes. If something that is not our own
  child would ever want to call it, it has become a daemon again — which is the thing we removed.
- **An agent is a lane with pi in it**, named `<task>/agent`, talking in a pi session named after
  the task. That session id never changes, which is what makes reopening ordinary: the same command
  line starts the conversation the first time and continues it every time after.
- **events.jsonl is the truth**; the SQLite index is derived and must be rebuildable from it. Raw
  lane output never goes in the log (it lives in the lane's scrollback), only sampled byte counts.
- Under subscriber backpressure, `trace` events are dropped first and `blocking` events never.
- `attach` puts the user's terminal in raw mode: every exit path, signals included, must run the
  same `restore()`, and it must be safe to call twice.

## Keeping the repo maintainable

- `README.md` describes what works today. Update it in the same change as the behaviour.
- **`skills/` holds step-by-step recipes** for recurring changes (new CLI command, config key, state
  rule, transcript parser, ...). Use the matching skill, and add or update one when you create a new
  extension point. They live at the repo root, not under any one agent's directory, so every agent
  working on Wilco can read them — `.claude/skills` is a symlink to it. Do not confuse them with
  `<WILCO_HOME>/skills`, which is what Wilco itself has learned.

## Where things go

Each subsystem is a folder: `core` holds the port and the conformance suite, the siblings are
implementations of it.

| Path | Contents |
|---|---|
| `packages/core` | the domain: object model, state machine, config, policy, memory, prompts |
| `packages/status` | observing reality: git · processes · adoption · tests · liveness |
| `packages/workbench` | what Wilco holds while open: lane registry, journal, notes, agents |
| `packages/drivers/core` | the `WorkspaceDriver` port + the suite every driver passes |
| `packages/drivers/{pty,tmux}` | where lanes physically live |
| `packages/harnesses/core` | the `WorkerAdapter` port: what an agent tells us, how we answer |
| `packages/harnesses/pi` | runs and supervises pi |
| `packages/voice/core` | the voice surface + the speech ports |
| `packages/voice/{stt,tts}` | speech in · speech out |
| `packages/orchestrator` | the thing you talk to: its tools and its prompt |
| `packages/app` | the window: project panes, orchestrator strip, push-to-talk |
| `packages/cli` | the `wilco` binary |
| `test/fixtures` | `mkrepo.ts`, provider transcript samples |

Exit codes: `0` ok, `1` runtime error, `2` invalid input/config.

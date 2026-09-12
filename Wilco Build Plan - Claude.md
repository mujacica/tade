# Wilco — Build Plan

*From empty repo to the moment Wilco ships its own first commit.*

Companion to `wilco-design.md`. v0.1

---

## 0. The target

**M1 — Dogfood.** You say "add a `--json` flag to `wilco lanes`" into `wilco chat`. A worker does it in a worktree, status tracks it through `working → review`, you merge. Wilco has shipped a change to Wilco. Everything after this point is built by the thing you're building.

**M2 — Hands-free.** Same, from a walk, by voice.

**M3 — Self-extending.** Wilco writes and proposes its own new tools.

M1 is the one that matters. It's roughly three weeks of evenings, and it's the point where the project's velocity stops being a function of your typing speed.

---

## 1. Stack

One language, end to end. This is not a stylistic preference — **Wilco has to be able to read and modify itself**, and Pi extensions are TypeScript. A Rust daemon would give better PTY throughput and a single binary, and it would also mean the self-extension loop has to reason across two toolchains from day one. Revisit at v1 if PTY perf ever shows up in a profile. It won't at this scale.

| Concern | Choice | Why this one |
|---|---|---|
| Runtime | **Node 22 LTS** | qwen-audio-agent requires 22+; native ESM; stable `node:test` if you ever want to drop vitest |
| Language | **TypeScript 5.x, ESM, `strict`** | Same language as Pi extensions |
| Monorepo | **pnpm workspaces** | No Turbo yet. Add it when builds exceed 10s. |
| Lint + format | **Biome** | One tool, one config, fast. Fewer moving parts for an agent to trip over. |
| PTY | **node-pty** | The one everyone uses. Prebuilds via `@homebridge/node-pty-prebuilt-multiarch` if native builds annoy you. |
| Screen state | **@xterm/headless** | Maintains a real screen buffer server-side. `capture()` returns rendered state, not a soup of escape sequences. Non-negotiable — regex-scraping raw PTY bytes is the single biggest time sink in this genre. |
| IPC | **Unix socket + JSON-RPC 2.0** via `vscode-jsonrpc` | Same wire format as ACP, so one mental model |
| Agent protocol | **ACP** (`@zed-industries/agent-client-protocol`, verify current package name) | Permission requests arrive as protocol messages instead of being scraped out of a terminal |
| Process spawn | **execa** | Sane defaults, good errors |
| Git | **spawn `git` directly** | `--porcelain=v2` and `-z` are stable contracts. Wrapper libraries lag and hide flags you need. |
| Event log | **JSONL** (truth) + **better-sqlite3** (index) | Index is derived and rebuildable, so losing the DB is never data loss |
| Config / prefs | **YAML** + **zod** | Human-editable, git-trackable. Zod schemas double as the JSON Schema for orchestrator tool definitions. |
| CLI | **commander** | Boring on purpose |
| Logs | **pino** | Structured JSON, and the orchestrator can read its own logs |
| Tests | **vitest** | Fast watch mode matters when an agent is running the suite |

Deliberately absent from v0: Docker, any web framework, any UI framework, Turbo, a plugin registry, telemetry.

---

## 2. What "scalable from the start, one option at a go" means concretely

Four rules. They cost roughly a day of extra work total and they're what makes driver #2 take an afternoon instead of a refactor.

**R1 — Every port is an interface plus a registry with exactly one entry.**
```ts
// packages/core/src/ports/workspace.ts
export interface WorkspaceDriver { /* … */ }

// packages/daemon/src/registry.ts
export const drivers: Record<string, () => WorkspaceDriver> = {
  pty: () => new PtyDriver(),
  // tmux, ghostty, kitty land here later and nothing else changes
}
```

**R2 — No port interface may use an implementation's vocabulary.**
The method is `write(lane, bytes)`, never `sendKeys`. `sendKeys` is tmux's word, and the moment it's in the interface, the Ghostty driver has to pretend to be tmux. Review every method name against this before writing the implementation.

**R3 — Capabilities are declared, never sniffed.**
Call sites branch on `driver.capabilities.focus`, never on `driver.id === 'tmux'`. One `if (driver.id === …)` anywhere in the codebase is a design failure and should fail lint.

**R4 — Conformance suites are written before the second implementation exists.**
Each port ships a shared test suite. `pty` passes it in phase 2. When you write the Ghostty driver in month two, you import the suite, run it, and fix what's red. This is the highest-return 200 lines in the project.

```ts
// packages/driver-conformance/src/index.ts
export function testWorkspaceDriver(name: string, make: () => WorkspaceDriver) {
  describe(`WorkspaceDriver: ${name}`, () => { /* ~20 tests */ })
}

// packages/driver-pty/test/conformance.test.ts
testWorkspaceDriver('pty', () => new PtyDriver())
```

### Port status at v0

| Port | Interface | v0 implementation | Deferred candidates |
|---|---|---|---|
| `WorkspaceDriver` | ✅ | `pty` | tmux, ghostty, kitty, wezterm, zellij, container |
| `WorkerAdapter` | ✅ | `acp` | pty-scrape, http |
| `Surface` | ✅ | `cli` (then `voice` in P4) | tui, web, chat, watch |
| `MemoryStore` | ✅ | `fs-git` | sqlite, remote |
| `PolicyEngine` | ✅ | `rules-yaml` | OPA, custom |

---

## 3. Repo layout

```
wilco/
├── AGENTS.md                    ← written in phase 0, not later
├── CLAUDE.md                    → symlink to AGENTS.md
├── biome.json
├── pnpm-workspace.yaml
├── packages/
│   ├── core/                    types, zod schemas, state machine, event types
│   ├── probes/                  git · liveness · agent-events · adoption
│   ├── daemon/                  wilcod: socket, lane registry, event log
│   ├── driver-pty/
│   ├── driver-conformance/      shared suites for every port
│   ├── worker-acp/
│   ├── orchestrator/            Pi extensions + prompt composition
│   ├── surface-voice/           phase 4
│   ├── memory/                  phase 5
│   └── cli/                     the `wilco` binary
├── test/
│   ├── fixtures/mkrepo.ts       builds real git repos in tmp
│   ├── fixtures/transcripts/    checked-in provider transcript samples
│   └── fake-agent/              scripted ACP server
└── extensions/                  self-written tools (phase 6) — its own git repo
```

**Write `AGENTS.md` in phase 0.** Wilco is going to be worked on by agents from phase 3 onward, and the repo conventions need to exist before the first agent reads them. Keep it under 60 lines: the four rules above, the test commands, the "no `driver.id ===` checks" rule, and where things go.

---

## 4. Phase 0 — Skeleton

**½ day.**

1. `pnpm init`, workspace file, six package stubs with `tsconfig` extending a base.
2. Biome config. One rule worth adding by hand: a `noRestrictedSyntax`-style ban on comparing `.id` on a driver.
3. Vitest config at root, workspace-aware.
4. `packages/core/src/config.ts` — zod schema for `~/.wilco/config.yaml`, loader with defaults, `wilco config --check`.
5. `packages/cli` — commander skeleton, `wilco --version`, `wilco config --check`.
6. CI: GitHub Actions, Node 22, `pnpm i && pnpm biome ci && pnpm test`.
7. `AGENTS.md`.

**Verify:** CI green on an empty test suite. `wilco config --check` on a deliberately broken YAML prints a zod error naming the bad key and exits 2.

---

## 5. Phase 1 — `wilco status`

**2–3 days. No daemon, no AI, nothing that writes.**

The entire project's credibility rests here. If status is wrong, every layer above amplifies the error, and you will not notice because the voice will sound confident.

### Build

1. **Object model** (`core/src/model.ts`) — zod schemas for `Workspace`, `Project`, `Task`, `Lane`, `Run`, plus `TaskState` union. Export inferred types. These schemas are also what phase 3 turns into orchestrator tool signatures, so get the field names right now.

2. **Task discovery.** A Task exists if a git worktree has a `wilco/*` branch and a `.wilco/task.yaml`. Read `intent_spoken`, `created`, `project` from it. Phase 1 only reads; phase 3 writes.

3. **Probe: git** (`probes/src/git.ts`)
   - `git worktree list --porcelain`
   - `git status --porcelain=v2 -z --branch` per worktree
   - `git rev-list --left-right --count HEAD...origin/main`
   - `git log -1 --format=%H%x00%ct%x00%s`
   - PR state via `gh pr view --json state,url` if `gh` is on PATH, otherwise skip silently
   - Everything `-z` / NUL-delimited. Filenames contain spaces and newlines and this will bite you exactly once.

4. **Probe: liveness** (`probes/src/liveness.ts`) — interface now, stub returning `[]`. Phase 2 fills it from the lane registry. Defining it now stops the state machine from being rewritten later.

5. **Probe: adoption** (`probes/src/adoption.ts`) — scan provider transcript directories for agent sessions started outside Wilco. Isolate hard: one file, a `parserVersion` per provider, a fixture corpus. This is the most brittle code in the repo because it depends on formats nobody promised you. Every parser returns `null` rather than throwing on an unrecognised shape.

6. **State machine** (`core/src/state.ts`) — a **pure function**: `(probes: ProbeBundle) => TaskState`. No I/O, no clock reads (pass `now` in), no async. This purity is what makes it exhaustively testable, and it's the thing you'll change most often.

7. **`wilco status`** — human output and `--json`. Human output under 10 lines for a typical machine.

### Tests

- `test/fixtures/mkrepo.ts` builds **real** git repos in `mkdtemp` with scripted histories: clean worktree, dirty worktree, detached head, worktree with 3 commits ahead, worktree whose branch was deleted upstream. No mocking git. Mocked git teaches you nothing about `--porcelain=v2`.
- **Table-driven state machine tests.** Enumerate probe combinations against expected state. Aim for 40+ cases and include the ugly ones: dirty worktree with green tests, agent alive but silent 30 minutes, worktree whose process died.
- Adoption parser against checked-in transcript fixtures, one per provider version you support. When a provider changes format, a test goes red instead of status quietly going wrong.
- **Robustness property:** `status` never throws. Feed it a repo with a corrupt `.git`, a worktree pointing at a deleted directory, a `task.yaml` with the wrong shape. Every one degrades to a partial answer with a `warnings[]` array.
- **Idempotence:** ten consecutive `--json` runs on an unchanged machine produce byte-identical output apart from timestamps.

### Exit criteria

On your actual machine, with at least three agent sessions running that you started by hand in two different repos, `wilco status --json` matches ground truth that you verify manually. Including the ones Wilco didn't start.

**Don't build:** any write path, any daemon, any caching.

---

## 6. Phase 2 — Daemon, lanes, event log

**~1 week.**

### Build

1. **`wilcod`** — long-lived process, Unix socket at `$XDG_RUNTIME_DIR/wilco.sock` (falls back to `~/.wilco/run/`), JSON-RPC 2.0 via `vscode-jsonrpc`. Socket permissions `0600`. Reject connections from other uids.

2. **`WorkspaceDriver` interface** in `core`, per the design doc.

3. **`driver-pty`** — `node-pty` spawns, `@xterm/headless` maintains a screen buffer per lane so `capture()` is a rendered snapshot. Scrollback capped (10k lines default), configurable.

   > **Known limitation, accept it for v0:** lanes are children of the daemon, so a daemon restart kills them. Design `LaneHandle` to carry cwd, argv and env so relaunch is possible, and document it. This is the honest argument for the tmux driver later, which gets survival for free from the tmux server. Do not solve it now with double-forking; that's a week you don't have.

4. **Lane registry**, persisted to `~/.wilco/lanes.json` on every mutation, reconciled on boot against actual processes.

5. **Event log** (`daemon/src/events.ts`) — append to `~/.wilco/events.jsonl`, `fsync` on `urgency >= notable`, index into SQLite on write, rebuild index from JSONL on boot if missing or stale. Pub/sub to socket subscribers with a bounded per-subscriber queue that drops `trace` first under pressure.

6. **`wilco attach <task>/<lane>`** — raw mode, bidirectional passthrough, `SIGWINCH` → `resize()`, detach on `Ctrl-\` twice. Restore terminal state in a `finally`, including on `SIGTERM`. Getting this wrong leaves people's terminals broken and they will never trust the tool again.

7. **CLI**: `wilco spawn`, `lanes`, `attach`, `logs -f`, `kill`, `daemon start|stop|status`.

8. Wire `probes/liveness` to the real registry. Phase 1's status now reflects live lanes.

### Tests

- **`driver-conformance`** — the suite every future driver must pass:
  - open → write → capture round-trip
  - output ordering preserved under rapid writes
  - resize doesn't corrupt the buffer (write, resize, capture, assert content intact)
  - `setTitle` then `list` reflects it
  - `close` is idempotent; `capture` after close throws a typed `LaneClosedError`
  - `list` after daemon-side restart returns registry state
  - concurrent writes from two callers interleave at line granularity, never mid-byte
  - `attachCommand` returns a string that actually works (spawn it in a pty pair and assert)
- **Attach round-trip integration:** spawn `bash`, attach over a synthetic pty pair, send `echo hello\n`, assert capture contains `hello` within 2s.
- **Two simultaneous attachers** see identical output. Run it for real: one Ghostty tab, one Terminal.app tab.
- **Crash safety:** `SIGKILL` the daemon mid-write, restart, assert `events.jsonl` parses cleanly and the index rebuilds to the same row count.
- **Backpressure:** 50 subscribers, 10k events, assert no `blocking`-urgency event is ever dropped.
- **Terminal hygiene:** attach, `SIGTERM` the client, assert `stty -a` matches the pre-attach state. Automate this; it regresses constantly.

### Exit criteria

`wilco spawn checkout/scratch --cmd bash`, attach from two different terminal apps at once, both see the same session. Kill the daemon, restart it, `wilco status` correctly reports the lanes as dead rather than pretending they're alive.

---

## 7. Phase 3 — Orchestrator and workers — **M1**

**~1 week. This is the self-hosting phase.**

### Build

1. **`worker-acp`** — ACP client. Spawn the provider CLI in ACP mode as a subprocess, JSON-RPC over stdio. Translate:

   | ACP | Wilco |
   |---|---|
   | session update / message | `event: output` (urgency `trace`) |
   | tool call | `event: tool_call` (urgency `routine`) |
   | **permission request** | `event: permission_request` (urgency `blocking`) → task state `blocked` |
   | turn complete | `event: turn_done` → recompute state |
   | error | `event: failed`, increment failure counter |

   The permission-request line is the whole reason for choosing ACP. Scraping `Do you want to proceed? (y/n)` out of a screen buffer is a permanent source of false blocks.

2. **Worktree lifecycle** — `git worktree add` off a fresh branch, write `.wilco/task.yaml` including `intent_spoken` **verbatim**, and a teardown that refuses to run if the worktree is dirty and unmerged.

3. **Pi as orchestrator.** A `pi` process with extensions in `packages/orchestrator/extensions/`, each wrapping one daemon RPC:

   `status` · `spawn` · `steer` · `focus` · `approve` · `deny` · `park` · `resume` · `remember` · `read_events`

   Generate each tool's JSON Schema from the zod schema in `core`. One source of truth for the shape of a Task, used by the CLI, the RPC layer and the orchestrator's tool definitions.

4. **Prompt composition** (`orchestrator/src/compose.ts`) — assembles the system prompt from: role, global preferences, project brief, active skills, current status snapshot. Deterministic and snapshot-tested, so a prompt change is a visible diff in review.

5. **`wilco chat`** — text REPL to the orchestrator. No voice yet. Get the answers right in a modality where you can read them.

6. **Sandboxing.** Workers run under `bwrap` (Linux) or `sandbox-exec` (macOS) with the worktree writable and `$HOME` mostly not. The orchestrator stays on the host because it drives your terminal. Pi runs with the permissions of whatever launched it and ships no permission system of its own, so this split is doing real work.

### Tests

7. **The fake ACP agent** (`test/fake-agent/`) — a scripted ACP server driven by YAML:

   ```yaml
   name: blocked-then-approved
   script:
     - emit: message
       text: "Looking at the webhook handler"
     - emit: permission_request
       tool: bash
       command: "npm i stripe@15"
     - await: approval
     - emit: tool_call
     - emit: turn_done
       status: ok
   ```

   Deterministic, instant, free. **This is the single most valuable test asset in the repo.** Every state machine scenario, every orchestrator behaviour and every attention-policy rule is tested against it. Without it you burn tokens and wall-clock on every run and your CI is non-deterministic.

8. **Scenario matrix** — at least 12 scripts: happy path, blocked→approved, blocked→denied, failed 3× (assert `failed`), agent hangs (assert stall detection), agent crashes mid-turn, agent emits malformed JSON-RPC, permission request while another is pending, turn completes with dirty worktree, worker killed externally, two tasks in one project, worktree deleted under a live run.

9. **Golden tool-call transcripts.** For 10 canonical requests ("where are we", "start X in Y", "what's checkout blocked on"), record the orchestrator's tool-call sequence and diff on every run. A prompt edit that breaks tool selection then shows up as a red test instead of as weird behaviour three days later.

10. **One live smoke test** against the real provider CLI, gated behind `WILCO_LIVE=1` so CI doesn't need credentials. Runs before every release, never in the inner loop.

### Exit criteria — the self-hosting moment

```
$ wilco chat
> start a task in wilco to add a --json flag to `wilco lanes`

  ✓ worktree wilco/lanes-json created
  ✓ claude-code started

> where are we

  wilco/lanes-json — working, 2 minutes, 3 files touched
```

…it finishes, `wilco status` shows `review`, you read the diff, you merge.

**From this point on, Wilco builds Wilco.** Every phase below is a task you dictate rather than type.

---

## 8. Phase 4 — Voice — **M2**

**2–3 days, because phase 3 did the hard part.**

### Build

1. **Wilco as an ACP server.** Expose the orchestrator over ACP on stdio: `wilco acp`. Roughly 150 lines, mostly mapping orchestrator turns onto ACP session updates.
2. **Wire qwen-audio-agent** — `qwenaudio config`, backend = the `wilco acp` command. Full-duplex, barge-in, local wake word and spoken permission gates arrive with it. Zero Wilco-specific voice code.
3. **Attention policy engine** (`core/src/attention.ts`) — pure function `(event, surface, context) => ChannelMask`. Same purity discipline as the state machine.
4. **Earcons** — three short tones, `afplay` on macOS / `paplay` on Linux, generated once and shipped as assets. Distinguishable at low volume through one earbud: descending for `blocked`, ascending for `review`, flat double for `failed`.
5. **Budget and batching** — hard cap per hour, overflow collapsed into the next brief.
6. **Prefix router** — the daemon already sits between a lane's stdin and the worker, so intercept a leading trigger token. Dictated `wilco park this` is routed to the intent grammar and never reaches the agent; anything else passes through.
7. **Focus-aware muting** — if a lane is focused and has had keyboard input in the last 30s, drop the voice surface to earcon-only.

### The three voice modes at v0

| Mode | v0 implementation | Effort |
|---|---|---|
| **Dictate** | Wispr Flow, unmodified, into any lane | zero — lanes are real text fields |
| **Command** | local wake word + closed intent grammar | small, must stay under 300ms |
| **Converse** | qwen-audio-agent over ACP | config only |

Dictate needs no integration at all, and that is the direct payoff of the `pty` driver decision. Note for planning: Flow is cloud-only with no offline mode and the free tier caps at 2,000 words/week, so budget for Pro or plan a local fallback.

### Tests

- **Attention policy table:** every event type × every surface × focused/unfocused → expected mask. Roughly 120 cases, all instant.
- **Budget:** fire 50 events across a simulated hour, assert ≤6 spoken and that every `blocking` event is either spoken or in the batch summary. Never silently dropped.
- **Utterance corpus** — 60+ written transcriptions including realistic mishearings: "park"/"bark", "checkout"/"check out", "deny"/"the neigh", project names that collide with common words. Assert each either resolves correctly or falls through to free text. Never mis-resolves to a *different* valid command.
- **Approval safety fuzz** — generate single-utterance inputs and assert none can reach a hard-tier approval. This test should be impossible to delete without a review, so put a comment saying so.
- **Latency budget:** assert wake-word → earcon under 300ms on your hardware, in CI as a warning rather than a failure.

### Exit criteria

Walk around the block. Ask status. Approve one soft request. Park one task. Come back, run `wilco status --json`, verify all three happened correctly.

---

## 9. Phase 5 — Memory and approvals

**~1 week. Dictate this one.**

- `memory/` package: preferences (YAML, git-tracked, three scopes, narrowest wins), journal queries over the event log, skills (Markdown + frontmatter).
- `remember` tool with scope inference and a spoken confirmation of what was written.
- Two-tier approvals: soft (one word) and hard (readback with a distinct confirm phrase). Hard tier covers force push, history rewrite, `rm -rf` outside a worktree, `.env`/credential reads, new outbound hosts, migrations, spend over threshold.
- Approval ledger: every request and decision appended with the exact utterance.
- Morning brief: one composed spoken summary, at most one skill proposal per brief.

**Tests:** preference precedence table; ledger append-only property; hard-tier phrase matching rejects near-misses; brief composition snapshot tests; a test asserting a denied hard-tier request cannot be re-requested in the same run without new information.

---

## 10. Phase 6 — Self-extension — **M3**

**Ongoing.**

- `extensions/` initialised as its own git repo.
- `wilco --safe` boots with zero extensions. **Covered by a CI test that deliberately writes a broken extension and asserts safe mode still starts.**
- `propose_extension` tool writes to `extensions/proposed/` and creates a review task.
- Activation requires approval **and a daemon restart**. No hot reload, ever.
- Skill promotion loop with 30-day decay.
- Then: the second `WorkspaceDriver`. Pick tmux if you want detach-survival, Ghostty if you're on macOS and want native tabs — its 1.3.0 AppleScript dictionary gives you tabs, titles, input and enumeration by working directory, which is enough for a full driver. Either way, import the conformance suite and fix what's red. That's the whole job, and proving that is the point of the exercise.

---

## 11. Schedule and risk

| Phase | Estimate | Risk | Mitigation |
|---|---|---|---|
| 0 | ½ day | none | |
| 1 | 2–3 days | adoption parsers are brittle | isolate, fixture corpus, never throw |
| 2 | 1 week | node-pty native builds; terminal state restoration | prebuilt binaries; automated `stty` test |
| 3 | 1 week | **ACP maturity across providers** | fake agent decouples you; pty-scrape fallback if a provider's ACP mode is weak |
| 4 | 2–3 days | low | |
| 5 | 1 week | low, and dictated | |

**The one real risk is phase 3's ACP dependency.** Before starting phase 3, spend two hours confirming that your chosen provider's ACP mode actually emits permission requests as protocol messages rather than only rendering them to a terminal. If it doesn't, you need the pty-scrape fallback adapter and phase 3 grows by three days. Find that out on day one of the phase, not day four.

Second-order risk: the temptation to start at phase 4 because voice is the fun part. Voice on top of wrong status is worse than no voice, because it's confidently wrong in your ear while you're too far from the machine to check.

---

## 12. Definition of done for the prototype

- [ ] `pnpm test` green, under 30 seconds, zero network calls
- [ ] `wilco status --json` verified truthful against a hand-checked machine state, including adopted sessions
- [ ] Two terminal apps attached to one lane simultaneously
- [ ] Daemon killed and restarted without data loss or false "alive" reports
- [ ] Driver conformance suite exists and `pty` passes all of it
- [ ] Fake ACP agent covers ≥12 scenarios
- [ ] Golden tool-call transcripts for 10 canonical requests
- [ ] A merged PR in the Wilco repo authored by a Wilco-managed worker
- [ ] `wilco --safe` starts with a deliberately broken extension present
- [ ] `AGENTS.md` accurate enough that a fresh worker follows the four rules without being told

The eighth box is the one that matters. Everything else is in service of it.

# Wilco

> **wilco** *(radio procedure)* — "will comply." Sent by the receiving station to confirm a message has been understood and will be acted on.

*A voice-first workbench for running coding agents on your own machine.*

Design document, v0.1

---

## 0. Shape

A local daemon owns your agent sessions. Around it sit four swappable adapters: the **surface** you interact through, the **workspace driver** that decides where terminals physically live, the **worker adapter** that runs the actual coding agents, and the **stores** that hold memory and policy.

You talk to one orchestrator. It knows what projects exist, what's running, what's stuck, and what you said you were trying to do. It can spawn work, show you things, ask permission, and extend its own toolset. Everything it does is derived from observable state, never from what it remembers saying.

```
                  ┌──────────────────────────────────────┐
  voice ──────────┤                                      │
  TUI   ──────────┤          wilcod (core)             ├──── ACP ──── Claude Code
  web   ──────────┤   project model · event log ·        │              Codex
  chat  ──────────┤   state machine · attention ·        ├──── ACP ──── Pi
  editor ─────────┤   approvals · orchestrator           │              OpenCode
                  │                                      ├──── PTY ──── anything else
                  └───────────────┬──────────────────────┘
                                  │
                       WorkspaceDriver (one of)
              pty · tmux · ghostty · kitty · wezterm · zellij · container
```

---

## 1. Principles

These are the load-bearing ones. Everything downstream follows from them.

**1. Status is a query, not a memory.** The orchestrator never reports state from its context window. Every "where are we" triggers probes against git, process liveness, and agent event streams. An agent that narrates its own progress will be confidently wrong within a day.

**2. PTY ownership is separate from display.** The thing that decides where a process lives is not the thing that decides where you look at it. Conflating these is why every existing tool forces tmux on you.

**3. The human's terminal is not ours to take.** Wilco never wraps your shell, never intercepts your prefix key, never requires you to launch it before you can work. It is a thing you attach to.

**4. Voice is a surface, not the architecture.** It subscribes to the same event bus as everything else and has no privileged path. If voice is unavailable the system loses nothing but convenience.

**5. Blocked and done are different states.** The entire attention model rests on distinguishing "waiting on you" from "finished, needs your eyes" from "still working." Tools that collapse these produce unusable notifications.

**6. Nothing self-modifies without a restart and a review.** Self-extension is the point, but a hot-reloaded half-broken tool inside a running orchestrator is an evening lost.

**7. Intent is captured, not reconstructed.** Git tells you what changed. Only you can say why you started.

---

## 2. The terminal question

You asked whether tmux is right. The honest answer is that tmux is right for *one* of the two jobs people use it for, and wrong for the other.

tmux does two things: it owns PTYs so processes survive disconnection, and it draws tabs. The first is genuinely valuable and hard to replace. The second competes directly with your terminal emulator, which is why running tmux inside Ghostty gives you two levels of tabs, two prefix keys, and degraded scrollback.

**So split them.** Wilco's daemon owns PTYs by default. Your terminal is a viewer. Tabs are whatever your terminal calls tabs.

### 2.1 The `WorkspaceDriver` port

```ts
interface WorkspaceDriver {
  id: string
  capabilities: {
    detach: boolean        // survives client disconnect
    remoteAttach: boolean  // reachable over SSH
    nativeTabs: boolean    // tabs are the emulator's own
    focus: boolean         // can raise a specific lane
    setTitle: boolean
    adopt: boolean         // can discover lanes it didn't create
  }

  open(spec: LaneSpec): Promise<LaneHandle>
  write(lane: LaneId, data: Uint8Array): Promise<void>
  capture(lane: LaneId, opts: { lines: number }): Promise<string>
  resize(lane: LaneId, cols: number, rows: number): Promise<void>
  focus(lane: LaneId): Promise<void>
  setTitle(lane: LaneId, title: string): Promise<void>
  attachCommand(lane: LaneId): string
  list(): Promise<LaneHandle[]>
  adopt(hint: AdoptHint): Promise<LaneHandle[]>
  close(lane: LaneId): Promise<void>
}
```

`attachCommand` is the escape hatch that makes the whole thing work: whatever the driver, there is always a string a human can run to see the thing. On the `pty` driver that's `wilco attach checkout/stripe-v15`. On `tmux` it's `tmux attach -t checkout`. The voice layer says "it's open in tab three" or "run `wilco attach checkout`" depending on capability.

### 2.2 Driver matrix

| Driver | PTY owner | Detach | Remote | Native tabs | Focus | Adopt | Notes |
|---|---|---|---|---|---|---|---|
| **`pty`** *(default)* | wilcod | ✅ | ✅ | host's own | ➖ | ➖ | Imposes nothing. Works in every terminal. |
| `tmux` | tmux server | ✅ | ✅ | ❌ | ✅ | ✅ | Best headless / SSH story. Nests badly in GUI terminals. |
| `ghostty` (macOS) | Ghostty | ❌ | ❌ | ✅ | ✅ | ✅ | AppleScript dictionary since 1.3.0 (Mar 2026): inspect and control windows, tabs, splits and terminals, send text/key/mouse, `set_tab_title`, and query `every terminal whose working directory contains …`. |
| `ghostty` (Linux) | Ghostty | ❌ | ❌ | partial | partial | ❌ | Only `+new-window` over D-Bus today; no CLI for splits or targeting specific windows. Track ghostty#12556. |
| `kitty` | kitty | ❌ | ✅¹ | ✅ | ✅ | ✅ | Remote control protocol; `ls` returns a JSON tree with tab titles, cwd and foreground process. Richest introspection. |
| `wezterm` | wezterm mux | ✅ | ✅ | ✅ | ✅ | ✅ | Mux server means detach *and* native tabs. Best all-round GUI option. |
| `zellij` | zellij | ✅ | ✅ | ❌ | ✅ | ✅ | Same nesting problem as tmux, nicer defaults. |
| `container` | docker / bwrap | ✅ | ✅ | ❌ | ❌ | ❌ | Composes with any of the above as the display layer. |

¹ via kitty's own remote-control-over-SSH support.

### 2.3 How this resolves your requirement

- **Default is `pty`.** Someone who has never heard of tmux installs Wilco, keeps using Ghostty exactly as they do now, and opens a tab running `wilco attach <task>` when they want to watch something. Nothing nests. Nothing is hijacked.
- **tmux is a first-class option, not the floor.** If you live in tmux, set `driver: tmux` and Wilco's lanes become tmux windows in your existing sessions, named by the convention below. Your muscle memory works. Wilco adopts windows you created by hand.
- **iTerm2 users get both.** iTerm2's tmux control mode (`tmux -CC`) renders remote tmux windows as native tabs and splits, which is the only configuration today that gives you detachability and native tabs without a mux server. Ghostty does not offer this and does not intend to.
- **Ghostty on macOS is genuinely good now.** The 1.3.0 AppleScript dictionary is enough to build a real driver: create tabs, title them, send input, enumerate terminals by working directory. Linux lags; the driver degrades to `pty` with a `+new-window` launch.

### 2.4 Naming convention (driver-independent)

```
wilco/<project>/<task>/<lane>
```

Rendered per driver: tmux session `checkout`, window `stripe-v15`, pane title `agent`. Ghostty tab title `checkout · stripe-v15 · agent`. kitty tab with matching `title` field. The convention is what makes adoption possible — a lane Wilco didn't create but that matches the pattern gets pulled into the model.

---

## 3. Object model

```
Workspace                      one machine, one daemon
└── Project                    a repo root + brief + preferences + skills
    └── Task                   an intent + branch + worktree   ← what you talk about
        └── Lane               one PTY: agent | server | tests | shell
            └── Run            one agent session, resumable
```

**Task** is the unit of conversation. Everything you say by voice resolves to a task or a project. Tasks have:

```yaml
id: checkout/stripe-v15
project: checkout
intent_spoken: "the stripe integration is failing on subscription renewals,
                I think it's the webhook signature check"   # verbatim, never paraphrased
branch: wilco/stripe-v15
worktree: ~/.wilco/worktrees/checkout-stripe-v15
created: 2026-09-11T09:14:22Z
state: blocked
lanes: [agent, tests]
```

`intent_spoken` is the single field nothing else in the system can reconstruct. Store it raw.

### 3.1 State machine

```
queued ──▶ working ──┬──▶ blocked ──▶ working
                     ├──▶ review ──▶ merged
                     ├──▶ failed ──▶ working
                     └──▶ parked ──▶ working
```

| State | Means | Voice priority |
|---|---|---|
| `blocked` | Agent is waiting on a human decision | **1 — always speak** |
| `review` | Work finished, needs your eyes | **2 — speak** |
| `failed` | Repeated failure, agent is looping | **3 — speak** |
| `working` | Actively progressing | silent |
| `parked` | Deliberately set aside | silent |
| `queued` | Not started | silent |

### 3.2 Status derivation

Four probes, run on every status query, never cached beyond a few seconds:

1. **git** — worktree list, branch, ahead/behind, dirty files, PR state
2. **liveness** — process alive, ms since last output, context usage if the adapter reports it
3. **agent events** — ACP session updates, pending permission requests
4. **adoption scan** — agent sessions started outside Wilco, found by reading the providers' own transcript files

Probe 4 is the one people skip and then wonder why "what was I working on" is wrong. If you ever run `claude` directly in a terminal, the daemon must still find it.

---

## 4. Ports

| Port | Swappable | Reference implementations |
|---|---|---|
| `Surface` | ✅ | voice, TUI, web dashboard, chat bridge, editor |
| `WorkspaceDriver` | ✅ | pty, tmux, ghostty, kitty, wezterm, zellij, container |
| `WorkerAdapter` | ✅ | ACP (preferred), PTY-scrape (fallback) |
| `MemoryStore` | ✅ | filesystem+git (default), SQLite, remote |
| `PolicyEngine` | ✅ | rules file (default), OPA, custom |

Core, deliberately **not** swappable: the project/task model, the event log, the state machine, the attention policy, and the approval ledger. If those are pluggable you don't have a system, you have a framework.

---

## 5. Interop: ACP in both directions

This is the centrepiece and the reason the whole thing is cheap to build.

**Wilco is an ACP client.** It drives Claude Code, Codex, Pi, OpenCode, Gemini CLI and anything else that speaks the protocol. You get worker plug-and-play for free.

**Wilco is also an ACP server.** It presents itself as an agent. Which means:

- **Voice comes free.** Point qwen-audio-agent at Wilco as its backend and you have full-duplex voice with barge-in, an on-device wake word, and spoken permission gates, without writing a voice integration. Swap in a different ACP-capable voice frontend later and nothing in Wilco changes.
- **Editors come free.** Any ACP client can drive it.
- **Chat bridges come free.** OpenClaw already routes plain-language requests to ACP sessions.

The rule: *any surface that can speak ACP needs zero Wilco-specific code.* Surfaces that can't (a custom TUI, a web dashboard) subscribe to the event socket instead.

### 5.1 Voice backend options

| Option | Latency | Privacy | Effort |
|---|---|---|---|
| qwen-audio-agent as ACP frontend | good | local wake word, cloud ASR by default | ~zero |
| Fully local: Parakeet/Whisper + Piper/Kokoro | fair | complete | moderate |
| OpenAI GPT-Live with client delegation | best | none | low |
| Pipecat / LiveKit pipeline | tunable | tunable | high |

The GPT-Live shape is worth understanding even if you don't use it: a fast full-duplex conversational model handles turn-taking and delegates reasoning to a separate backend, so the user can keep talking while backend work runs. That is exactly Wilco's split, and it's why the voice layer must never block on the orchestrator.

---

## 6. Event log

`~/.wilco/events.jsonl`, append-only, plus a Unix socket for pub/sub.

```json
{"ts":"2026-09-11T09:31:02Z","task":"checkout/stripe-v15","type":"permission_request",
 "urgency":"blocking","tool":"bash","detail":"npm i stripe@15","run":"r_4f21"}
```

Every event carries `urgency` ∈ `{blocking, notable, routine, trace}` and the attention policy decides which surfaces render it. The log is also the journal: "what was I doing last Tuesday" is a query against this file, not a memory.

---

## 7. Attention policy

Agents generate three orders of magnitude more events than a human can absorb through voice. The policy is a first-class config object, not a notification setting.

```yaml
attention:
  voice:
    speak:   [blocked, review, failed]
    earcon:  [state_change, approval_granted]
    silent:  [output, tool_call, commit, test_pass]
    budget:  6/hour            # hard cap; excess is batched into the next brief
    quiet:   "22:00-08:00"
    style:   terse             # terse | normal | verbose
  tui:
    speak:   []
    show:    [all]
  watch:
    speak:   [blocked]
```

**Earcons carry state, speech carries content.** Three distinct non-speech tones for *blocked*, *finished*, *failed*. You learn them in a day and then you can track four agents while walking without hearing a single sentence. This is the single highest-leverage detail in the voice design.

**Batching.** When the budget is hit, events queue and collapse. "Three things happened while you were on that call. Search finished, Checkout is blocked, and the migration task failed twice." Never a queue of six announcements played back-to-back.

---

## 8. Voice interaction model

### 8.1 Intent grammar

A small closed vocabulary the voice layer resolves *before* hitting the orchestrator. Deterministic, fast, no LLM round-trip.

| Utterance shape | Action |
|---|---|
| "where are we" / "status" / "what about `<project>`" | `status(scope)` |
| "show me `<task>`" / "pull up `<project>`" | `focus(task)` |
| "tell `<task>` `<message>`" / "`<task>`, `<message>`" | `steer(task, msg)` |
| "yes" / "go ahead" / "approve" | `approve(pending)` — soft tier only |
| "start `<intent>` in `<project>`" | `spawn(project, intent)` |
| "park `<task>`" / "pick `<task>` back up" | `park` / `resume` |
| "remember `<preference>`" | `remember(pref, scope)` |
| anything else | free text → orchestrator |

Everything unmatched falls through. The grammar is an accelerator, not a cage.

### 8.2 Approvals: two tiers

**Soft** — a single spoken word suffices. Dependency choices, which approach to take, whether to open a PR.

**Hard** — Wilco reads back the exact command and requires a distinct confirmation phrase, never a bare yes.

> "Checkout wants to run `git push --force origin main`. Say *confirm force push* if that's right."

Hard tier covers: force push, history rewrite, `rm -rf` outside a worktree, credential or `.env` access, outbound network to a new host, database migrations, and any spend over threshold.

Three hard rules:
1. No approval is ever granted by an utterance that didn't follow a wake word or open mic session. Ambient speech cannot approve anything.
2. Auto-approve exists only as a per-project, per-tool allowlist. There is no global yolo flag.
3. A denied hard-tier request is logged with your exact words and cannot be re-requested within the same run without new information.

---

## 9. Memory

Three stores with three different lifetimes. Conflating them is how memory systems rot.

| Store | Lifetime | Written by | Read at | Format |
|---|---|---|---|---|
| **Preferences** | durable until changed | you, by voice or by editing | prompt composition | YAML, git-tracked |
| **Journal** | append-only, forever | the system + `intent_spoken` | status queries | JSONL |
| **Skills** | promoted, decaying | reflector, gated by you | task start | Markdown + optional script |

Scopes: `global` → `project` → `task`. Narrowest wins. Every preference records who set it and when, so "why does it keep doing that" is answerable.

```yaml
# ~/.wilco/preferences.yaml
global:
  - id: pin-majors
    text: "Pin major versions in package.json; never use ^ on majors."
    set: 2026-09-11 by voice
  - id: brief-style
    text: "Spoken updates under 15 seconds unless I ask for detail."
projects:
  checkout:
    - id: no-force
      text: "Never force push on this repo, even to feature branches."
```

### 9.1 Promotion loop

```
task completes
   └─▶ reflector proposes lessons ──▶ skills/proposed/
                                          │
                    surfaced in morning brief, one at a time
                                          │
                              approved ──▶ skills/active/
                              declined ──▶ skills/rejected/  (never re-proposed)
                     unused 30 days ──────▶ skills/archive/
```

Decay matters as much as promotion. A skill library that only grows becomes context bloat, and context bloat is indistinguishable from having no skills at all. The pattern to copy here is Kiro Crew's decaying memory that hardens into reusable skills, and Hermes' automated skill creation.

Proposals are surfaced *conversationally*, at most one per brief:

> "One thing from yesterday. Every time a task touched the payments module you made me run the integration suite before opening a PR. Want that as a rule for the checkout project?"

---

## 10. Self-extension

The orchestrator's tools live in `~/.wilco/extensions/` as TypeScript modules. Pi's model is the right one to copy: a minimal tool core that self-extends at runtime through extensions, skills, prompt templates and packages.

**Safety rails, all four required:**

1. `extensions/` is a git repo. Every change is a commit with the task that produced it.
2. `wilco --safe` boots with zero extensions loaded. This is the recovery path and it is tested in CI.
3. Written extensions land in `extensions/proposed/` and require explicit approval to activate.
4. **No hot reload.** Activating an extension requires a daemon restart. Workers keep running across it because the daemon owns their PTYs and reattaches.

**Wilco's own repo is just another Project.** "Improve yourself" is a normal task: a worktree, a branch, a test suite, a PR, a review. There is no special self-modification path, which means there is no special self-modification failure mode.

One inherited risk to be deliberate about: Pi has no built-in permission system and runs with the permissions of the user and process that launched it. Their docs describe containerization patterns including a Gondolin extension that keeps Pi and provider auth on the host while routing built-in tools and `!` commands into a local micro-VM. The split that works here is **orchestrator on the host** (it needs to drive your terminal) and **workers sandboxed**.

---

## 11. What it feels like

### Morning

You put in one earbud while the kettle boils.

> **F:** Morning. Two projects have work. Checkout is blocked — it wants to bump Stripe to v15. Search finished the pagination task and there's a PR up. Nothing else running.
>
> **You:** What's the Stripe thing about?
>
> **F:** It's on the webhook signature failure you described yesterday. It found the v14 signature helper doesn't handle the new header format and wants to upgrade rather than patch around it.
>
> **You:** Do it. And remember we pin majors.
>
> **F:** Approved. Saving "pin major versions" — global or just checkout?
>
> **You:** Global.
>
> *(soft chime)*

Elapsed: forty seconds. Two decisions made, one preference captured, no screen.

### Mid-morning, at the desk

You're reading something else. A short descending tone plays. That's *blocked*.

> **You:** What.
>
> **F:** Search wants to delete the old pagination tests.
>
> **You:** Show me.

Your Ghostty window raises a tab titled `search · pagination · agent`, scrolled to the request. You read it, type `n`, and explain in the terminal why. The voice layer says nothing — you're clearly at the keyboard. It goes back to earcons only.

That switch is automatic: **a surface that detects recent keyboard input in a focused lane drops itself to earcon-only** until you're idle again. Voice that keeps narrating while you're reading the screen is the fastest way to get a feature turned off.

### Afternoon, walking

> **You:** Hey Wilco, where are we.
>
> **F:** Three things. Stripe is in review, tests green. The migration task failed twice on the same constraint error. Search is still working, about twenty minutes in.
>
> **You:** Park the migration, I'll look tonight.
>
> **F:** Parked.
>
> **You:** And start something in checkout — the refund flow double-charges when the webhook retries, I think it's not idempotent.
>
> **F:** Starting. Claude Code, new worktree off main. I'll tell you when it has a plan.

That last utterance is stored verbatim as `intent_spoken`. Tonight, "what was the refund thing about" returns your own words, not a reconstruction from a diff.

### Screen behaviour

`focus` is one verb with driver-specific rendering:

| Driver | "Show me checkout" does |
|---|---|
| ghostty (macOS) | AppleScript raises the matching tab, or creates one running `wilco attach` |
| kitty / wezterm | remote-control focus by tab title |
| tmux | `select-window -t wilco/checkout/...` |
| pty | prints the attach command, or opens a new host terminal window running it |

Plus an optional dashboard surface at `localhost:7171` for when you want everything at once. It's a subscriber like any other, with no privileged access.

---

## 12. Configuration

```yaml
# ~/.wilco/config.yaml
workspace:
  driver: pty              # pty | tmux | ghostty | kitty | wezterm | zellij
  fallback: pty
  adopt: true              # discover sessions started outside Wilco

orchestrator:
  harness: pi              # the self-extensible core
  model: anthropic/claude-opus-5
  extensions: ~/.wilco/extensions

workers:
  default: claude-code
  protocol: acp
  sandbox: bwrap           # none | bwrap | seatbelt | container
  available: [claude-code, codex, pi, opencode]

surfaces:
  voice:
    backend: qwen-audio-agent
    wake: "hey wilco"
    tts: kokoro-local
  tui:  { enabled: true }
  web:  { enabled: true, port: 7171 }

projects:
  checkout:
    root: ~/src/checkout
    brief: "Payments service. Stripe, Postgres, Node."
    worker: claude-code
    max_parallel: 2
  search:
    root: ~/src/search
    worker: codex
    max_parallel: 3
```

---

## 13. Build order

Each phase is independently useful. If you stop after phase 2 you still have something better than what exists.

**Phase 1 — `wilco status` (2–3 days, no AI).**
The `pty` driver, the object model, the four status probes, `--json` output. Test it by running agents by hand and checking the output is true. If status is wrong here, everything built on top amplifies the error.

**Phase 2 — the daemon and the event log (1 week).**
PTY ownership, attach/detach, the socket, the state machine, adoption. Now you have a working session manager with no agent in it.

**Phase 3 — the orchestrator (1 week).**
Pi with extensions wrapping phase 1 and 2 as tools. Drive it by text. Get "where are we" answering correctly and tersely before adding any other modality.

**Phase 4 — voice (2 days).**
Expose Wilco as an ACP server, point qwen-audio-agent at it. The attention policy and earcons. This phase is short precisely because of the ACP decision.

**Phase 5 — memory and approvals (1 week).**
Preferences, `intent_spoken` capture, the two approval tiers, the morning brief.

**Phase 6 — drivers and self-extension (ongoing).**
Ghostty and kitty drivers. The promotion loop. The proposed-extensions flow.

---

## 14. Failure modes

| Failure | Mitigation |
|---|---|
| Agent reports success on broken work | Never trust self-report. `review` requires green tests + a clean diff, both externally verified. |
| Orchestrator's context rots, status drifts | Status is always a fresh query. The orchestrator holds no state worth rotting. |
| Voice mishears a destructive command | Hard-tier readback with a distinct confirm phrase. Never a bare yes. |
| Agent loops on the same error | Failure counter per run; three identical failures forces `failed` and speaks. |
| Runaway spend | Per-project budget in the policy engine, checked before every run, spoken warning at 80%. |
| Self-written extension bricks the daemon | `--safe` boot, git history, no hot reload. |
| Sessions started outside Wilco go invisible | Adoption scan of provider transcripts, every status query. |
| Notification fatigue kills the whole thing | Hard hourly budget, earcons over speech, auto-mute when you're at the keyboard. |
| Nested tabs make the terminal unusable | `pty` default. tmux strictly opt-in. |

---

## 15. Open questions

- **Multi-machine.** The design is single-workspace. A laptop plus a desktop plus a server is a real case and the event log would need to merge. Deliberately out of scope for v1.
- **Adoption reliability.** Reading providers' transcript formats is inherently brittle across their version bumps. Worth watching whether ACP grows a session-discovery method.
- **Who arbitrates parallel edits.** Two tasks in two worktrees touching the same file is a merge problem Wilco currently punts to you. There may be a cheap pre-flight check worth adding.
- **Earcon vocabulary.** Three tones is a guess. Might be two, might be five. Needs actual use to settle.
- **Whether the orchestrator should code at all.** Current design says no — it delegates everything. That's cleaner but adds a hop for trivial edits. Worth revisiting after a month of use.

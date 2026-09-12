# Wilco

> **wilco** *(radio procedure)*: "will comply."

A voice-first workbench for running coding agents on your own machine. A local daemon owns your
agent sessions; you talk to one orchestrator that knows what projects exist, what's running, what's
stuck, and what you said you were trying to do. Status is always derived from observable state
(git, process liveness, agent event streams, provider transcripts), never from what an agent says
about itself.

## Status

Early prototype. What works today:

| Feature | State |
|---|---|
| `wilco config --check` validates `~/.wilco/config.yaml` | ✅ |
| Object model and task state machine | ✅ |
| `wilco status`: git probe, adoption of Claude Code / Codex sessions started outside Wilco | ✅ |
| Daemon (`wilcod`), lanes, `attach`, event log | ✅ |
| Agents: pi runs supervised by the daemon, every tool call classified | ✅ |
| Task worktrees: created with your intent recorded, teardown that refuses to destroy work | ✅ |
| Approval policy, off by default (`approvals.mode`) | ✅ |
| CLI for tasks, runs and approvals | ✅ |
| Orchestrator tools: an agent can drive Wilco itself | ✅ |
| `wilco chat` | ✅ |
| Voice: attention policy, intent grammar, earcons and speech, summaries | ✅ |
| `wilco app`: one window over every project, with the orchestrator always on screen | ✅ |
| Memory: what you tell it, kept verbatim and scoped to what it is about | ✅ |
| Speech-to-text, self-extension | not started |

## Requirements

- Node **≥ 22.19** (Wilco runs TypeScript directly via Node's type stripping; there is no build step)
- pnpm 10
- git; optionally `gh` for PR state

## Quick start

```sh
pnpm install
pnpm wilco --help
pnpm wilco config --check        # validates ~/.wilco/config.yaml (missing file = defaults)
```

`WILCO_HOME` overrides the state directory (default `~/.wilco`).

## Try it

Everything up to starting an agent works with no credentials at all:

```sh
pnpm install
pnpm wilco daemon start

# point Wilco at a repository (~/.wilco/config.yaml)
printf 'projects:\n  app:\n    root: ~/src/app\n' >> ~/.wilco/config.yaml

pnpm wilco task create app/refunds --intent "the refund flow double-charges on webhook retries"
pnpm wilco status                 # app/refunds — queued
pnpm wilco run start app/refunds  # needs a model; see below
pnpm wilco status                 # app/refunds — working
pnpm wilco run list
pnpm wilco logs -n 10 --min-urgency notable
pnpm wilco task remove app/refunds
pnpm wilco daemon stop
```

**An agent needs a model, and pi owns that.** Wilco holds no credentials of its own. Log the
bundled pi in once, or give it an API key:

```sh
pnpm --filter @wilco/harness-pi exec pi   # then /login, and pick your provider
# or: export ANTHROPIC_API_KEY=...  (also OpenAI, OpenRouter, Ollama, ...)
```

Then name the model in a route (see Configuration) and `wilco run start` and `wilco chat` have
something to think with.

## Commands

| Command | Description |
|---|---|
| `wilco status [--json] [--no-pr]` | Every task and its state, derived fresh from git, running processes and provider transcripts |
| `wilco config` | Print the effective config (file merged with defaults) as JSON |
| `wilco config --check [-c path]` | Validate the config; on error, prints each bad key and exits `2` |
| `wilco app` | The window: every project, the agent you're watching, and the orchestrator |
| `wilco chat` | Talk to Wilco: it can answer about state and drive tasks, runs and approvals |
| `wilco summary <task> [--json]` | What an agent has been doing, read off the journal |
| `wilco remember <text> [--about <scope>]` | Write something down, exactly as you said it |
| `wilco notes [scope] [--json]` | What you have told Wilco, newest first |
| `wilco task create <project>/<name> --intent "..."` | Create a task: branch, worktree, your intent recorded verbatim |
| `wilco task remove <task> [--force]` | Remove a task worktree; refuses to destroy unmerged work |
| `wilco run start <task> [--prompt ...] [--model ...]` | Start a supervised agent in the task worktree |
| `wilco run list` / `steer <run> <msg>` / `stop <run>` | List agents, tell one something, stop one |
| `wilco approvals` / `approve <run> <id>` / `deny <run> <id>` | Commands agents are waiting to run (empty unless approvals are on) |
| `wilco daemon start [--foreground]` | Start `wilcod`, which owns lanes and the event log |
| `wilco daemon stop` / `status [--json]` | Stop the daemon / show pid, driver, capabilities, lane count |
| `wilco spawn <lane> --cmd <command...>` | Start a process in a new lane |
| `wilco lanes [--task t] [--json]` | List lanes with state and uptime |
| `wilco attach <lane>` | Attach your terminal to a lane (detach with Ctrl-\ twice) |
| `wilco kill <lane>` | Stop a lane |
| `wilco logs [-f] [--task t] [--type ...] [-n N]` | Read or follow the event log |

Exit codes: `0` ok, `1` runtime error, `2` invalid input or config.

### `wilco status`

```
$ wilco status
checkout
  stripe-v15  blocked  wants approval: bash: npm i stripe@15
  refunds     review   2 commits ahead, tests unverified
  + 1 session: claude-code running outside Wilco
elsewhere: 1 session: codex idle (~/src/search)
```

- **Projects** come from `projects:` in the config. With none configured, the git repo you're
  standing in is the project.
- **Tasks** are worktrees on a `wilco/*` branch that contain `.wilco/task.yaml`.
- **Adoption**: Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) transcripts
  modified in the last 24h are read and matched to tasks by working directory. Sessions in a
  project but outside any task show as `+ N sessions … outside Wilco`; active sessions outside
  every project show as `elsewhere`. A running `claude`/`codex` process in the same directory
  proves a session is alive even if its transcript has gone quiet. Set `workspace.adopt: false`
  to turn this off.
- PR state comes from `gh pr view` when `gh` is installed. `--no-pr` (or `WILCO_NO_GH=1`)
  skips it, since it hits the network.
- `status` never fails on a broken repo or unreadable file. It reports what it can and lists the
  problems in `warnings` (`--json`).

### Lanes and the daemon

A **lane** is one PTY belonging to a task: `<project>/<task>/<lane>`. The daemon owns them, so
your terminal is only a viewer and nothing is nested or hijacked.

```sh
wilco daemon start
wilco spawn app/scratch/shell --cmd bash
wilco attach app/scratch/shell     # Ctrl-\ twice to detach
wilco lanes
wilco logs -f --min-urgency notable
```

- **Attach from as many terminals as you like.** Every attacher sees the same session, gets a
  rendered snapshot of what it missed, and resizing your window resizes the lane.
- **Lanes outlive clients, not the daemon** — with the default driver. They are the daemon's
  children, so restarting it kills them. Wilco then reports them as dead (never as alive) and keeps
  enough detail to relaunch: `wilco daemon start && wilco lanes` shows them exited, and `relaunch`
  restarts one.
- **Unless they live in tmux.** Set `workspace.driver: tmux` and lanes belong to a tmux server
  instead: stop the daemon, start it again, and the agents are still running, mid-task. Wilco runs
  its own tmux server (`tmux -L wilco`), so your own sessions are untouched, and it records the lane
  id on each window, so lanes are recovered exactly rather than guessed at. You can attach to one
  from any terminal, over SSH, with no Wilco running at all.
- **The event log** is `~/.wilco/events.jsonl`, append-only and the source of truth, with a
  rebuildable SQLite index beside it. Events carry an urgency (`blocking`, `notable`, `routine`,
  `trace`); slow subscribers lose `trace` events first and `blocking` events never.
- Lane output is not copied into the log. It lives in the lane's scrollback (`capture`), and the
  log records periodic byte counts, so a chatty agent can't bloat the journal.
- The socket is `$XDG_RUNTIME_DIR/wilco.sock` (else `~/.wilco/run/`), directory `0700`, socket
  `0600`: this user only, no TCP.

### The window

`wilco app` is one window over everything: your projects down the left, the agent you're currently
watching in the middle, and the orchestrator along the bottom, where it cannot be closed — it is how
you see what Wilco heard and what it did about it.

```
checkout          │ checkout · stripe-v15 · agent — waiting on you
▸● stripe-v15     │ ────────────────────────────────────────────────
 ○ refunds        │ $ npm i stripe@15
search            │ ⏵ wants approval: bash: npm i stripe@15
 ◆ pagination     │
──── orchestrator ───────────────────────────────────────────────────
❯ what's going on with checkout
  → status · checkout · "you asked about it by name"
  3 tasks, 1 working, 1 waiting on you.
 1 waiting  tab switch · ctrl+space talk · ? help
```

- **Tab** moves between agents; everything the window doesn't claim is typed straight into the agent
  you're watching, so its own keybindings keep working.
- **Ctrl+space** talks. Where the terminal reports key releases it is hold-to-talk; elsewhere it
  toggles. Space is never claimed, because you have to be able to type one.
- **Say something to Wilco without leaving the agent you're typing at.** Begin a line with `wilco ` —
  *"wilco park this"* — and it goes to Wilco instead of the shell in front of you. Only at the start
  of a line, so `echo wilco` is just a word; at most six characters are ever held back, they are
  flushed in order the moment they can't spell it, and what is held is shown while it waits.
- **A pane raises itself when an agent needs you** — but never while you're mid-sentence somewhere
  else: nothing takes the screen out from under you until you've been idle for 30 seconds.
- **Every exchange shows its reasoning** (`→ park · checkout/stripe-v15 · "you mentioned it last"`),
  so a wrong guess is obvious and can be corrected rather than silently obeyed.
- `a` and `d` answer an approval, and only while that pane is actually waiting on one.

Speech-to-text is not wired in yet: the dictation line is typed today, and a transcriber will fill
the same line later, through the same path.

### Agents and models

Wilco does not talk to model providers itself. It runs **pi** as the agent harness and supervises
it, which is what lets one mechanism cover every way you might want to pay for a model:

- **Subscriptions** (Claude Pro/Max, ChatGPT, Copilot, xAI, OpenRouter) via pi's own login
- **API keys** for 30+ providers, from environment or pi's credential store
- **Local models** — llama.cpp, Ollama, LM Studio, vLLM, or any OpenAI-compatible endpoint

Model and provider are chosen per run (and switchable mid-session), so the orchestrator, a cheap
background worker and a local model can each use something different.

**Approvals are off by default.** Agents run without being interrupted (`approvals.mode: bypass`).
Every tool call is still classified and recorded, so `wilco logs` can tell you that a force push or
a credential read happened, even though nothing asked you at the time. Switching to
`approvals.mode: policy` turns the gate on: routine work (reading, editing inside the task's own
worktree) still runs untouched, ordinary commands ask for a word, and a short list of genuinely
destructive ones — force push, history rewrite, `rm -rf` outside the worktree, credential access,
publishing, database migrations — require you to hear the exact command first.

Supervision works the same whether the agent is visible in a lane or headless: Wilco loads a small
extension into pi, which streams structured signals back over a per-run Unix socket
(`turn_started`, `tool_call`, `turn_done`, `idle`, context usage) and **holds every tool call until
Wilco answers**. That gate is why approvals can be trusted: the exact command is known before it
runs, rather than scraped off a terminal. If Wilco becomes unreachable mid-request the agent
refuses rather than proceeding unsupervised, and with no supervision socket set the extension is
inert, so running plain `pi` is unaffected.

### Voice

Voice is a surface, not the architecture: it subscribes to the same events as everything else and
has no privileged path. If it's unavailable, nothing is lost but convenience.

- **Earcons carry state, speech carries content.** Three generated tones — falling for *blocked*,
  rising for *review*, a flat double for *failed* — are learnable in a day, so several agents can be
  tracked through one earbud without hearing a sentence.
- **The attention policy decides what reaches you**: blocking events speak, notable ones chime, the
  rest stay silent. Speech is downgraded to a tone during quiet hours, while you're typing in that
  task's own lane, and once the hourly budget is spent. Nothing is dropped — held-back items come
  back as one sentence ("3 things happened. migration failed, search is review and …").
- **A small closed grammar** resolves what you said before any model is involved: *where are we*,
  *show me X*, *tell X …*, *start … in …*, *park X*, *pick X back up*, *yes* / *no*, *remember …*.
  Anything it doesn't recognise goes to the orchestrator as free text.
- **Ask about one agent and you get an account of it**, not a status word. *"What about refunds?"* →
  *"refunds is working: 12 tool calls and 3 turns, mostly bash and edit. It is waiting on bash: npm i
  stripe@15. Last moved 4m ago."* It is read off the journal and never asked of the agent, because an
  agent's own account of itself is the one thing Wilco doesn't trust. `wilco summary <task>` prints
  the same thing. Anything that ran which would normally have needed asking is named here, since with
  approvals off nothing interrupted you at the time.
- **A bare "yes" can never do something destructive.** Soft requests take one word; a force push or
  an `rm -rf` outside the worktree is read back and requires the distinct phrase
  (*confirm force push*). The grammar has a test asserting no ordinary sentence can reach one.

Speech and tones use what the OS already has (`say` + `afplay` on macOS, `spd-say` + `paplay` on
Linux), so there is nothing to install. **Speech-to-text is deliberately not built in**: the surface
takes text from any source, so dictation apps, a local transcriber, or simply typing all work
through the same path.

### What it remembers

Everything else Wilco tells you is derived from something it can observe. Notes are the exception:
things you said that no probe could ever recover, which is why they are kept **verbatim**, exactly
like `intent_spoken`.

```sh
wilco remember the staging key rotates on the 1st --about checkout
wilco notes checkout/refunds
```

Say *"remember …"* (or *"note that …"*, *"keep in mind …"*) and it is filed against whatever you were
just talking about — and it says which, *"Noted, about refunds"*, because filing something under the
wrong task silently is worse than being told so you can correct it.

A note about a project applies to every task in it and a note about nothing in particular applies
everywhere, but a note about one task never leaks to its siblings. They live in
`~/.wilco/memory.jsonl`, append-only like the journal; a line that can't be read is skipped rather
than costing you the rest of the file.

## Configuration

`~/.wilco/config.yaml`. Every key is optional and unknown keys are rejected.

```yaml
workspace:
  driver: pty              # pty | tmux | ghostty | kitty | wezterm | zellij
  adopt: true              # discover agent sessions started outside Wilco
approvals:
  mode: bypass             # bypass (default, never interrupts) | policy
  auto_allow: []           # tools that never ask when mode is policy
orchestrator:
  provider: anthropic      # omit to use whatever the harness is logged in to
  model: claude-opus-5
workers:
  default: cheap           # route used when a project names none
  routes:                  # each route is one way of running an agent
    cheap:        { provider: openrouter, model: deepseek/deepseek-v3 }
    subscription: { provider: anthropic, model: claude-opus-5 }
    local:        { provider: ollama, model: qwen2.5-coder, sandbox: seatbelt }
projects:
  checkout:
    root: ~/src/checkout
    brief: "Payments service. Stripe, Postgres, Node."
    worker: subscription   # names a route above
    max_parallel: 2
```

The schema lives in [packages/core/src/config.ts](packages/core/src/config.ts).

## Concepts

```
Workspace   one machine, one daemon
└ Project   a repo root + brief + preferences
  └ Task    an intent + branch + worktree   ← what you talk about
    └ Lane  one PTY: agent | server | tests | shell
      └ Run one agent session
```

A task is a git worktree on a `wilco/*` branch containing `.wilco/task.yaml`, which records your
original request verbatim as `intent_spoken`. Task states:

| State | Means |
|---|---|
| `blocked` | An agent is waiting on a human decision |
| `review` | Work finished (commits ahead, clean tree), needs your eyes |
| `failed` | Repeated failures, or the agent died leaving a mess |
| `working` | Actively progressing (flagged *stalled* after 30 min of silence) |
| `parked` | Deliberately set aside |
| `queued` | Not started |
| `merged` | Landed on the base branch |

## Development

```sh
pnpm check      # biome ci + tsc + vitest: the full gate, same as CI
pnpm test       # tests only
pnpm exec biome check --write .
```

`pnpm install` runs `scripts/fix-pty-permissions.mjs`, which restores the executable bit on
node-pty's `spawn-helper`. Package extraction drops it, and without it every lane fails to start
with `posix_spawnp failed`.

Contributor conventions (including the rules every port implementation must follow) are in
[AGENTS.md](AGENTS.md). Recipes for recurring changes are in [.claude/skills/](.claude/skills/).

## Layout

| Package | Role |
|---|---|
| `packages/core` | Config, object model, state machine, port interfaces |
| `packages/probes` | git · liveness · adoption probes feeding `status` |
| `packages/cli` | The `wilco` binary |
| `packages/daemon` | `wilcod`: JSON-RPC socket, lane registry, event log + index |
| `packages/driver-pty` | The default `WorkspaceDriver`: node-pty + a headless xterm per lane |
| `packages/driver-tmux` | Lanes that live in tmux, so they outlive the daemon |
| `packages/driver-conformance` | The shared suite every driver must pass |
| `packages/harness-pi` | Runs and supervises pi: adapter, supervision channel, the in-agent extension |
| `packages/worker-acp`, `orchestrator` | Reserved for a second worker adapter and the orchestrator (stubs) |

# Wilco

> **wilco** *(radio procedure)*: "will comply."

A voice-first control room for running coding agents on your own machine. The agents are pi, running
in your terminal; Wilco is the window over them and the orchestrator you talk to — one that knows
what projects exist, what's running, what's stuck, and what you said you were trying to do.

Nothing here is the source of truth for anything. tmux owns the processes, pi owns the
conversations, git owns the work, and status is always derived from what can be observed (git,
process liveness, agent event streams, provider transcripts) rather than from what an agent says
about itself. That is why closing Wilco is harmless: it was never holding anything the others
weren't already holding.

## Status

Early prototype. What works today:

| Feature | State |
|---|---|
| `wilco config --check` validates `~/.wilco/config.yaml` | ✅ |
| Object model and task state machine | ✅ |
| `wilco status`: git probe, adoption of Claude Code / Codex sessions started outside Wilco | ✅ |
| Lanes, `attach`, event log | ✅ |
| Agents: pi in a lane, one session per task, still there when you come back | ✅ |
| Task worktrees: created with your intent recorded, teardown that refuses to destroy work | ✅ |
| Approval policy, off by default (`approvals.mode`) | ✅ |
| CLI for tasks, runs and approvals | ✅ |
| Orchestrator tools: an agent can drive Wilco itself | ✅ |
| `wilco chat` | ✅ |
| Voice: attention policy, intent grammar, earcons and speech, summaries | ✅ |
| `wilco`: one window over every project, with the orchestrator always on screen | ✅ |
| Memory: what you tell it, kept verbatim and scoped to what it is about | ✅ |
| Speech-to-text: local whisper.cpp by default, or any OpenAI-compatible API | ✅ |
| Guided setup, the morning brief, verified tests, self-written tools | ✅ |
| Spend in tokens and dollars, with per-project daily budgets | ✅ |
| Skills: lessons Wilco proposes and you approve, and stop being said when their subject goes quiet | ✅ |

## Requirements

- Node **≥ 22.19** (Wilco runs TypeScript directly via Node's type stripping; there is no build step)
- pnpm 10
- git; optionally `gh` for PR state
- `tmux`, if you want agents to keep working after you close the window

## Install

```sh
git clone <this repo> wilco && cd wilco
pnpm install
```

That is the install: there is nothing to build. Run it from the checkout with `pnpm wilco`, or put
it on your `PATH` once:

```sh
cd packages/cli && pnpm link --global   # then: wilco, from anywhere
```

To remove it again, delete the shim — `rm $(which wilco)`. (`pnpm unlink --global` reports
"Nothing to unlink" here, because the shim it writes points straight at your checkout rather than
through the global store.)

Either way it runs from the checkout, so `git pull` is all there is to updating.

## Quick start

```sh
wilco
```

`wilco` with no arguments opens the window. On a machine that has never run it, it walks you through
a project, a model and somewhere to run agents before opening — it does not show you an empty window
and let you work out the rest.

Setup is a screen rather than a scroll of prompts: a checklist that ticks itself off as you answer,
and **anything it has to run — logging into a provider, `brew install` — runs inside that screen**.
Wilco keeps the keyboard throughout, which is what stops keystrokes going astray between two
programs both reading the terminal. `ctrl+]` leaves an embedded program.

`wilco setup` runs the same wizard on its own, and `wilco setup --check` reports what is missing
without changing anything:

```
  ✓ A project to work on
  · A model to think with — no provider is logged in and no API key is set
  · Somewhere to run agents — workspace.driver is tmux, which is not installed
  ○ Speech, if you want it — whisper.cpp is not installed (brew install whisper-cpp)
```

Speech is marked `○` because it is never required: without it, push-to-talk opens a line you type
into instead. `WILCO_HOME` overrides the state directory (default `~/.wilco`).

## How people use it

**The first five minutes.** `wilco` asks which repository, opens the harness so you can
`/login`, and opens the window. You say what you want done; a worktree and an
agent appear; you watch it work in the middle pane.

**Morning, one earbud, kettle boiling.** `wilco brief --speak` — *"Morning. stripe-v15 is blocked on
`npm i stripe@15` and pagination is done and wants your eyes, and 2 still working."* Hold ctrl+space:
*"park the migration, I'll look tonight."* Forty seconds, two decisions, no screen.

**At the desk.** The window is open. Tab moves between agents. A pane raises itself when one needs
you — but never while you are mid-sentence somewhere else. `a` approves what it is waiting on, `d`
refuses it, and refusing once means it stops asking for the rest of that run.

**Hands already on the keyboard.** You are typing at an agent's prompt and want Wilco, not the
shell: start the line with `wilco ` — *"wilco park this"*. At most six characters are ever held back
and you can see them while they wait.

**A question with no verb.** *"why is refunds slow"* is not in the grammar, so it goes to the
orchestrator, which can read the journal, the git state and your notes to answer it. It is told what
Wilco is, what it may and may not do, what your projects are, what you have told it — and the
posture this machine is in, so *"will that keep running if I close this?"* has a true answer rather
than a plausible one.

**Changing a setting.** *"wilco settings"* from inside the window, or `wilco config` from a
terminal: the same screen either way. Needing to close Wilco to change a Wilco setting is how people
end up with a second terminal open forever.

**Before you merge.** `wilco check demo/refunds` runs the project's own `test_command` and records
the result against the commit it ran on. `wilco status` then distinguishes "it stopped" from "it is
green" — and a pass from three commits ago is treated as no result at all.

**Teaching it something.** *"remember we pin major versions"* — filed against whatever you were just
discussing, and it says which. The narrowest note wins, so a rule about one task beats a general one.

**When it writes itself a tool.** It proposes; you read the file; `wilco extensions activate
<name>`; it loads next time Wilco starts. If one of them breaks everything, `wilco --safe` starts
with none of them. Everything Wilco writes for itself is a git repository, committed as `Wilco`
rather than as you, so *"when did this appear, and what did I agree to"* has an answer months
later.

**Closing the laptop lid on it.** With `workspace.driver: tmux`, lanes belong to a tmux server
rather than to Wilco, so you can close it, open it again, and the agents are still working — Wilco
finds the windows it left and walks back into them.

## Try it

Everything up to starting an agent works with no credentials at all:

```sh
pnpm install

# point Wilco at a repository (~/.wilco/config.yaml)
printf 'projects:\n  app:\n    root: ~/src/app\n' >> ~/.wilco/config.yaml

pnpm wilco task create app/refunds --intent "the refund flow double-charges on webhook retries"
pnpm wilco status                 # app/refunds — queued
pnpm wilco run start app/refunds  # needs a model; see below
pnpm wilco status                 # app/refunds — working
pnpm wilco run list               # a different process, and it is still working
pnpm wilco logs -n 10 --min-urgency notable
pnpm wilco run stop app/refunds
pnpm wilco task remove app/refunds
```

There is nothing to start and nothing to leave running. Each command opens the workbench, does its
work and closes it; questions (`status`, `logs`, `notes`, `summary`, `spend`) read the files and do
not open it at all, so they still answer with a window open.

**An agent needs a model, and pi owns that.** Wilco holds no credentials of its own. Log the
bundled pi in once, or give it an API key:

```sh
pnpm --filter @wilco/harnesses-pi exec pi   # then /login, and pick your provider
# or: export ANTHROPIC_API_KEY=...  (also OpenAI, OpenRouter, Ollama, ...)
```

Then name the model in a route (see Configuration) and `wilco run start` and `wilco chat` have
something to think with.

## Commands

| Command | Description |
|---|---|
| `wilco status [--json] [--no-pr]` | Every task and its state, derived fresh from git, running processes and provider transcripts |
| `wilco config` | See every setting, what it is now and what changing it does — and change it |
| `wilco config --json` / `--check` | Print the effective config as JSON / validate it, exiting `2` on a bad key |
| `wilco setup` / `setup --check` | Walk through what is missing; or just report it |
| `wilco` (no arguments) | The window: every project, the agent you're watching, and the orchestrator |
| `wilco brief [--speak]` | Everything that matters, in one paragraph |
| `wilco check <task>` | Run the project's `test_command` and record the result against its commit |
| `wilco extensions [activate\|reject <name>]` | Tools Wilco wrote for itself: review and decide |
| `wilco skills [activate\|reject <name>]` | Lessons Wilco wrote for itself: review and decide |
| `wilco spend [--days N] [--json]` | What the agents have cost, in tokens and dollars |
| `wilco --safe <command>` | Start with none of the self-written tools loaded |
| `wilco chat` | Talk to Wilco: it can answer about state and drive tasks, runs and approvals |
| `wilco voice` | Whether Wilco can hear you, and what would fix it |
| `wilco voice setup [--model base.en]` | Download a local speech model |
| `wilco summary <task> [--json]` | What an agent has been doing, read off the journal |
| `wilco remember <text> [--about <scope>]` | Write something down, exactly as you said it |
| `wilco notes [scope] [--json]` | What you have told Wilco, newest first |
| `wilco task create <project>/<name> --intent "..."` | Create a task: branch, worktree, your intent recorded verbatim |
| `wilco task remove <task> [--force]` | Remove a task worktree; refuses to destroy unmerged work |
| `wilco run start <task> [--prompt ...] [--model ...]` | Start pi in a lane in the task worktree |
| `wilco run list` / `steer <task> <msg>` / `stop <task>` | List agents, tell one something, stop one |
| `wilco approvals` / `approve <run> <id>` / `deny <run> <id>` | Commands agents are waiting to run (empty unless approvals are on) |
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

### Lanes

A **lane** is one terminal belonging to a task: `<project>/<task>/<lane>`. An agent is a lane with
pi in it — the same pi you would run yourself, driven by the same keystrokes you would type.

```sh
wilco spawn app/scratch/shell --cmd bash
wilco attach app/scratch/shell     # Ctrl-\ twice to detach
wilco lanes
wilco logs -f --min-urgency notable
```

- **Attach from as many terminals as you like** (under `tmux`). Every attacher sees the same
  session, gets a rendered snapshot of what it missed, and resizing your window resizes the lane.
- **With the default driver, lanes do not outlive Wilco.** They are its own children, so closing it
  closes them. Wilco then reports them as dead (never as alive) and keeps enough detail to put the
  work back: `wilco lanes` shows them exited, and `relaunch` restarts one. Nothing to install and
  nothing left running, which is the trade this driver makes.
- **Set `workspace.driver: tmux` and they do.** Lanes belong to a tmux server instead: close Wilco,
  open it again, and the agents are still running, mid-task. Wilco runs its own tmux server
  (`tmux -L wilco`), so your own sessions are untouched, and records the lane id on each window, so
  reopening walks back into the same windows rather than guessing at them. A lane another window
  opened is picked up the same way, and the journal says so (`lane_adopted`). You can attach to one
  from any terminal, over SSH, with no Wilco running at all.
- **A driver this machine cannot provide is not a dead end.** `workspace.fallback` says where lanes
  go instead, and it is never silent: the journal records what was asked for, why it could not be
  had, and — the part that matters — whether agents can still outlive the window. Set `fallback` to
  the same driver to refuse instead.
- **A lane is alive only if the driver hands it back.** A pid in the process table proves something
  is running, not that Wilco can still drive it, so reopening asks the driver and takes its answer.
- **The event log** is `~/.wilco/events.jsonl`, append-only and the source of truth, with a
  rebuildable SQLite index beside it. Events carry an urgency (`blocking`, `notable`, `routine`,
  `trace`); slow subscribers lose `trace` events first and `blocking` events never.
- Lane output is not copied into the log. It lives in the lane's scrollback (`capture`), and the
  log records periodic byte counts, so a chatty agent can't bloat the journal.
- **One window per `WILCO_HOME` at a time.** Opening the workbench claims the home with a lock file
  naming the pid, so a second one is refused with a message saying who has it rather than
  interleaving its writes with theirs. A lock whose process is gone is taken over, so a crash never
  locks you out. Questions never take the lock.
- Under `tmux`, each home gets its own session (`wilco-<hash of home>`) on Wilco's own server, so a
  test run, a second checkout and your real work can never adopt or kill each other's agents.

### The window

`wilco` with no arguments is one window over everything. Your projects are tabs along the top; the
agents in the one you're in are down the side, with what has changed since it branched, its files,
your notes, and the repository, branch and worktree under them; the agent you're watching fills the middle, drawn in its own colours; and the orchestrator runs
along the bottom, where it cannot be closed — it is how you see what Wilco heard and what it did
about it. What needs you and the key you talk with are top right; what today has cost is bottom
right.

This is an 80×24 terminal, exactly as drawn — it is one of the screens the tests keep:

```
 WILCO  ▐ checkout ▌  search    infra   ▐  +  ▌    ● 1  ▐ ctrl ▌+▐ space ▌ talk 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ▾ AGENTS  2      ▐  +  ▌ │ checkout › stripe-v15  ▐ agent ▌  shell   ▐ + ▌     
▌● stripe-v15     $1.26 ≡ │─────────────────────────────────────────────────────
 ○ refunds        $0.62   │                                                     
                          │  ● Upgrading stripe to v15. The webhook signature AP
 ▾ CHANGES  3     vs main │    so src/webhooks.ts needs the new constructEvent s
  M package.json    +2 −1 │                                                     
  A …ebhooks.test.ts  +48 │  ▸ Read src/webhooks.ts                             
  M …/webhooks.ts  +12 −4 │  ╭─ wants approval ──────────────────────────────╮  
                          │  │ bash  npm i stripe@15                         │  
 ▾ FILES                  │  │ ▐ Allow once ▌ ▐ Deny ▌                       │  
   ▾ src/                 │  ╰───────────────────────────────────────────────╯  
       webhooks.test.ts   │                                                     
━ orchestrator ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
 ›                                             type, or hold ▐ ctrl ▌+▐ space ▌ 
────────────────────────────────────────────────────────────────────────────────
 ▐ + New agent ▌ ▐ Open project ▌ ▐ Settings ▌    claude-opus-5 │ $2.66 today ▾ 
```

**A click does the thing.** Everything in the window is clickable, and nothing types a half-written
command for you to finish. Buttons light up under the pointer and look pressed while held; where the
terminal lets a program choose the pointer (kitty, foot, xterm, WezTerm, Ghostty) you get a hand over
what can be pressed. Every target is something you could also have typed, and the map of what is
where comes out of the same pass that drew the rows, so nothing is clickable anywhere it is not drawn.
Colour is xterm's 256, which Terminal.app shows; `NO_COLOR`, a dumb terminal or a pipe get the same
layout unpainted — `▐ label ▌` in colour, `[ label ]` without, the same width either way.

- **Tabs.** A project tab goes to that project. The `+` button after them opens a project in a
  folder browser that starts in your home folder: back, forward and up buttons, the path as parts you
  can click back to, the folders here with which are git repositories and on what branch, and the
  projects you used lately beside them. Click a folder to choose it and again to go in (`→` into,
  `←` up); type to narrow, or type a path to go there. A folder that is not a git repository opens
  too — Wilco offers `git init` and commits what is there as the first commit, as Wilco — and the tab
  appears at once.
- **Agents.** Each agent works on its own `wilco/*` branch in its own worktree. **+ New agent**, or
  the `+` beside AGENTS, makes one in the project you are in and opens pi in it straight away — no
  questions; it is called `agent-1`, `agent-2`, … and you tell it what to do in its own prompt.
  Clicking an agent opens it: if it is running you see it; if not, pi opens in its worktree on its
  own session, picking up where it stopped. Opening a session sends nothing to the model, so a click
  costs nothing until you type. The agent's terminal is sized to the pane and the terminal window is
  titled with it. `≡` on the agent you are on, or a right-click on any, is its menu: open, start or
  stop it, show its changes, open it in your editor, copy its branch, park it, or remove it — which
  asks first and lists exactly what is unmerged.
- **Git.** At the bottom of the sidebar: the project's repository and the branch it is on, or — for the agent
  in front of you — its branch, the branch it started from, and its worktree.
- **The pane.** Tabs along its top: the agent, any shell opened beside it with `+`, each drawn and
  typed into on its own. On the right, the model the agent says it runs on and a context meter that
  turns amber, then red, as it fills. An approval appears where the agent asked, with **Allow once**
  and **Deny** (`a` and `d` too, only while one waits).
- **Changes and files.** A changed file opens its diff from where the agent branched, read-only,
  `←`/`→` through the others. FILES is the agent's worktree, or the project itself when no agent is
  in front of you, as a tree: the row under the pointer is shaded, and a click opens a folder or
  the file. The sidebar scrolls with the wheel. A file
  under FILES, a link on an agent's screen, or a reference like
  `src/webhooks.ts:42:7` in its output opens in your editor at that line — the one you set, else the
  one whose terminal Wilco runs in (VS Code, Cursor, Windsurf, Zed, JetBrains, Neovim, Emacs), else
  `$VISUAL`/`$EDITOR`, else the system's. A terminal editor opens inside Wilco's screen rather than
  fighting it for the keyboard.
- **Notes.** What you told Wilco to remember (`remember the staging key rotates on the 1st`), kept
  word for word in `~/.wilco/memory.jsonl`, for the project you are in. The orchestrator reads them
  when it starts, and `wilco notes` lists them.
- **Money.** The status bar is the model, the provider it goes through and how that is paid for
  (`signed in`, `API key`, or `env API key`), then today's tokens and dollars; a narrow terminal keeps
  the dollars. Click it for the orchestrator and
  every agent, for today, this window or seven days, by agent, project or model, and each project
  against its daily budget.
- **Talking.** The key is yours — `ctrl+space` unless you choose another — and always on screen as
  key caps. While the microphone is open the corner and the strip turn red with a clock, and the strip
  shows a meter of what the microphone actually hears. Hold where the terminal reports key releases,
  press to start and stop elsewhere or if you prefer. With nothing to hear you, the chip says voice is
  off and offers setup. Space is never claimed; nor is any key that types a character.
- **Go to anything.** `ctrl+g` finds any agent (what needs you first), waiting approval, agent to stop,
  change to look at, project, action or setting by name. The Keys sheet is in there too.
- **Somewhere else needs you.** An agent in a project you are not looking at that wants approval gets
  a toast under the tabs, answerable where it appears. A pane you are looking at raises itself only
  when you have been idle for 30 seconds.
- **Closing.** `ctrl+c` closes Wilco. Under `pty`, where closing would stop your agents, it asks
  first and says so; under tmux they carry on and it just closes.
- **Tab** moves between agents *and the orchestrator*, where you type to Wilco. `/` lists what Wilco
  can do; `/new fix the double charge on refunds` starts an agent on it in one line. Begin a line at an agent
  with `wilco ` and it goes to Wilco instead. Everything the window doesn't claim goes to the agent,
  so its own keybindings keep working.
- **Every exchange shows its reasoning** (`→ park · checkout/stripe-v15 · "you mentioned it last"`),
  so a wrong guess is obvious and can be corrected rather than silently obeyed.
- **It opens where you left it**: the pane you were watching is remembered in `~/.wilco/window.json`.

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

**`approvals.rules` is for the things only you know are dangerous here** — `terraform apply`, a
deploy script, a migration runner. They can only make Wilco stricter: there is no `auto` to write,
and where one disagrees with a built-in the stricter wins. Loosening is `auto_allow`, which names
exact tools and is a deliberate thing to type.

**Workers can be contained; the orchestrator cannot.** Set `sandbox` on a route and workers on it
run under `sandbox-exec` (macOS) or `bwrap` (Linux) with exactly one writable place: the task's own
worktree, plus temp directories and build caches. Your other repositories, your dotfiles, your keys
and Wilco's own state are read-only to it.

```yaml
workers:
  routes:
    cheap: { provider: openrouter, model: deepseek/deepseek-v3, sandbox: seatbelt }
```

This is doing real work rather than defence in depth: the harness runs with the permissions of
whatever launched it and has no permission system of its own. Two honest limits — it restricts
*writes*, not reads, because a toolchain that cannot read `~/.npmrc` does not work (credential reads
are a job for the approval tiers); and asking for a sandbox the machine cannot provide fails the run
rather than quietly starting an agent unconfined. The orchestrator is never sandboxed: it has to be
able to drive your terminal.

**An agent is pi in a lane**, in the task's worktree, talking in a session named after the task.
That name never changes, so starting an agent and coming back to one are the same command: pi
creates the session the first time and continues it every time after. The sessions stay where pi
puts them, which means you can `cd` into the worktree, run `pi` yourself, and be in the same
conversation Wilco was having.

Wilco loads a small extension into pi, which streams structured signals back over a per-run Unix
socket (`turn_started`, `tool_call`, `turn_done`, `idle`, context usage). What it does when Wilco is
not reachable depends on the mode it was launched in, because under `tmux` an agent outliving the
window is ordinary rather than a fault:

- **`bypass` (the default) never holds anything.** Losing Wilco costs the journal an entry and never
  the work. Nothing is lost for good: pi records every priced message in its own session, so opening
  Wilco again reads what was spent while nobody was watching and catches the journal up.
- **`policy` holds every tool call until Wilco answers**, and refuses when it cannot ask. That gate
  is why approvals can be trusted: the exact command is known before it runs, rather than scraped off
  a terminal. Quietly falling back to ungated would be the one outcome nobody asked for.

With no supervision socket set the extension is inert, so running plain `pi` is unaffected.

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
Linux), so there is nothing to install.

### Talking to it

Hold **ctrl+space** in the window, say something, let go. What you said is transcribed, resolved
against the same grammar that typing uses, and shown in the orchestrator strip with what it decided
and why.

```sh
brew install whisper-cpp ffmpeg
wilco voice setup          # downloads a local model (base.en, 142 MB)
wilco voice                # says whether it can hear you, and what is missing if not
```

Speech is two swappable pieces, like everything else here — something that captures a microphone and
something that turns audio into words:

| Engine | `stt.driver` | Where it runs | Needs |
|---|---|---|---|
| **whisper.cpp** *(default)* | `whisper-cpp` | this machine | `brew install whisper-cpp` + a model |
| OpenAI | `openai` | their servers | `OPENAI_API_KEY` |
| Groq | `groq` | their servers | `GROQ_API_KEY`, fastest of the three |
| scripted | `scripted` | nowhere | for tests |

**Local is the default on purpose.** What you say to your own machine about your own code should not
have to leave it, and a voice feature that demands an API key before it works would contradict the
rest of the tool. The cloud engines exist because they are faster and need no 142 MB download; both
are one config key away.

```yaml
surfaces:
  voice:
    stt: { driver: whisper-cpp }        # or: { driver: groq, language: en }
    mic: { driver: ffmpeg, device: ":1" }   # `ffmpeg -f avfoundation -list_devices true -i ""`
    attention:
      budget: 6                            # spoken interruptions per hour
      quiet: "22:00-08:00"                 # omit for none
```

**What it is willing to interrupt you for** is mostly the engine's business — urgency, whether you
are mid-sentence somewhere else, whether the same thing has already been said — and two parts of it
are yours: how often it may speak in an hour, and when it may not speak at all. Beyond the budget
nothing is dropped; it waits and comes back as one sentence.

Task and project names are handed to the engine as expected vocabulary, because *"stripe-v15"* is
exactly the kind of word a general model mishears.

`wilco setup` asks which languages you speak before which model to download — the `.en` models are
smaller and better at English, the rest understand about a hundred languages — and offers the
engine first: local whisper, OpenAI, Groq, or a dictation app you already use. Downloads show a bar,
the rate and how much longer. `wilco voice setup --list` prints what is on offer and what each costs.

**If any of it is missing, nothing breaks.** `wilco voice` tells you what and how to fix it, and
ctrl+space falls back to a line you type into — which is also how a dictation app (Wispr Flow, macOS
dictation) works with Wilco today, with no integration at all. Wake words, and transcribing while
you are still talking, are not built: push-to-talk is deliberate, since a microphone that is always
listening in a room where you take calls is a different product.

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
everywhere, but a note about one task never leaks to its siblings. **The narrowest applies first**:
told one thing about a task and something else about the whole workspace, the one about the task is
what counts, however recently the other was said. Each note records where it came from and when, so
*"why does it keep doing that"* has an answer.

They live in `~/.wilco/memory.jsonl`, append-only like the journal; a line that can't be read is
skipped rather than costing you the rest of the file.

### What it has learned

A **skill** is a lesson Wilco wrote for itself — *"every time a task touched payments you made me
run the integration suite first"* — and the judgement about what was learned belongs to the thing
doing the work, so it proposes and you decide:

```sh
wilco skills                      # active, proposed, turned down
wilco skills activate payments-suite
```

**When a task lands, Wilco looks back at it** and writes a lesson down if there is one — that is the
only moment there is something to learn from, and a tool it may call whenever it likes is one it
calls to be helpful rather than when it has learned something. It is asked in a way that makes
declining the usual answer, because a lesson nobody needed costs context in every prompt after it.
Set `orchestrator.reflect: false` to propose lessons yourself instead.

The morning brief raises at most one waiting proposal, so something it wrote down is never something
you were never told about. A turned-down lesson is kept, so the same idea is not proposed twice.

**A lesson stops being said when its subject goes quiet.** Each one says what it is about, and one
about a project nobody has touched in a month is left out of the prompt — otherwise every lesson
ever approved competes for the same context, and having ten is indistinguishable from having none.
Nothing is moved or deleted: `wilco skills` lists what has gone quiet and why, and the day that
project moves again the lesson is back with nothing to do. A lesson about working here in general
never decays, because there is nothing that could have gone quiet.

## What it deliberately doesn't do

Each of these was considered and left out. They are written down so the next person does not have to
work out whether it was an oversight.

- **No ACP surface.** Wilco does not speak the Agent Client Protocol in either direction, so editors
  and chat bridges do not come free. One harness (pi) covers subscriptions, API keys and local
  models, and that turned out to be the part that mattered.
- **No web dashboard.** The window is the surface. A second one would need its own answer to every
  question about focus and attention, for the same information.
- **No wake word, and no transcription while you are still talking.** Push-to-talk is deliberate: a
  microphone that is always listening in a room where you take calls is a different product.
- **One window per `WILCO_HOME` at a time.** Two would interleave in one journal. Questions —
  `status`, `logs`, `notes`, `summary`, `spend` — never take the lock and always answer.
- **No `MemoryStore` or `Surface` port.** Notes are one append-only file and there is no second
  implementation to swap in; the CLI, the window and voice each need genuinely different things from
  Wilco. A port with one implementation behind it is indirection, not a seam.
- **No golden transcript of what a model chooses.** The tool surface and the composed prompt are
  golden-tested, but "given this request, which tool" needs a model that chooses — the scripted one
  is told. `WILCO_LIVE=1` is where that is checked instead.

## Configuration

**Settings is a panel over the window** (the **Settings** button, `ctrl+g`, or `wilco config` from a
shell): categories down the side, and every setting as a real control — key caps, radios, toggles,
steppers, time ranges, lists that open under their field — with a sentence on what changing it does.
Changes are written as you make them and used at once; a setting read only when Wilco starts says
*on restart*. The file stays yours: the document is edited, not reprinted, so your comments and key
order survive everything but the line you changed. **Accounts** lists the providers pi is signed in to
and signs in to another with pi's own sign-in, inside the window; **Voice** can try the microphone.

`~/.wilco/config.yaml`. Every key is optional and unknown keys are rejected. Editing it by hand is
still the same file.

```yaml
workspace:
  driver: pty              # pty | tmux
  fallback: pty            # where lanes go if `driver` is not on this machine
  adopt: true              # discover agent sessions started outside Wilco
approvals:
  mode: bypass             # bypass (default, never interrupts) | policy
  auto_allow: []           # tools that never ask when mode is policy
  rules:                   # your own; they can only ever tighten things
    - { match: 'terraform\s+apply', tier: hard, reason: changes production }
orchestrator:
  provider: anthropic      # omit to use whatever the harness is logged in to
  model: claude-opus-5
  reflect: true            # look back at a task when it lands, and note a lesson if there is one
workers:
  default: cheap           # route used when a project names none
  routes:                  # each route is one way of running an agent
    cheap:        { provider: openrouter, model: deepseek/deepseek-v3 }
    subscription: { provider: anthropic, model: claude-opus-5 }
    local:        { provider: ollama, model: qwen2.5-coder, sandbox: seatbelt }
surfaces:
  voice:
    talk: { key: ctrl+space, mode: hold }   # any key that does not type a character; hold | toggle
    speak: true            # say replies and news out loud; off keeps the sounds and the text
  window:
    editor: cursor         # code, cursor, windsurf, zed, idea, subl, nvim, vim, emacs, system
    sidebar_width: 30      # wishes: fitted to the terminal you actually have
    strip_height: 9
projects:
  checkout:
    root: ~/src/checkout
    brief: "Payments service. Stripe, Postgres, Node."
    worker: subscription   # names a route above
    max_parallel: 2
    budget: { usd_per_day: 5 }   # agents are warned at 80% and refused past it
```

The schema lives in [packages/core/src/config.ts](packages/core/src/config.ts).

## Concepts

```
Workspace   one machine, one WILCO_HOME
└ Project   a repo root + brief + preferences
  └ Task    an intent + branch + worktree   ← what you talk about
    └ Lane  one terminal: agent | server | tests | shell
      └ pi  one session, named after the task, for as long as the task lives
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

WILCO_LIVE=1 pnpm vitest run packages/orchestrator/test/live.test.ts
```

The suite runs offline against a scripted model, which is what keeps it fast
and credential-free — and means none of it can tell you whether a real model
can *choose* the right tool from the descriptions we wrote, since the fake one
is told what to call. `WILCO_LIVE=1` is the one test that can: it costs money,
needs credentials, and is meant for before a release rather than the inner
loop. `WILCO_LIVE_MODEL` picks the model.

**How the window looks is tested like anything else.** Named screens drawn from fixed data are kept as
golden plain text and exact ANSI under `packages/app/test/screens/__screens__/`, with checks that every
row fills the terminal and nothing is clickable where nothing is drawn; the app tests open the panels
through the whole window with real key and mouse sequences. `pnpm screens [out.html]` draws every
screen in colour — old and new side by side where they differ — for a person to look at before
accepting a change with `pnpm vitest run packages/app -u`.

`pnpm install` runs `scripts/fix-pty-permissions.mjs`, which restores the executable bit on
node-pty's `spawn-helper`. Package extraction drops it, and without it every lane fails to start
with `posix_spawnp failed`.

Contributor conventions (including the rules every port implementation must follow) are in
[AGENTS.md](AGENTS.md). Recipes for recurring changes are in [skills/](skills/) — at the repo root,
not under any one agent's directory, so whichever agent you are working with can read them.

## Layout

Anything swappable is a folder: `core` holds the port and the suite every implementation must pass,
and the siblings are the implementations. Adding a second one means importing the suite and fixing
what is red.

```
core/          the domain: tasks, state machine, config, policy, memory, prompts
status/        observing reality: git · processes · adoption · tests
workbench/     what Wilco holds while open: lanes, journal, notes, agents
drivers/       core (port + suite) · pty · tmux          where lanes physically live
harnesses/     core (port) · pi                          what runs an agent
voice/         core (surface + ports) · stt · tts        hearing and speaking
orchestrator/  the thing you talk to: its tools and its prompt
app/           the window
cli/           the wilco binary
```

`status/` is the one that needs a sentence: it is everything that *observes* the world — git,
running processes, provider transcripts, recorded test results — and assembles the answer to
`wilco status`. It never decides anything; `deriveState` in `core` does that, as a pure function of
what `status` observed.

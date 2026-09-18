```
 ████████╗  █████╗  ██████╗  ███████╗
 ╚══██╔══╝ ██╔══██╗ ██╔══██╗ ██╔════╝
    ██║    ███████║ ██║  ██║ █████╗
    ██║    ██╔══██║ ██║  ██║ ██╔══╝
    ██║    ██║  ██║ ██████╔╝ ███████╗
    ╚═╝    ╚═╝  ╚═╝ ╚═════╝  ╚══════╝
      ·  ·  ·   said, and done   ·  ·  ·
```

**Tade** — a **T**erminal **A**gentic **D**evelopment **E**nvironment: the agent orchestration IDE
for your terminal, and a voice-first control room for the coding agents on your own machine. Every agent is
[pi](https://github.com/earendil-works/pi), working in your project's checkout alongside the others
or in a git worktree of its own; Tade is the window over all of them and the orchestrator you talk
to — by voice or by typing.

Tade keeps no state of its own. tmux or the window owns the processes, pi owns the conversations,
git owns the work, and status is always read from them, so closing Tade loses nothing.

- **Agents together, or apart**: by default every agent works in the checkout on its branch at the
  same time; set `agents.workspace: worktree` for a worktree and branch each. `agents.commit` says
  when they commit, and `agents.instructions` is anything else every agent should be told.
- **An orchestrator you talk to**: hold `ctrl+space` or type. It starts, steers and stops agents,
  runs commands in terminals, and shows its work as it goes.
- **A smart queue**: ask for several changes at once and the orchestrator plans them — what can run
  together starts, and the rest waits in the SMART QUEUE and starts by itself when what it waits on
  has finished. Work can be put on a clock too, and extensions offer watches that start agents on
  what they find.
- **One window**: agents, files, changes, git, notes, terminals, search (`ctrl+k`), a file viewer.
- **Extensions**: dependencies and Sentry built in, with your own beside them.
- **The brief**: what is stopped, what is moving, and what extensions found — `tade brief`, or
  "brief me".
- **Spend and approvals**: tokens and dollars per agent and project, and a policy for risky
  commands, off unless you turn it on.

## Requirements

- Node ≥ 22.19 and pnpm 10 (Tade runs TypeScript directly; there is no build)
- git
- optional: tmux (agents that outlive the window), whisper.cpp and ffmpeg (speech), `gh` (PR state)

## Install

```sh
git clone <this repository> tade && cd tade
pnpm install
cd packages/cli && pnpm link --global    # puts `tade` on your PATH
```

## Use

```sh
tade              # the window; the first time, a short setup
tade brief        # everything that matters, in one paragraph
tade status       # every task, derived fresh
tade extensions   # what extensions are loaded, and what they need
tade --help       # everything else
```

In the window, `ctrl+k` finds anything, `tab` moves between agents and the orchestrator, `ctrl+1`…`9`
goes to an agent, `ctrl+n` starts one, `ctrl+t` opens a terminal and `ctrl+m` mutes; `F1` lists every
key, and each can be changed in Settings. Keys with shift, and ctrl with a number or `m`, need a
terminal with the Kitty keyboard protocol (Ghostty, kitty, WezTerm, iTerm2). Configuration lives in `~/.tade/config.yaml` and is edited
from **Settings**.

## Extensions

- **Dependencies** checks npm, pnpm catalogs, PyPI, crates.io and Go modules for what is behind,
  vulnerable or deprecated, and hands updates to an agent: *"verify and update all the
  dependencies in checkout"*. Its **Vulnerable dependencies** watch looks daily and starts an agent
  on each package with a known advisory.
- **Sentry** reads issues, traces, logs, spans and metrics, and starts agents on fixes with
  everything Sentry knows in their context: *"check Sentry for new errors and tell me what to fix"*.
  Its **New Sentry errors** watch looks every hour and starts an agent on each new issue — *"fix new
  Sentry errors as they come"*, or **Watch** it from Extensions. It uses your sentry-cli
  credentials; set the organization:

  ```yaml
  extensions:
    sentry:
      org: acme
      projects: { checkout: checkout-api }   # when a Sentry slug differs from the project name
  ```

- **Resources** keeps what Tade and everything it runs is using in the status bar; click it for the
  breakdown by project, kind, agent and process: *"how much memory is Tade using?"*

### Tade's own trouble

Tade can report itself to a Sentry project of yours, through Sentry's own SDK: crashes and the
warnings it writes down as issues, what happened around them as logs, and every agent turn as a
trace — `gen_ai` spans with the model, the tools it called and what it cost, which is what Sentry's
agent monitoring is drawn from. Nothing is sent until you say where, and what is sent is the shape
of what happened — never your code, what you said, or what an agent wrote.

```yaml
telemetry:
  dsn: https://…@…ingest.sentry.io/…   # a DSN, from that project's Client Keys; empty sends nothing
  environment: laptop                   # which Tade this is
  agents: true                          # time turns, tools and tokens (on)
  traces: 0.1                           # how much of Tade's own work is timed
```

`$TADE_TELEMETRY_DSN` does the same without putting it in a file, and **Settings › Reporting** has
the switches for errors, logs and metrics.

Point Tade's own repository and the watch at it, and it fixes itself:

```yaml
projects:
  tade: { root: ~/src/tade }
extensions:
  sentry:
    projects: { tade: your-tade-sentry-project }
```

Then *"watch tade for new errors"* — every hour, each new issue in Tade becomes an agent in the
Tade checkout with the stack trace in its context.

Turn them on and off, set them up and approve what Tade wrote for itself from **Extensions**. Your
own go in `~/.tade/extensions/active/<name>/extension.ts`.

## Development

```sh
pnpm check         # lint, types and tests: the full gate
pnpm tade         # run the CLI from source
```

[AGENTS.md](AGENTS.md) is the guide for anyone — or any agent — changing Tade, and
[.claude/skills](.claude/skills) holds recipes for the changes that recur.

## License

MIT — see [LICENSE](LICENSE). Tade builds on the work of many others; they are credited, with
their licences, in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

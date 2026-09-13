```
 ██╗    ██╗ ██╗ ██╗       ██████╗  ██████╗
 ██║    ██║ ██║ ██║      ██╔════╝ ██╔═══██╗
 ██║ █╗ ██║ ██║ ██║      ██║      ██║   ██║
 ██║███╗██║ ██║ ██║      ██║      ██║   ██║
 ╚███╔███╔╝ ██║ ███████╗ ╚██████╗ ╚██████╔╝
  ╚══╝╚══╝  ╚═╝ ╚══════╝  ╚═════╝  ╚═════╝
      ·  ·  ·   will comply   ·  ·  ·
```

A voice-first control room for the coding agents on your own machine. Every agent is
[pi](https://github.com/earendil-works/pi) in a git worktree of its own; Wilco is the window over
all of them and the orchestrator you talk to — by voice or by typing.

Wilco keeps no state of its own. tmux or the window owns the processes, pi owns the conversations,
git owns the work, and status is always read from them, so closing Wilco loses nothing.

- **Agents in worktrees**: each on its own branch, named when it first changes something.
- **An orchestrator you talk to**: hold `ctrl+space` or type. It starts, steers and stops agents,
  runs commands in terminals, and shows its work as it goes.
- **One window**: agents, files, changes, git, notes, terminals, search (`ctrl+k`), a file viewer.
- **Extensions**: dependencies and Sentry built in, with your own beside them.
- **The brief**: what is stopped, what is moving, and what extensions found — `wilco brief`, or
  "brief me".
- **Spend and approvals**: tokens and dollars per agent and project, and a policy for risky
  commands, off unless you turn it on.

## Requirements

- Node ≥ 22.19 and pnpm 10 (Wilco runs TypeScript directly; there is no build)
- git
- optional: tmux (agents that outlive the window), whisper.cpp and ffmpeg (speech), `gh` (PR state)

## Install

```sh
git clone <this repository> wilco && cd wilco
pnpm install
cd packages/cli && pnpm link --global    # puts `wilco` on your PATH
```

## Use

```sh
wilco              # the window; the first time, a short setup
wilco brief        # everything that matters, in one paragraph
wilco status       # every task, derived fresh
wilco extensions   # what extensions are loaded, and what they need
wilco --help       # everything else
```

In the window, `ctrl+k` finds anything, `tab` moves between agents and the orchestrator, and the
keys sheet in `ctrl+k` lists the rest. Configuration lives in `~/.wilco/config.yaml` and is edited
from **Settings**.

## Extensions

- **Dependencies** checks npm, pnpm catalogs, PyPI, crates.io and Go modules for what is behind,
  vulnerable or deprecated, and hands updates to an agent: *"verify and update all the
  dependencies in checkout"*.
- **Sentry** reads issues, traces, logs, spans and metrics, and starts agents on fixes with
  everything Sentry knows in their context: *"check Sentry for new errors and tell me what to fix"*.
  It uses your sentry-cli credentials; set the organization:

  ```yaml
  extensions:
    sentry:
      org: acme
      projects: { checkout: checkout-api }   # when a Sentry slug differs from the project name
  ```

Your own go in `~/.wilco/extensions/active/<name>/extension.ts`.

## Development

```sh
pnpm check         # lint, types and tests: the full gate
pnpm wilco         # run the CLI from source
```

[AGENTS.md](AGENTS.md) is the guide for anyone — or any agent — changing Wilco, and
[.claude/skills](.claude/skills) holds recipes for the changes that recur.

## License

MIT — see [LICENSE](LICENSE). Wilco builds on the work of many others; they are credited, with
their licences, in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

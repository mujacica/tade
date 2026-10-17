---
name: add-cli-command
description: Add or change a `tade` CLI subcommand (commander), including --json output, exit codes and tests. Use for any new user-facing command or flag.
---

# Adding a `tade` command

The CLI is `packages/cli`. `src/bin.ts` is the entry; `src/program.ts` builds the commander
program and exposes `run(argv, io)` which returns an exit code instead of calling `process.exit`.

## Conventions

- Exit codes come from `Exit` in `src/io.ts`: `ok` 0, `error` 1, `invalidInput` 2.
  Signal failure with `setExit(...)`, never `process.exit()` (it breaks tests and terminal restore).
- Write through `io.out` / `io.err`, never `console.log`, so tests can capture output.
- Commands that report state get a `--json` flag. JSON output is the stable contract: sorted
  deterministically, no timestamps other than explicit `generatedAt`-style fields.
- Human output is terse: under ~10 lines for a typical machine.
- Heavy logic lives in the owning package (`@tade/core`, `@tade/status`, `@tade/workbench`, ...). The command
  only parses flags, calls it, and formats.
- Commands never throw for expected failures; turn them into a message on stderr + exit code.
- **A command that writes outside Tade's home prints the file first.** `tade host service` puts
  the unit on standard output and everything else on standard error, so redirecting it is the
  file; it writes only on a press, or with `--write` for a script, and never asks where there is
  no terminal to answer.
- **A command that asks the world says what it asked and asks only when run.** `tade host domain`
  asks DNS servers and dials 443; its look takes every server and probe as an option, so a test
  hands a server on loopback and the binary is spawned only where it refuses before asking.
- **A command that mints a credential prints it once, and what it is every time.** `tade web pair
  --owner` puts the session on standard output — with `--json` that is the credential alone, for
  another program to keep — and `OWNER_IS_YOUR_SSH_KEY` on standard error, because whoever runs it
  is the one deciding. Only its digest is written down.
- **A command that keeps a credential another machine printed never prints it back.** `tade remote
  add` runs `tade web pair --owner --json` over SSH, writes the session into `remotes.<name>` and says
  `REMOTE_KEPT_HERE` and `OWNER_IS_YOUR_SSH_KEY` on standard error; `list`, `status` and `--json` name
  the device and never the session. Its status reads files only — the config and a fold of the
  journal's `remote_linked`/`remote_unlinked` (`linksSeen`) — because the links live in the window.
  Its test puts an `ssh` on PATH that runs the command in a shell, as ssh does on the far side; the
  real connection is `@tade/remotes-ssh`'s conformance suite.
- **A command that needs a person's press asks only where somebody can answer** (`ttyAsking` in
  `commands/remote-guide.ts`: standard input and error both terminals, and no `--json`). With nobody
  there it does nothing that needed the press and says what is left with the command that does it —
  `tade remote add` meets no host never met, sends no key and starts no sign-in from an agent's shell
  or a pipe. A press given ahead is a flag named for the act (`tade remote carry --keys --yes`, like
  `--write`), with the sentence still said on standard error, or one that names exactly what it
  accepts (`--accept-key <fingerprint>`, checked against what is offered and refused otherwise). Its
  guided steps take their `Asking` and `Place` as arguments, so a test drives them in-process
  against a scripted link and a real far end (`test/remote-carry.test.ts`).
- **Interactive commands must end at end of input.** `readline`'s `question()` never settles on EOF,
  so a loop built on it hangs on Ctrl-D or piped input, and whatever it started keeps running.
  Iterate the interface (`for await (const line of rl)`), which ends on both EOF and close, and stop
  what you started in a `finally`.

## Steps

1. Implement the logic in the right package with its own unit tests.
2. Write it in `packages/cli/src/commands/<name>.ts`, exporting `register<Name>(program, io, setExit)`,
   and give it an entry in `COMMANDS` (`packages/cli/src/program.ts`) under every name it registers.
   Give it a line in both `UNSEEN` and `LOADED` (`scripts/coverage-floors.ts`, which say why).
3. Add an end-to-end test in `packages/cli/test/`, using the `tade()` helper that spawns the
   real binary under plain `node`. Set `TADE_HOME` (and `HOME`) to tmp dirs so tests never touch
   `~/.tade` or read your real transcripts.
   **Never hold the workbench in-process while spawning the CLI.** Opening it takes the home, and
   the child would be refused: let the child open it, or use `lockHome` deliberately when what you
   are testing *is* the refusal. And spawn asynchronously — `spawnSync` blocks the event loop, and
   with the
   loop blocked, vitest's own timeout never fires: the run hangs silently instead of failing.
4. Its `.description()` is its documentation: `tade --help` is where commands are explained. Add it
   to the README's short **Use** list only if it is one of the few people start with.
5. `pnpm check`.

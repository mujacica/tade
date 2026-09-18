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
- **Interactive commands must end at end of input.** `readline`'s `question()` never settles on EOF,
  so a loop built on it hangs on Ctrl-D or piped input, and whatever it started keeps running.
  Iterate the interface (`for await (const line of rl)`), which ends on both EOF and close, and stop
  what you started in a `finally`.

## Steps

1. Implement the logic in the right package with its own unit tests.
2. Write it in `packages/cli/src/commands/<name>.ts`, exporting `register<Name>(program, io, setExit)`,
   and call that from `buildProgram()` in `packages/cli/src/program.ts`.
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

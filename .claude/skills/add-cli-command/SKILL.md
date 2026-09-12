---
name: add-cli-command
description: Add or change a `wilco` CLI subcommand (commander), including --json output, exit codes, tests and README. Use for any new user-facing command or flag.
---

# Adding a `wilco` command

The CLI is `packages/cli`. `src/bin.ts` is the entry; `src/program.ts` builds the commander
program and exposes `run(argv, io)` which returns an exit code instead of calling `process.exit`.

## Conventions

- Exit codes come from `Exit` in `program.ts`: `ok` 0, `error` 1, `invalidInput` 2.
  Signal failure with `setExit(...)`, never `process.exit()` (it breaks tests and terminal restore).
- Write through `io.out` / `io.err`, never `console.log`, so tests can capture output.
- Commands that report state get a `--json` flag. JSON output is the stable contract: sorted
  deterministically, no timestamps other than explicit `generatedAt`-style fields.
- Human output is terse: under ~10 lines for a typical machine.
- Heavy logic lives in the owning package (`@wilco/core`, `@wilco/probes`, ...). The command
  only parses flags, calls it, and formats.
- Commands never throw for expected failures; turn them into a message on stderr + exit code.

## Steps

1. Implement the logic in the right package with its own unit tests.
2. Register the command in `buildProgram()` in `packages/cli/src/program.ts`
   (or a `src/commands/<name>.ts` file exporting `register(program, io, setExit)` once
   `program.ts` grows past ~150 lines).
3. Add an end-to-end test in `packages/cli/test/`, using the `wilco()` helper that spawns the
   real binary under plain `node`. Set `WILCO_HOME` (and `HOME`) to tmp dirs so tests never touch
   `~/.wilco` or read your real transcripts.
   **If the test also starts a `Daemon` in-process, spawn the CLI asynchronously.** `spawnSync`
   blocks the event loop the daemon needs to answer the request, so the two deadlock — and with the
   loop blocked, vitest's own timeout never fires: the run hangs silently instead of failing.
4. Add the command to the **Commands** table in `README.md`.
5. `pnpm check`.

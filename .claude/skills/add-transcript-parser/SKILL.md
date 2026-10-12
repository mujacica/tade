---
name: add-transcript-parser
description: Teach Tade to adopt sessions from a new agent provider, or fix adoption after a provider changed its transcript format. Use when `tade status` misses or misreads sessions started outside Tade, or warns about "unrecognised format".
---

# Adding or fixing a transcript parser

Adoption lives in `packages/status/src/adoption.ts`. Each provider is one `TranscriptParser`
object in the `parsers` array: `{ provider, version, dir, depth, begin, read, end }` — a fold over
the file's lines.

## Invariants (don't break these)

- `end` **returns `null` on anything it doesn't recognise, and nothing throws.** `scanTranscripts`
  turns nulls into an "unrecognised format (parser vN)" warning, which is how format drift shows up.
- **A fold, because a window reads on from where it stopped** (`TranscriptReads`): a file that has
  not changed is not opened, and one that grew is read from just past the last whole line. So
  `read` takes lines oldest first and hands back what it knows now, **never changing what it was
  given** (that is kept for the next beat), and folding the lines in any number of runs must answer
  what folding them in one does — "answers what reading from the start answers" holds every fixture
  to it.
- Only read what's needed: `begin` gets the path and the first 64 KiB (which may end mid-line);
  lines come from the last 256 KiB on a first read, with a cut first line dropped before the
  parser sees it, and from where the last scan stopped after that.
- Never infer a permission request you can't see as an explicit record. A false `blocked` is worse
  than a missing one. `pendingPermissions` must come from a real approval event.
- `turn` is `idle` only on an explicit end-of-turn marker. When in doubt, use `unknown`.

## Steps

1. Get a real transcript from the provider. **Sanitize it**: keep the structure and field names,
   replace prompts, code, paths and ids with neutral synthetic values. Keep it short (5–15 lines).
2. Save it under `test/fixtures/transcripts/<provider>/<provider-version>/`, named for the
   scenario (`idle.jsonl`, `mid-tool.jsonl`, `approval.jsonl`, ...). If the provider encodes ids in
   file names (Codex: `rollout-...-<uuid>.jsonl`), keep that shape.
3. Write failing tests in `packages/status/test/adoption.test.ts`, one per fixture, asserting
   `sessionId`, `cwd`, `turn`, `pendingPermissions`, `consecutiveFailures`, `lastActivityAt`, and
   add the fixture to the cases of "answers what reading from the start answers".
4. Implement or adjust the parser. For a **format change**, bump `version` and keep the old
   fixtures passing if both formats are still in the wild; otherwise move the old fixtures to
   a folder named for the old provider version and delete them once that version is unsupported.
5. For a **new provider**, also add its CLI to `PROVIDERS` in `packages/status/src/processes.ts`
   so a running process can prove liveness.
6. `pnpm check`, then run `pnpm tade status --json` on a machine with a live session and check it.

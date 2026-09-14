Spend shown in the status bar (bottom right) and the spend overview only reflects the orchestrator. A real agent reported $0.351 and it never appeared.

Start by finding where spend events are recorded: `packages/core/src/spend.ts` (`SpendReport`, `byTask`), `packages/core/src/events.ts`, `packages/workbench/src/workbench.ts`, `packages/harnesses/pi/src/wilco.ts` (the supervision channel — does it report usage/cost per message back to Wilco?), `packages/app/src/spend.ts`, `packages/app/src/panels.ts`, `packages/app/src/view.ts`, `packages/cli/src/program.ts` (`wilco spend`).

Likely cause: only the orchestrator's own turns emit the spend event; agent-side usage from pi's transcript is never journaled, or is journaled without a task/project so it drops out of the report. Diagnose first, say what you found, then fix so agent spend lands in `byTask`/`byProject` and shows in both the status bar and the overview.

Invariants: spend numbers come from the harness, never estimated (see the header comment in `packages/core/src/spend.ts`); `events.jsonl` is the truth and the SQLite index must stay rebuildable from it; status/spend questions must read files directly and never open the workbench.

Done looks like: a test proving an agent's reported cost appears in the report and in the status bar figure; `pnpm check` green (run the suite on its own).

Other agents work in this same checkout — commit only your own files.

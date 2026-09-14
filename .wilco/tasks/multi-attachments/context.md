Three related bugs around images/attachments on the orchestrator line:

1. **Only one screenshot survives.** `attachClipboard()` in `packages/app/src/app.ts` (~line 2465) calls `attachImages([path])` — pasting a second one appears to replace the first. Pending attachments must accumulate into a list, shown in the line, each removable.
2. **Attachments are not forwarded to agents.** When the orchestrator hands work to an agent (`ctx.wilco.startAgent` / `wilco_run_start` / steer), the attached images/files never reach the agent. They should be passed through to the harness — see `packages/harnesses/core/src/port.ts` and `packages/harnesses/pi/src/wilco.ts` — and/or written beside the task so the agent can read them, and mentioned in the agent's first prompt.
3. **Same for non-image attachments** (dropped/pasted files), not just clipboard screenshots.

Relevant files: `packages/app/src/app.ts`, `packages/app/src/images.ts`, `packages/app/src/view.ts`, `packages/app/test/images.test.ts`, `packages/app/test/screens/scenarios.ts` (screen snapshot `dropping-a-screenshot`), `packages/harnesses/core/src/port.ts`, `packages/harnesses/pi/src/wilco.ts`.

Done looks like: pasting several screenshots keeps all of them; they reach an agent when work is handed off; the same for file attachments; new tests for multiple attachments and for forwarding; `pnpm check` green (run the suite on its own).

Another agent (wilco/agent-2) is working in this same checkout — commit only your own files.

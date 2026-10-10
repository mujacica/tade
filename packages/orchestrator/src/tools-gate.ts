// The gate on **every** tool the orchestrator's session has, asked of Tade at
// the call.
//
// **Self-contained like its siblings**: pi loads `tools-extension.ts` directly
// under its own module resolution, so nothing here imports from the Tade
// workspace — the JSON-RPC client is passed in rather than imported, which is
// also what lets a test drive this without a socket.

/** What a `tool_call` hook answers: nothing, or a refusal with words. */
export interface ToolCallGate {
  block?: boolean
  reason?: string
}

/**
 * The half of pi's API this needs: a hook before a tool runs.
 *
 * `on` is optional, because a harness that does not offer one is a harness
 * that cannot be gated — and the honest thing then is to register no hook
 * rather than to pretend. What stops a *remote turn* reaching such a harness
 * is `canBeArmed` (`origin.ts`), which refuses one before it starts.
 */
export interface Gateable {
  on?(event: 'tool_call', hook: (event: { toolName?: unknown }) => Promise<ToolCallGate>): void
}

/** One call to Tade, as `tools-extension.ts` makes them. */
export type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>

/**
 * The gate on **every** tool this session has, asked of Tade at the call.
 *
 * **Why it is here and not in the supervision extension.** The orchestrator
 * cannot load both: each registers the extension tools this run was listed
 * (`TADE_EXTENSION_TOOLS`), and pi refuses to start on the collision. So the
 * gate lives in Tade's own tools extension, which the orchestrator loads by
 * definition — and it needs no `approvals` mode, which means **nothing about a
 * local turn changes**: the orchestrator is still ungated for the person at
 * the keyboard, because the answer for a local turn is always yes.
 *
 * **Unreachable means allow, and the argument is not convenience.** The thing
 * that answers this question is the window, and the window is also the only
 * thing that can serve a message from a paired device — the away view is its
 * listener and dies with it. So a socket that cannot be reached is a window
 * that is gone, which is a machine where no remote turn can exist and there is
 * nobody to narrow. Failing closed there would instead break the orchestrator
 * of a window that died, for no safety at all.
 *
 * What it costs: one unix-socket round trip per tool call, in the same process
 * tree. What it buys: a shell that a stranger's words cannot reach.
 */
export function gateTools(pi: Gateable, rpc: Rpc): void {
  if (typeof pi.on !== 'function') return
  pi.on('tool_call', async (event) => {
    const tool = typeof event.toolName === 'string' ? event.toolName : ''
    let said: unknown
    try {
      said = await rpc('origin/allow', { tool })
    } catch {
      return {}
    }
    const answer = (said ?? {}) as { allow?: unknown; reason?: unknown }
    if (answer.allow === true) return {}
    return {
      block: true,
      reason:
        typeof answer.reason === 'string' && answer.reason !== ''
          ? answer.reason
          : `${tool} is not something Tade allows on this turn`,
    }
  })
}

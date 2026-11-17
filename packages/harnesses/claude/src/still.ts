// What Tade's tool server says to Claude Code while a call is waiting on Tade.
//
// Claude Code gives up on an MCP call that sends nothing for thirty minutes:
// "sent no response or progress for 1800s; aborting"
// (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, there by 2.1.311). That counts silence,
// not how long the call has taken, so `MCP_TOOL_TIMEOUT` and every deadline
// Tade sets above it never came into it. The tool server said nothing until the
// answer, so anything longer was cut off, though Tade went on and finished it.
// On 2026-11-17, at a load average of 100 and more, one agent lost two
// related `checks_run`s (39 minutes for a change to `package.json`) and a
// `tade_done` whose leftovers took 32 minutes to become parked work.
//
// Claude Code puts a `progressToken` on every call, and a progress notification
// on that token resets its clock. So a call that is still waiting says so
// once a minute, and says what it is waiting on. That is not a keepalive that
// hides a hang: each call still ends at its own deadline (`TOOL_CALL_MS`,
// `DONE_CALL_MS`) with words saying what happened. Not
// `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` either: that is the agent's own Claude
// Code's switch, it would reach every server the person gave it, and it would
// take away the cut-off for a server that really has gone quiet.
//
// Loaded by Claude Code's own processes, so nothing of ours is imported.

/** How often a call that has not been answered yet says so. */
export const STILL_MS = 60_000

/**
 * Say every `every` ms, on the call's own progress token, what it is still
 * waiting on (`waitingOn()`, read again each time), until the returned stop
 * is called. A call with no token can have nothing said about it, so nothing is.
 */
export function stillWaiting(
  token: unknown,
  waitingOn: () => string,
  send: (message: unknown) => void,
  every = STILL_MS,
): () => void {
  if (typeof token !== 'string' && typeof token !== 'number') return () => {}
  const since = Date.now()
  let progress = 0
  const timer = setInterval(() => {
    progress += 1
    const minutes = Math.max(1, Math.round((Date.now() - since) / 60_000))
    send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: token,
        progress,
        message: `${waitingOn()}: ${minutes} min so far`,
      },
    })
  }, every)
  timer.unref?.()
  return () => clearInterval(timer)
}

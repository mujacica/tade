// What Tade's tool server says to Grok while a call is waiting on Tade.
//
// Grok puts a `progressToken` on the calls it makes to an MCP server, and its
// own deadline for one (`tool_timeout_sec`, 6000 seconds unless a config says
// otherwise) is long, but a tool Tade runs can be longer — a full run of a
// project's checks on a loaded machine — and a client that counts silence
// rather than time is how Claude Code once cut such calls off (its
// `still.ts`). So a call still waiting says so once a minute, on its own
// token, and says what it is waiting on. That is not a keepalive that hides a
// hang: each call still ends at its own deadline (`TOOL_CALL_MS`,
// `DONE_CALL_MS`) with words saying what happened.
//
// Loaded by Grok's own processes, so nothing of ours is imported.

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

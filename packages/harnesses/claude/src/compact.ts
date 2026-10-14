// How full the conversation Tade draws itself is, and how it is made shorter,
// read out of Claude Code's machine protocol (`-p --output-format stream-json`).
//
// Its own file because it is a different subject from the turn: the adapter
// says what a turn did, and this is what the conversation it is in weighs.
// What the protocol said was taken from a real run of 2.1.287: a `/compact`
// sent as a message is run as the slash command, under the same session id —
// `status: compacting`, `compact_result`, an `init`, a `compact_boundary`
// carrying what was there before and what is left, and a `result` like any
// turn's.

/** `/compact`, as a message on its protocol: run as the command, never answered as words. */
export const COMPACT_LINE = `${JSON.stringify({
  type: 'user',
  message: { role: 'user', content: '/compact' },
})}\n`

/**
 * How much of the context a request filled: everything it was sent, read from
 * the cache or not. What it wrote back is the next request's, so it is not
 * counted here — the same sum its status line draws.
 */
export function tokensIn(message: { usage?: unknown } | undefined): number | null {
  const usage = message?.usage as Record<string, unknown> | undefined
  if (!usage) return null
  const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
  const sum =
    count('input_tokens') + count('cache_read_input_tokens') + count('cache_creation_input_tokens')
  return sum > 0 ? sum : null
}

/**
 * The context window a turn ran in, from what its `result` says of each model
 * it used: the one it is on where that is named, and otherwise the largest,
 * since a smaller model it called on the side is not the conversation's.
 */
export function windowIn(result: Record<string, unknown>, model: string | null): number | null {
  const used = result.modelUsage as Record<string, { contextWindow?: unknown }> | undefined
  if (!used || typeof used !== 'object') return null
  const sizeOf = (name: string) => {
    const size = used[name]?.contextWindow
    return typeof size === 'number' && size > 0 ? size : null
  }
  if (model && sizeOf(model)) return sizeOf(model)
  const sizes = Object.keys(used).flatMap((name) => sizeOf(name) ?? [])
  return sizes.length > 0 ? Math.max(...sizes) : null
}

/** How full, as the percentage a person reads: whole, and never past the whole. */
export function percentOf(tokens: number, window: number): number {
  return Math.min(100, Math.round((tokens / window) * 100))
}

/**
 * What a compaction said about itself — done, with how many tokens are left;
 * failed, with why — or null for anything else. Its own (`trigger: auto`) is
 * read the same way, so how full the context is never stays at the figure
 * from before it.
 */
export function compactionIn(
  event: Record<string, unknown>,
): { after: number } | { failed: string } | null {
  if (event.type !== 'system') return null
  if (event.subtype === 'compact_boundary') {
    const after = (event.compact_metadata as { post_tokens?: unknown } | undefined)?.post_tokens
    return typeof after === 'number' ? { after } : null
  }
  const result = event.compact_result
  if (event.subtype === 'status' && typeof result === 'string' && result !== 'success') {
    const why = event.compact_error ?? event.error
    return { failed: typeof why === 'string' && why ? why : `the compaction ended in ${result}` }
  }
  return null
}

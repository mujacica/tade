// Bounded fan-out, for probes that spawn.
//
// `collectStatus` used to await each worktree's git probe one at a time, which
// on thirteen worktrees is fifty serial spawns a beat: the beat is missed, the
// view goes stale, and the spawns are themselves a good part of why the
// machine is too busy to answer them.
//
// Bounded, and never unbounded, is the whole point. `fork` + `exec` + dynamic
// linking + reading a git index is the most load-sensitive thing status does,
// and fifty of them at once on a loaded machine is worse than fifty in a row:
// each one gets a slice of a machine that now has fifty more things to
// schedule, and the slowest decides when the answer arrives.

/**
 * Run `work` over `items`, at most `limit` at a time, answers in input order.
 *
 * Order is kept because everything above sorts and compares, and a pool that
 * returned answers in the order they happened to finish would make
 * `tade status --json` a different document on every run.
 */
export async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await work(items[i]!)
    }
  }
  const lanes = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length))
  await Promise.all(Array.from({ length: lanes }, worker))
  return out
}

// Closing things on the way out, by a moment and not a moment later.
//
// Quitting is a list of closes — a listener, a status child, a model process,
// MCP sessions, a reporter's queue, the journal — and every one of them is
// somebody else's code waiting on somebody else's process or network. Awaited
// one by one with no deadline, the slowest of them is how long the window takes
// to close, and the one that never answers is a window that never does: the
// person presses ctrl+c again, which is the bug this exists to end.
//
// So everything shares one moment (`by`), side by side, and what is still going
// then is given up on and **named**, never waited for and never passed over in
// silence. A close that throws has finished — its trouble is its own, said where
// it happened — so it is not late.

/** One thing closed on the way out, and what it is called if it is late. */
export interface Closing {
  name: string
  close: () => Promise<unknown> | unknown
}

/**
 * Close every one side by side, giving up on any still going at `by` (a
 * `Date.now()` moment). Answers the names of the ones given up on, in the
 * order given; empty when everything closed in time.
 */
export async function closeBy(
  closings: readonly Closing[],
  by: number,
  now: () => number = Date.now,
): Promise<string[]> {
  const late: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const out = new Promise<'late'>((done) => {
    timer = setTimeout(() => done('late'), Math.max(0, by - now()))
    // The deadline is not something to stay open for.
    timer.unref?.()
  })
  try {
    await Promise.all(
      closings.map(async (closing) => {
        const closed = (async () => closing.close())().then(
          () => 'closed' as const,
          () => 'closed' as const,
        )
        if ((await Promise.race([closed, out])) === 'late') late.push(closing.name)
      }),
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return closings.map((closing) => closing.name).filter((name) => late.includes(name))
}

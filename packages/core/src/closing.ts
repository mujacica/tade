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
// silence. A close that throws has finished, so it is not waited for either —
// and it is answered with what it threw, because on the way out there is
// nobody left to have said it.

/** One thing closed on the way out, and what it is called if it does not close. */
export interface Closing {
  name: string
  close: () => Promise<unknown> | unknown
}

/** A close that did not finish cleanly: still going at the moment (`error` absent), or thrown. */
export interface Unclosed {
  name: string
  error?: unknown
}

/**
 * Close every one side by side, giving up on any still going at `by` (a
 * `Date.now()` moment). Answers the ones given up on and the ones that threw,
 * in the order given; empty when everything closed, and in time.
 */
export async function closeBy(
  closings: readonly Closing[],
  by: number,
  now: () => number = Date.now,
): Promise<Unclosed[]> {
  const unclosed = new Map<Closing, Unclosed>()
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
          (error: unknown) => {
            unclosed.set(closing, { name: closing.name, error })
            return 'closed' as const
          },
        )
        if ((await Promise.race([closed, out])) === 'late') {
          unclosed.set(closing, { name: closing.name })
        }
      }),
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return closings.flatMap((closing) => {
    const one = unclosed.get(closing)
    return one ? [one] : []
  })
}

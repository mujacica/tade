// Waiting in a page whose content policy refuses `eval`.
//
// Its own file because both harness scripts wait this way, and two copies of
// one loop is the sort of difference nobody notices until one of them stops
// timing out.

/** What of a page a wait needs. */
interface Waits {
  evaluate: (body: string) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
}

/**
 * Poll until a snippet says yes, because `waitForFunction` cannot run here.
 *
 * The content policy has no `unsafe-eval`, and Playwright's `waitForFunction`
 * polls by compiling a string in the page — which that policy refuses, as it
 * refuses every other `eval` an injected script could try. `evaluate` goes
 * through the debugger protocol instead and needs no `eval` at all, so the
 * waiting happens here. **That the policy refuses it is the point**: a harness
 * that worked around it by loosening the header would be testing a page nobody
 * is served.
 */
export async function until(page: Waits, body: string, ms = 10_000): Promise<void> {
  const stop = Date.now() + ms
  for (;;) {
    if ((await page.evaluate(body)) === true) return
    if (Date.now() > stop) throw new Error(`nothing answered yes in ${ms}ms`)
    await page.waitForTimeout(100)
  }
}

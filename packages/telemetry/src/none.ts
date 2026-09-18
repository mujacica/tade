import type { Reporter, Span } from './port.ts'

/** A span that times nothing, so no call site has to ask whether one is real. */
export const noSpan: Span = {
  about() {},
  inside() {
    return noSpan
  },
  wrong() {},
  end() {},
}

/**
 * The reporter for when nothing is sent, which is Tade unless someone says
 * otherwise. A working reporter rather than a null, so every call site can
 * report without asking first whether there is anywhere to report to.
 */
export function noReporter(): Reporter {
  return {
    id: 'none',
    on: false,
    trouble() {},
    note() {},
    measure() {},
    doing() {
      return noSpan
    },
    async flush() {},
    async close() {},
  }
}

import type { Reporter } from './port.ts'

/**
 * The reporter for when nothing is sent, which is Wilco unless someone says
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
    async flush() {},
    async close() {},
  }
}

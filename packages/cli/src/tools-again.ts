// How often the orchestrator is started again because its tools did not
// connect. Its own file, apart from `orchestrating.ts`, because that one only
// runs inside the binary and is not measured (`UNSEEN`), and this is the part a
// test can hold in process.

/**
 * How many times it is started again for tools that did not connect, within
 * `TOOLS_AGAIN_MS`. A server that missed its deadline on a loaded machine
 * usually makes the next one, and the session it missed is without its tools
 * for good; a server that never comes up would be a restart a turn, for ever.
 */
export const TOOLS_AGAIN = 2
/** The stretch `TOOLS_AGAIN` is counted over: long enough to stop a loop, short enough for a later spell of load. */
export const TOOLS_AGAIN_MS = 60 * 60_000

/**
 * The times it was started again for its tools, with `now` among them — or
 * null when that would be one time too many within `TOOLS_AGAIN_MS`.
 */
export function againForToolsAt(before: readonly number[], now: number): number[] | null {
  const lately = before.filter((at) => at > now - TOOLS_AGAIN_MS)
  return lately.length >= TOOLS_AGAIN ? null : [...lately, now]
}

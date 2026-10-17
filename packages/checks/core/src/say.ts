import type { CheckRun } from './port.ts'

// How a run is said, in one line, wherever it is read: a tool's answer, a
// context file, the window's own words. One place, so a run that happened
// here and a run that happened on a forge never read as different things.

/** One run as a line: `- ✓ \`tests\` passed (here) — 412 passed`. */
export function checkLine(run: CheckRun): string {
  return `- ${glyphOf(run.state)} \`${run.check}\` ${run.state} (${whereOf(run)})${
    run.summary ? ` — ${run.summary}` : ''
  }`
}

/** A run's state as one character: green, red or going. */
export function glyphOf(state: CheckRun['state']): string {
  if (state === 'passed') return '✓'
  if (state === 'failed' || state === 'timed out') return '✗'
  if (state === 'skipped' || state === 'cancelled') return '–'
  return '⋯'
}

/**
 * What to say beside a run recorded against an earlier commit that still
 * stands, because the bytes it read are the bytes this commit holds. Said
 * rather than hidden: anybody reading a tick is owed what ran, and when.
 */
export function carriedNote(run: CheckRun, carried: boolean): string {
  return carried ? ` (ran at ${run.commit.slice(0, 8)}, over these very bytes)` : ''
}

/** Where it ran, as a person reads it: `here`, or the forge's own name. */
export function whereOf(run: CheckRun): string {
  return run.where.kind === 'here' ? 'here' : run.where.forge
}

/** What an `unknown` rollup with green related tests beside it is called, wherever it is said. */
export const FULL_PENDING = 'related tests passed, full run pending'

/**
 * The few words for where a commit stands, with the related tests beside the
 * rollup: null where they add nothing, so the rollup's own word stands. Never
 * a green — the related run is a look at a few tests, and the full checks are
 * what pass or fail a tree.
 */
export function pendingWords(
  rollup: 'pass' | 'fail' | 'unknown',
  related: 'passed' | 'failed' | null,
): string | null {
  if (rollup !== 'unknown' || related === null) return null
  return related === 'passed' ? FULL_PENDING : 'related tests failed'
}

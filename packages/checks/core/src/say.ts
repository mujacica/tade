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

/** Where it ran, as a person reads it: `here`, or the forge's own name. */
export function whereOf(run: CheckRun): string {
  return run.where.kind === 'here' ? 'here' : run.where.forge
}

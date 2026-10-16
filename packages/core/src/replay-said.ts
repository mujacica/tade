import {
  candidateSays,
  REPLAY_OUTCOMES,
  type Replay,
  type ReplayEntrant,
  type Summed,
} from './replay.ts'

// What a replay is said as: in the window, on the command line and to the
// orchestrator, in the same words — so none of them says a figure the others
// would not. "Could not replay" is said apart from failing, every time, and
// what nothing could say is said as that (`—`), never as nought.

/** Money as a person reads it: `$0.41`, and `—` for none recorded. */
export function dollars(usd: number | null): string {
  return usd === null ? '—' : `$${usd.toFixed(2)}`
}

function summedSays(one: Summed): string {
  return one.sum === null ? '—' : `${one.atLeast ? '≥ ' : ''}${dollars(one.sum)}`
}

/** A duration in minutes, or `—`. */
export function minutes(ms: number | null): string {
  if (ms === null) return '—'
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

/** `+40 −3 (the original +52 −10)`, or what nothing could say. */
export function sizeBeside(entrant: ReplayEntrant): string {
  const mine = entrant.facts?.size
  const theirs = entrant.case?.size
  const own =
    mine && mine.added !== null && mine.removed !== null
      ? `+${mine.added} −${mine.removed}`
      : 'size not counted'
  return theirs ? `${own} (the original +${theirs.added} −${theirs.removed})` : own
}

/** What a replay's spend stands at, against its ceiling and the originals. */
export function spentSays(replay: Replay): string {
  const spent =
    replay.spent.sum === null
      ? 'no money recorded — the ceiling counts billed dollars, and a plan’s turns bill none'
      : `${summedSays(replay.spent)} of its ${dollars(replay.ceilingUsd)} ceiling`
  return `${spent}; the originals of what ran cost ${summedSays(replay.originals)}`
}

/** The counts, as a clause: `3 passed, 1 failed, 1 could not replay`. Noughts left out. */
export function countsSay(replay: Pick<Replay, 'counts'>): string {
  const parts = REPLAY_OUTCOMES.filter((one) => replay.counts[one] > 0).map(
    (one) => `${replay.counts[one]} ${one}`,
  )
  return parts.length > 0 ? parts.join(', ') : 'nothing yet'
}

/**
 * Where a replay stands, as lines a person or a model reads: what was asked,
 * on what, what each case came to beside its original, and what it cost.
 * "Could not replay" is said apart from failing, every time.
 */
export function replaySays(replay: Replay): string[] {
  const scored = replay.counts.passed + replay.counts.failed
  const lines = [
    `Replay ${replay.name} in ${replay.project}, on ${candidateSays(replay.candidate)}: ${countsSay(replay)}.`,
    `Spent ${spentSays(replay)}.${replay.stopped ? ' The ceiling stopped it.' : ''}`,
  ]
  if (scored > 0) {
    lines.push(
      `${replay.counts.passed} of ${scored} scored replays held up; ${replay.counts['could not replay']} could not be replayed and are not counted against it.`,
    )
  }
  for (const one of replay.entrants) {
    const original = one.case
    const where = one.task ?? '—'
    const beside = original
      ? ` — the original ran on ${original.harness} · ${original.model}, ${dollars(original.usd)}, ${minutes(original.workedMs)}`
      : ''
    const own = one.facts
      ? ` ${dollars(one.facts.usd)}, ${minutes(one.facts.workedMs)}, ${sizeBeside(one)}.`
      : ''
    lines.push(
      `  ${one.of} → ${where}: ${one.outcome}${one.why ? ` (${one.why})` : ''}.${own}${beside}`,
    )
  }
  return lines
}

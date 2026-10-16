// A judge asked again: the arithmetic of a candidate judge's answers beside
// the recorded ones and the verdicts people wrote (B2's judge leg, run by the
// judge that keeps the record — `jev_replay`). Counting, and only counting: a
// judge never grades a judge, so nothing here reads a probability as anything
// but on or off one threshold, and no rate is said under `enough`.
//
// Pure: facts in, answers out.

/** One recorded reading, read again by a candidate judge. */
export interface JudgeReplayCase {
  /** What the finding keys were built from. */
  unit: string
  /** Every question's answer when it was recorded. */
  recorded: Readonly<Record<string, number>>
  /** The candidate's answers, or null where it could not read the change. */
  replayed: Readonly<Record<string, number>> | null
  /** What somebody decided about a question that was raised, by question. */
  verdicts: Readonly<Record<string, 'confirmed' | 'false positive'>>
}

/** How a candidate judge's answers came out beside the recorded ones and the verdicts people wrote. */
export interface JudgeReplayScore {
  /** Readings the candidate answered, and those it could not. */
  read: number
  couldNot: number
  /** Questions both raised, or neither did, over every question asked of both. */
  agreed: number
  asked: number
  /** What each side raised. */
  raised: { recorded: number; candidate: number }
  /** Findings people confirmed, and how many of them the candidate raised too. */
  confirmed: { of: number; caught: number }
  /** Findings people dismissed, and how many of them the candidate raised anyway. */
  dismissed: { of: number; raisedAgain: number }
}

/**
 * The arithmetic of a judge asked again, and nothing else: which questions the
 * two agree on at one threshold, and how the candidate stands against the
 * verdicts people wrote. A judge never grades a judge — this is counting.
 */
export function judgeReplayScore(
  cases: readonly JudgeReplayCase[],
  threshold: number,
): JudgeReplayScore {
  const score: JudgeReplayScore = {
    read: 0,
    couldNot: 0,
    agreed: 0,
    asked: 0,
    raised: { recorded: 0, candidate: 0 },
    confirmed: { of: 0, caught: 0 },
    dismissed: { of: 0, raisedAgain: 0 },
  }
  for (const one of cases) {
    if (one.replayed === null) {
      score.couldNot++
      continue
    }
    score.read++
    for (const [question, was] of Object.entries(one.recorded)) {
      const now = one.replayed[question]
      if (now === undefined) continue
      const before = was >= threshold
      const after = now >= threshold
      score.asked++
      if (before === after) score.agreed++
      if (before) score.raised.recorded++
      if (after) score.raised.candidate++
      const verdict = one.verdicts[question]
      if (verdict === 'confirmed') {
        score.confirmed.of++
        if (after) score.confirmed.caught++
      } else if (verdict === 'false positive') {
        score.dismissed.of++
        if (after) score.dismissed.raisedAgain++
      }
    }
  }
  return score
}

/** A judge replay's score, as lines: counts before rates, and no rate under `enough`. */
export function judgeReplaySays(score: JudgeReplayScore, enough: number): string[] {
  const rate = (n: number, of: number) =>
    of >= enough && of > 0 ? ` (${Math.round((100 * n) / of)}%)` : ''
  return [
    `Read ${score.read} recorded change${score.read === 1 ? '' : 's'} again${score.couldNot > 0 ? `; ${score.couldNot} could not be read` : ''}.`,
    `Agreed on ${score.agreed} of ${score.asked} answers${rate(score.agreed, score.asked)}; raised ${score.raised.candidate} where the recorded judge raised ${score.raised.recorded}.`,
    `Of ${score.confirmed.of} finding${score.confirmed.of === 1 ? '' : 's'} people confirmed, it raised ${score.confirmed.caught}${rate(score.confirmed.caught, score.confirmed.of)}; of ${score.dismissed.of} they dismissed, it raised ${score.dismissed.raisedAgain} again${rate(score.dismissed.raisedAgain, score.dismissed.of)}.`,
  ]
}

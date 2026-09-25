import { duration } from '@tade/core'
import type { OpenFinding } from './loop.ts'

// Why a finding is not closing, said as one of a named set of reasons.
//
// A finding with no verdict is not one fact, it is six, and every one of them
// wants something different done about it. In the record this was written
// against, twelve of twenty-six findings had no verdict and the oldest had
// waited three days — and the page said the same thing about all twelve:
// "waiting on a verdict", which is the symptom and not any of the causes. Nine
// of the twelve had never been accounted for at all, and several of those were
// read as a whole branch before a finding was ever about one agent's own
// commits, so nobody alive could account for them; the other three had an
// account and were waiting on a verdict that nothing was asking for again.
//
// So the reason is derived and said. It closes nothing — that is a verdict,
// and a verdict is the orchestrator's or a person's — and nothing here ages a
// finding into an outcome: `answered` is the only state this file ever reads
// as settled, and it means somebody wrote one down.
//
// Pure: a finding and two questions about the world in, a reason out.

/** Why nothing has closed this finding. */
export type Stuck =
  /** Somebody wrote a verdict: not stuck at all. */
  | 'answered'
  /**
   * Its agent has not answered for it, and is still there to — or nobody can
   * say otherwise. With no window open the journal's `task_done` is all there is
   * to conclude from, and an agent is not gone because nobody is looking, so
   * this is also what a finding nobody can ask about yet reads as.
   */
  | 'agent-working'
  /** Its agent is gone and never accounted for it. */
  | 'agent-gone'
  /**
   * It was read as a whole branch rather than as one agent's own commits, and
   * every agent whose work was in that branch is gone. Unanswerable by
   * construction: the question was asked about seven people's work against
   * seven intents joined together, so no one agent can account for the answer.
   */
  | 'shared-change'
  /** Nothing says whose work it was, so there is nobody to account for it. */
  | 'nobody-to-ask'
  /** Its agent answered, somebody was told, and nobody has written a verdict. */
  | 'told-not-judged'
  /** Its agent answered and nothing has put it in front of anybody yet. */
  | 'waiting-to-be-told'

/** What has to be asked of the world to say why a finding is stuck. */
export interface Whose {
  /** Whether that task's agent is still there to answer. */
  going(task: string): boolean
  /** Whether the sweep has already put this finding's key in front of somebody. */
  told(key: string): boolean
}

/**
 * Whether a unit is one agent's own change.
 *
 * One task, and the unit keyed by that task: anything else — a branch, a ref
 * range somebody named, a worktree several tasks share — is a change that is
 * nobody's in particular, and a question asked about it cannot be accounted
 * for by any one agent.
 */
export function oneAgents(finding: Pick<OpenFinding, 'unit' | 'tasks'>): boolean {
  return finding.tasks.length === 1 && finding.tasks[0] === finding.unit
}

/** Why this finding has not closed. */
export function stuckOf(finding: OpenFinding, whose: Whose): Stuck {
  if (finding.verdict) return 'answered'
  if (finding.account) {
    return whose.told(finding.key) ? 'told-not-judged' : 'waiting-to-be-told'
  }
  if (finding.tasks.length === 0) return 'nobody-to-ask'
  if (finding.tasks.some((task) => whose.going(task))) return 'agent-working'
  return oneAgents(finding) ? 'agent-gone' : 'shared-change'
}

/** What to do about a finding stuck this way, in one sentence somebody can act on. */
export function stuckSaid(stuck: Stuck): string {
  if (stuck === 'answered') return 'answered'
  if (stuck === 'agent-working') return 'its agent has not answered for it and is still there to'
  if (stuck === 'agent-gone')
    return 'its agent is gone and never answered: only a verdict closes it'
  if (stuck === 'shared-change') {
    return 'it was read as a whole branch, not one agent’s own commits, and every agent in it is gone: only a verdict closes it'
  }
  if (stuck === 'nobody-to-ask')
    return 'nothing says whose work it was, so nobody can account for it'
  if (stuck === 'told-not-judged') return 'its agent answered and somebody was told; no verdict yet'
  return 'its agent answered and nothing has put it in front of anybody yet'
}

/** The shortest way of saying it, for a column in a table. */
export function stuckMark(stuck: Stuck): string {
  if (stuck === 'answered') return 'judged'
  if (stuck === 'agent-working') return 'its agent'
  if (stuck === 'agent-gone') return 'agent gone'
  if (stuck === 'shared-change') return 'whole branch'
  if (stuck === 'nobody-to-ask') return 'nobody’s'
  if (stuck === 'told-not-judged') return 'told, no verdict'
  return 'not told yet'
}

/** One finding, with why it is not closing and how long it has been that way. */
export interface Standing {
  finding: OpenFinding
  stuck: Stuck
  /** How long since the reading that raised it. */
  waitedMs: number
}

/** Every finding with why it stands where it does, longest waiting first. */
export function standingsOf(
  findings: readonly OpenFinding[],
  whose: Whose,
  now: number,
): Standing[] {
  return findings
    .map((finding) => ({
      finding,
      stuck: stuckOf(finding, whose),
      waitedMs: Math.max(0, now - finding.at),
    }))
    .sort((a, b) => b.waitedMs - a.waitedMs)
}

/** How many are stuck each way, in the order the page reads them. */
export const STUCK_ORDER: readonly Stuck[] = [
  'told-not-judged',
  'waiting-to-be-told',
  'agent-working',
  'agent-gone',
  'shared-change',
  'nobody-to-ask',
  'answered',
]

/** A count per reason, with the reasons nothing is stuck by left out. */
export function stuckTally(standings: readonly Standing[]): { stuck: Stuck; count: number }[] {
  const counted = new Map<Stuck, number>()
  for (const one of standings) counted.set(one.stuck, (counted.get(one.stuck) ?? 0) + 1)
  return STUCK_ORDER.filter((stuck) => (counted.get(stuck) ?? 0) > 0).map((stuck) => ({
    stuck,
    count: counted.get(stuck) ?? 0,
  }))
}

/**
 * The gap in a clause: how many are open, how long the oldest has waited, and
 * the reason where there is only one. Nothing when nothing is open.
 *
 * The reason is in it because "9 findings waiting on a verdict" was read for
 * three days as a queue somebody would get to, when four of the nine were
 * waiting on nothing at all. Only where they all share one, though: with two
 * reasons at one apiece, "mostly because" is a claim about a tie.
 */
export function stuckSays(standings: readonly Standing[]): string | null {
  const open = standings.filter((one) => one.stuck !== 'answered')
  if (open.length === 0) return null
  const reasons = stuckTally(open)
  const only = reasons.length === 1 ? reasons[0] : null
  const oldest = open.reduce((worstMs, one) => Math.max(worstMs, one.waitedMs), 0)
  return `${open.length} finding${open.length === 1 ? '' : 's'} with no verdict. The oldest has waited ${duration(oldest)}${only ? `, and ${stuckSaid(only.stuck)}` : ''}.`
}

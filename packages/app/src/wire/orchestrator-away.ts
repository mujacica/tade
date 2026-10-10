import { type Arm, byOf, LOCAL } from '@tade/core'
import type { Thinker } from './context.ts'

// The three questions the away view asks of the conversation, and nothing else.
//
// **Free functions over a `Thinker` rather than methods**, which is what makes
// them readable in one screen and testable without a window: each is a fold of
// what the harness already reports, and none of them remembers anything. A
// remembered answer to "whose turn is this" is the one that still names a phone
// after the turn ended, and that is precisely the answer the `ToolHost` would
// then narrow every one of the person's own tool calls against.
//
// Split out of `orchestrator.ts` for size, and the seam is honest: that file is
// the conversation as the window drives it — the transcript, the news, the
// borrowed screen, the model — and this is what something *outside* the window
// is allowed to know about it.

/**
 * How far the turn in flight reaches.
 *
 * `LOCAL` before the orchestrator is up and between turns, which is the honest
 * answer rather than a permissive one: there is no turn to narrow, and what
 * calls the host outside one is the window's own child doing what the window
 * asked. A thinker with no notion of an arm — every one but the real
 * orchestrator — is `LOCAL` for the same reason, and `cannotTalk` is what stops
 * a remote turn ever reaching such a thinker.
 */
export function armOfThinker(thinker: Thinker | null): Arm {
  return thinker?.arm?.() ?? LOCAL
}

/**
 * Whose turn is in flight, as `byOf` writes it. Empty for none.
 *
 * Read off the arm rather than remembered, for the reason `whereYouAre` is
 * derived every turn. `you` where a turn is running under no arm, because that
 * is what a local turn is — and the word is `byOf`'s, so the transcript, the
 * journal, the device list and this all name a phone the same way.
 */
export function whoseTurn(thinker: Thinker | null): string {
  if (!(thinker?.busy?.() ?? false)) return ''
  const arm = armOfThinker(thinker)
  return arm.how === 'remote' ? byOf({ how: 'remote', device: arm.device }) : 'you'
}

/**
 * Stop the turn in flight, if this harness can: escape's own act, asked for
 * from somewhere else.
 *
 * `false` where the harness cannot, rather than a quiet nothing — the away
 * view answers that as `not_offered`, and a button that says it stopped
 * something when nothing could be stopped is a button nobody trusts the next
 * time. The harness's own answer, through `offer()`, which is the one rule
 * every surface in Tade asks: no surface offers what another hides.
 */
export async function stopTurn(
  thinker: Thinker | null,
  interrupt: () => Promise<void>,
): Promise<boolean> {
  if (!thinker?.offers?.interrupt.shown) return false
  await interrupt()
  return true
}

/**
 * Why a paired device cannot be answered here, or null when it can.
 *
 * Three answers and they are not interchangeable: the orchestrator has not
 * started yet, this Tade has no way to run a narrowed turn at all, or the
 * harness itself cannot be narrowed. The last is the one that must never be
 * silent — a harness whose own tool calls cannot be held would run a
 * stranger's words unrestricted — so it is the harness's own sentence, and a
 * device is told it rather than being answered.
 */
export function cannotTalk(thinker: Thinker | null): string | null {
  if (!thinker) return 'Tade is still starting'
  if (!thinker.askFrom) return 'this Tade cannot answer a paired device'
  return thinker.unarmed?.() ?? null
}

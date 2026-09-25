import type { QueueState } from '@tade/core'

// What the SMART QUEUE shows, and nothing about what is in it.
//
// Its own file because three others need the words — the model that filters by
// them, the window that draws the controls, and the file that reads last
// night's choice back off disk — and because the reasoning below is about the
// shape of two controls rather than about any of those three.
//
// Pure, and importing nothing of the window's: a view and a piece of queued
// work in, a yes or a no out.

/**
 * What `shownBy` needs of a piece of queued work: whether a clock is involved.
 * Structural, so a `QueueRow`'s pane satisfies it without this file having to
 * know what a pane is.
 */
export interface OnAClock {
  at: number | null
  state: QueueState
}

/**
 * How much of the queued work the SMART QUEUE shows: all of it, or the front
 * of the resolved tree.
 */
export type QueueScope = 'all' | 'next'

export const QUEUE_SCOPES: readonly QueueScope[] = ['all', 'next']

/**
 * What the SMART QUEUE shows, which is two questions and not one.
 *
 * `all` and `next` are *positions* in the resolved tree — the whole of it, or
 * its front. Waiting for a clock is a *kind* of queued work, which is why it
 * was never a third position: drawn as a third exclusive choice it took the
 * slot the ordinary case wanted, so "everything that is not on a clock" — much
 * the commonest thing to want — had no button at all, and a fourth would have
 * been a second spelling of `all` in every project with no schedules in it.
 *
 * So the kind is its own switch. `timed` off is the view that was missing, at
 * either scope; `timed` on at `next` is the other thing three buttons could
 * not say — the front of the tree *and* the clock about to fire, which is a
 * true answer to what happens next and used to be two views to read.
 */
export interface QueueView {
  scope: QueueScope
  /** Queued work waiting for a time, and the schedules, are in the list. */
  timed: boolean
}

/** What the queue shows where nobody has said otherwise: the whole of it. */
export const WHOLE_QUEUE: QueueView = { scope: 'all', timed: true }

/**
 * Whether a view is leaving something out — so the control that is leaving it
 * out is drawn even where there is nothing else to filter. A switch you cannot
 * reach is work hidden with no way to get it back.
 */
export function narrowing(view: QueueView): boolean {
  return view.scope !== WHOLE_QUEUE.scope || view.timed !== WHOLE_QUEUE.timed
}

/** Whether queued work waits for a clock rather than for us. */
export function onAClock(queued: OnAClock): boolean {
  return queued.at !== null || queued.state.kind === 'scheduled'
}

/**
 * Whether queued work is what a view shows.
 *
 * The two questions are answered one after the other, and neither answers the
 * other's: `timed` decides whether work waiting for a clock is in the list at
 * all, and the scope decides how much of the tree is.
 *
 * `next` is the front of the resolved tree: the work that starts as soon as
 * what it waits on finishes. Nothing queued stands before it — so work behind
 * one running agent is next, and the second piece of a chain is not — and it
 * is work that will start by itself when that happens, which held and paused
 * work will not: each of those needs somebody, and is said in its own words
 * where the list comes out empty rather than counted as next. Work waiting for
 * a time will start by itself, so it is next like the rest of the front; what
 * keeps it out of the list is the switch, and only the switch. Not everything
 * queued, and not only what could start this second.
 */
export function shownBy(
  view: QueueView,
  row: { queued: OnAClock; parent: string | null },
): boolean {
  if (!view.timed && onAClock(row.queued)) return false
  if (view.scope === 'all') return true
  if (row.parent !== null) return false
  const kind = row.queued.state.kind
  return kind === 'ready' || kind === 'waiting' || kind === 'scheduled'
}

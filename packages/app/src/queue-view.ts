import type { QueueState } from '@tade/core'

// What the SMART QUEUE shows, and nothing about what is in it.
//
// Its own file because three others need the words — the model that filters by
// them, the window that draws the control, and the file that reads last
// night's choice back off disk — and because the reasoning below is about the
// shape of a control rather than about any of those three.
//
// Pure, and importing nothing of the window's: a view and a piece of queued
// work in, a yes or a no out.

/**
 * How much of the queued work the SMART QUEUE shows: all of it, or the front
 * of the resolved tree.
 */
export type QueueScope = 'all' | 'next'

export const QUEUE_SCOPES: readonly QueueScope[] = ['all', 'next']

/**
 * What the SMART QUEUE shows, which is one question: where in the resolved
 * tree to look. `all` and `next` are *positions* in it — the whole of it, or
 * its front.
 *
 * There was a second control here, a `timed` switch, and the split that gave
 * the schedules a section of their own is what took it away. It was invented
 * because work on a clock crowded out the work waiting on us — and what was
 * doing the crowding was the schedules, eight of them across two projects,
 * listed as tabs among the queued work. With those in SCHEDULES, what is left
 * on a clock in the queue is an ordinary piece of one-off work that waits on a
 * time instead of on another task: as much the queue's as anything else in it,
 * and never more than a row or two of it. A switch over that would be a second
 * way of saying what the section boundary now says, and its `off` position
 * would hide real queued work — which is why it needed `queueEmptySays` to
 * explain itself in the first place.
 */
export interface QueueView {
  scope: QueueScope
}

/** What the queue shows where nobody has said otherwise: the whole of it. */
export const WHOLE_QUEUE: QueueView = { scope: 'all' }

/**
 * Whether a view is leaving something out — so the control that is leaving it
 * out is drawn even where there is nothing else to filter. A control you
 * cannot reach is work hidden with no way to get it back.
 */
export function narrowing(view: QueueView): boolean {
  return view.scope !== WHOLE_QUEUE.scope
}

/**
 * Whether queued work is what a view shows.
 *
 * `next` is the front of the resolved tree: the work that starts as soon as
 * what it waits on finishes. Nothing queued stands before it — so work behind
 * one running agent is next, and the second piece of a chain is not — and it
 * is work that will start by itself when that happens, which held and paused
 * work will not: each of those needs somebody, and is said in its own words
 * where the list comes out empty rather than counted as next. Work waiting for
 * a time will start by itself, so it is next like the rest of the front. Not
 * everything queued, and not only what could start this second.
 */
export function shownBy(
  view: QueueView,
  row: { queued: { state: QueueState }; parent: string | null },
): boolean {
  if (view.scope === 'all') return true
  if (row.parent !== null) return false
  const kind = row.queued.state.kind
  return kind === 'ready' || kind === 'waiting' || kind === 'scheduled'
}

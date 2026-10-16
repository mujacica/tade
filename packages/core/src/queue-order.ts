import type { TadeEvent } from './events.ts'
import type { Queued } from './queue.ts'

// The order written for queued work, which is only ever a preference among
// what is ready. Out of `queue.ts`, which is at the size a file is allowed to
// be, and its own subject: the rule there says whether work may start, and
// this says only which of what may goes first.

/**
 * The order last written for queued work, or nothing written. Like every
 * other choice about the queue it is a fact in the journal, with who made it
 * and why — never a score that recomputes, so the last line written wins and
 * nothing can be starved by something newer looking better.
 */
export function writtenOrder(events: readonly TadeEvent[]): string[] {
  let order: string[] = []
  for (const event of events) {
    if (event.type !== 'queue_changed' || event.detail.change !== 'order') continue
    const said = event.detail.order
    if (Array.isArray(said)) order = said.map(String).filter((task) => task !== '')
  }
  return order
}

/**
 * Ready work in the order last written for it; anything unnamed keeps its
 * place behind, in the order it was asked for.
 *
 * This is a preference among work that is already ready, and nothing more: it
 * cannot jump a wait, unhold a hold, resume a pause, exceed `max_parallel` or
 * change what `queueStateOf` says about anything. `readyToStart` keeps its
 * rule and its signature — what changes is only which of the ready ones is
 * looked at first.
 */
export function inWrittenOrder(items: readonly Queued[], events: readonly TadeEvent[]): Queued[] {
  const written = writtenOrder(events)
  if (written.length === 0) return [...items]
  const place = new Map(written.map((task, at) => [task, at]))
  const behind = written.length
  // A stable sort, so work nobody named stays in the order it arrived in.
  return [...items].sort(
    (one, other) => (place.get(one.task) ?? behind) - (place.get(other.task) ?? behind),
  )
}

/** An order that puts one piece of work first and leaves the rest as they were. */
export function orderFirst(
  items: readonly Queued[],
  events: readonly TadeEvent[],
  task: string,
): string[] {
  const rest = inWrittenOrder(items, events)
    .map((item) => item.task)
    .filter((one) => one !== task)
  return [task, ...rest]
}

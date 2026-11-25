import type { TadeEvent } from './events.ts'
import { foreign } from './feeds.ts'

// The lines of one journal array by task and by type, so a fold that asks
// about one task reads that task's lines and not the whole journal.
//
// The queue's rules each read "every line about this task" (`choicesFor`,
// `troubleWith`, `troubleStarting`, `movedIn`), once per piece of queued work
// and once per wait, on every status beat, every advance of the queue and
// every beat of the away view. Over a journal of ~170,000 queue lines with 165
// queued tasks that was 52% of the window's one thread under load (a CPU
// profile of the running window, 2026-11-25), every pass of it reading the
// same lines to find the few dozen that named the task.
//
// Built once per array and **extended as it grows**: a journal is appended to
// and never rewritten, so the lines indexed stay where they were and only the
// new ones at the end are read. Whether the array is still the one indexed is
// asked of its length and its last indexed line; an array that got shorter,
// or whose line there is another, is indexed again from the start. Keyed
// weakly by the array itself, so the index goes when the array does.
//
// Pure: no I/O and no clock. What it hands back is in the journal's order,
// and only ever read — never change one of its lists.

interface Index {
  /** How many lines of the array are in it, and the last of them. */
  length: number
  last: TadeEvent | undefined
  byTask: Map<string, TadeEvent[]>
  byType: Map<string, TadeEvent[]>
  /** This machine's own lines (`ownLines`), or null while none is foreign and the array is its own answer. */
  own: TadeEvent[] | null
}

const NONE: readonly TadeEvent[] = Object.freeze([])
const indexes = new WeakMap<readonly TadeEvent[], Index>()

function fresh(): Index {
  return { length: 0, last: undefined, byTask: new Map(), byType: new Map(), own: null }
}

function add(map: Map<string, TadeEvent[]>, key: string, event: TadeEvent): void {
  const list = map.get(key)
  if (list) list.push(event)
  else map.set(key, [event])
}

function indexed(events: readonly TadeEvent[]): Index {
  let index = indexes.get(events)
  const kept =
    index !== undefined &&
    events.length >= index.length &&
    (index.length === 0 || events[index.length - 1] === index.last)
  if (!index || !kept) {
    index = fresh()
    indexes.set(events, index)
  }
  for (let i = index.length; i < events.length; i++) {
    const event = events[i] as TadeEvent
    if (typeof event.task === 'string') add(index.byTask, event.task, event)
    add(index.byType, event.type, event)
    if (foreign(event)) index.own ??= events.slice(0, i).filter((line) => !foreign(line))
    else index.own?.push(event)
  }
  if (events.length > index.length) {
    index.length = events.length
    index.last = events[events.length - 1]
  }
  return index
}

/** Every line of `events` about `task`, in the journal's order. */
export function linesOf(events: readonly TadeEvent[], task: string): readonly TadeEvent[] {
  return indexed(events).byTask.get(task) ?? NONE
}

/** Every line of `events` of one type, in the journal's order. */
export function linesTyped(events: readonly TadeEvent[], type: string): readonly TadeEvent[] {
  return indexed(events).byType.get(type) ?? NONE
}

/**
 * This machine's own lines of `events`, as `ownLines` says them, kept with the
 * index rather than filtered again on every ask: the same array where nothing
 * foreign is in it, and otherwise one that grows with it.
 */
export function ownOf(events: readonly TadeEvent[]): readonly TadeEvent[] {
  return indexed(events).own ?? events
}

import {
  AT_WORK_READS,
  DOCUMENT_EVENTS,
  INTAKE_EVENTS,
  REPLAY_EVENTS,
  RUNTIME_EVENTS,
  type TadeEvent,
} from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { aboutRoot } from './away-lifecycle.ts'

// The whole-history lists the window keeps, read once when it opens — and
// never on the way to its first frame.
//
// They were read before anything was drawn: six queries over the whole
// journal, every one of them synchronous SQLite and a `JSON.parse` per row.
// Over a real journal of 136k lines that was 83,957 usage rows (86–208 ms),
// 33,045 the queue reads (112 ms) and four smaller ones, ~350 ms in all at
// load 5 on 14 cores — a third of a second of a blank terminal for answers the
// first frame does not draw: what a task cost, how long it ran, whether queued
// work has started. So they are read after the window is up, one query per
// turn of the event loop, so a key or a frame is answered between any two of
// them, and the first look at status waits on them rather than the first
// frame (`Live.start`).

/** How much of the journal to keep for working out what recently moved. */
export const JOURNAL = 500

/** What decides where queued work stands, read from the whole journal rather than its tail. */
export const QUEUE_READS = [
  // Who is at work in a checkout (`atWorkFrom`): a run, and everything that
  // ends one — a lane going and a window closing included, or a run runtime
  // closed a day ago is an agent in every hold since.
  ...AT_WORK_READS,
  'failed',
  'queue_started',
  'queue_held',
  'queue_changed',
  // What the orchestrator was told would collide, so it is told once.
  'conflict_forecast',
  'schedule_fired',
  // What a watch has found, which is never forgotten: one finding, one piece of work.
  'watch_checked',
  'watch_found',
  // What rang a watch's doorbell, and what did not verify: whether its poll is slowed.
  'hook_rung',
  // What agents left unfixed, each made parked work: what later work is related on.
  'leftovers_reported',
  // Which queued work came from outside, so its grant, plan and source are asked
  // again as it starts: without these the queue read every piece as yours.
  ...INTAKE_EVENTS,
  // Whether the person approved a document queued work waits on (`approvedFrom`),
  // which is a fold over every line about documents and not only the triage.
  ...DOCUMENT_EVENTS,
  // Which entrant a race kept, which closes the rest: told once, and never in a tail.
  'race_won',
  // What a replay took, graded and stopped at: its whole record, never a tail of it.
  ...REPLAY_EVENTS,
] as const

/**
 * What runtime is derived from: when an agent started and stopped, when its
 * lane went, and when the window that was watching it did — a run nobody wrote
 * an exit for ended when Tade closed, not at breakfast the next morning. The
 * list is `runtimeFrom`'s own, so the panel can never read less than it reads.
 */
export const RUNTIME_READS = RUNTIME_EVENTS

/** Finishing, read whole: whether a task is done cannot depend on how busy the journal has been since. */
export const TOLD_READS = ['task_done', 'run_started', 'turn_done'] as const

/** Every list, as of one moment of the journal (`upTo`). */
export interface Histories {
  /** The last `JOURNAL` events. */
  recent: TadeEvent[]
  /** Every `usage` event: the Spend page's longest range is the journal itself. */
  usage: TadeEvent[]
  told: TadeEvent[]
  runs: TadeEvent[]
  queue: TadeEvent[]
  /** Every line that wrote where a project lives: a project closed last month can still be opened again. */
  roots: TadeEvent[]
  /**
   * The newest event any of these may hold. Read first, with the tail, and
   * every list after it is cut to it: an event appended while the lists were
   * being read is one the subscription hears, and is never counted twice.
   */
  upTo: number
  /** Each list that could not be read, said in words: an empty list stands in for it. */
  failed: string[]
}

/** A turn of the event loop, so whatever is waiting is answered before the next query. */
const aTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Read every list, a query a turn. A query that fails is an empty list and a
 * sentence in `failed`: the window opening is never what a journal that could
 * not be read stops, and never what it stops in silence either.
 */
export async function readHistories(client: Pick<Workbench, 'events'>): Promise<Histories> {
  const failed: string[] = []
  const read = async (what: string, filter: Parameters<Workbench['events']>[0]) => {
    await aTurn()
    return client.events(filter).catch((err: unknown) => {
      const why = err instanceof Error ? err.message : String(err)
      failed.push(`could not read ${what} from the journal, so the window goes without it: ${why}`)
      return null
    })
  }
  // The tail first: its last line is the moment everything else is cut to. A
  // tail that could not be read has no moment to cut to, so nothing is cut and
  // the newest line read stands in for it — which can count a line appended
  // while the rest were read twice, and only on a journal already failing.
  const tail = await read('what happened lately', { limit: JOURNAL })
  const upTo = tail ? (tail.at(-1)?.seq ?? 0) : Number.POSITIVE_INFINITY
  const cut = (events: TadeEvent[] | null) => (events ?? []).filter((event) => event.seq <= upTo)
  const usage = cut(await read('what was spent', { types: ['usage'] }))
  const told = cut(await read('which tasks finished', { types: [...TOLD_READS] }))
  const runs = cut(await read('how long agents ran', { types: [...RUNTIME_READS] }))
  const queue = cut(await read('what the queue decided', { types: [...QUEUE_READS] }))
  const roots = cut(await read('where projects live', { types: ['config_changed'] })).filter(
    aboutRoot,
  )
  const recent = tail ?? []
  const newest = Math.max(
    0,
    ...[usage, told, runs, queue, roots].map((one) => one.at(-1)?.seq ?? 0),
  )
  return {
    recent,
    usage,
    told,
    runs,
    queue,
    roots,
    upTo: Number.isFinite(upTo) ? upTo : newest,
    failed,
  }
}

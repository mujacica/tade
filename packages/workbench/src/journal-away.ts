import { Worker } from 'node:worker_threads'
import { type ReadableEventType, type TadeEvent, typeNames } from '@tade/core'

// One task's lines from before a number in the journal, read on a thread of
// its own.
//
// **Asked by a page on a phone, answered on the thread that draws the window**,
// so nothing of it may be done here: the index is a synchronous database, and
// the journal it stands in for is a hundred megabytes on a machine that has
// been busy for a month. A thread costs about 150ms to start, none of it on
// this one, and it is started only when somebody scrolls further back than
// what the window already holds — never on a beat.

/** What the thread is handed: where to look, and what for. */
export interface BeforeJob {
  path: string
  /** The index beside it, or null where there is none and the file is read through. */
  index: string | null
  task: string
  /** Every name the asked types were ever written under. */
  names: string[]
  /** Only lines numbered below this. */
  before: number
  most: number
}

/** What the thread says back: the lines, and why the index could not be asked where it could not. */
export interface BeforeRead {
  events: TadeEvent[]
  trouble: string | null
}

/** What one read asks: one task's lines of these types, numbered below `before`. */
export interface BeforeAsk {
  task: string
  types: readonly ReadableEventType[]
  before: number
  most: number
}

/**
 * How long the thread may take before it is ended and the read is said to
 * have broken: the file read through is about a second for a hundred
 * megabytes, so only a thread that is stuck reaches this.
 */
export const BEFORE_MS = 30_000

const THREAD = new URL('./journal-thread.ts', import.meta.url)

/**
 * The newest `most` of one task's lines of `types` numbered below `before`,
 * newest first, and why the index could not be asked where the file was read
 * instead. Throws where the thread died, ended without a word or took past its
 * deadline, naming which: a read that could not happen is never answered as
 * one that found nothing.
 */
export function readBeforeAway(
  where: { path: string; index: string | null },
  ask: BeforeAsk,
  opts: { entry?: URL; ms?: number } = {},
): Promise<BeforeRead> {
  const job: BeforeJob = {
    ...where,
    task: ask.task,
    names: [...typeNames(ask.types)],
    before: ask.before,
    most: ask.most,
  }
  const ms = opts.ms ?? BEFORE_MS
  const what = `${ask.task}'s journal before line ${ask.before}`
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (then: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      then()
    }
    const worker = new Worker(opts.entry ?? THREAD, { name: 'tade journal', workerData: job })
    // Never a reason for the process to stay: the request waiting on it is.
    worker.unref()
    const timer = setTimeout(
      () => done(() => reject(new Error(`reading ${what} took longer than ${ms / 1_000}s`))),
      ms,
    )
    worker.once('message', (read: BeforeRead) => done(() => resolve(read)))
    worker.once('error', (error: Error) =>
      done(() => reject(new Error(`reading ${what} failed: ${error.message}`))),
    )
    worker.once('exit', (code) =>
      done(() => reject(new Error(`reading ${what} ended with nothing said (exit ${code})`))),
    )
  })
}

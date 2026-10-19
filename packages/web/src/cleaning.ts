import { Worker } from 'node:worker_threads'
import { cleanText } from './screen.ts'

// One call's whole answer, cleaned off the window's thread.
//
// **The server answers on the thread that draws the window**, and an answer is
// never cut (`answered.ts`), so cleaning one is as long as the answer is: about
// 60ms a megabyte of test output, 90ms one of a minified bundle (M-series,
// Node 26) — a five-megabyte answer opened on a phone was the window frozen for
// half a second, keys and all. So a large one is cleaned on a thread of its own
// by the same `cleanText`, and what comes back is exactly what it would have
// been here. Not cut into slices cleaned between frames: a credential's shape
// may run across a line (`password:` and its value under it), so a slice's edge
// is somewhere one would get through.
//
// A thread costs about 150ms to start, none of it on this one, so one under
// `OFF_THREAD_FROM` is cleaned where it is asked — a few milliseconds, less
// than starting anything.

/** How long an answer is, in characters, before it is cleaned off this thread: about 4ms here. */
export const OFF_THREAD_FROM = 64 * 1024

/**
 * How long the thread may take, before it is ended and the answer is said to
 * have broken: ten seconds, and a second for every megabyte — more than ten
 * times what cleaning measured, so only a thread that is stuck reaches it.
 */
export function cleanDeadline(length: number): number {
  return 10_000 + Math.ceil(length / 1_000)
}

const THREAD = new URL('./cleaning-thread.ts', import.meta.url)

/**
 * `cleanText`, off this thread for an answer over `OFF_THREAD_FROM`. Throws
 * where the thread died, ended without a word or took past its deadline,
 * naming which: nothing is passed off as an answer that was not cleaned.
 */
export function cleanAway(
  text: string,
  known: readonly string[],
  opts: { entry?: URL; ms?: number } = {},
): Promise<{ text: string; taken: number }> {
  if (text.length < OFF_THREAD_FROM) return Promise.resolve(cleanText(text, known))
  const ms = opts.ms ?? cleanDeadline(text.length)
  const size = `${(text.length / 1e6).toFixed(1)} MB`
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (then: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      then()
    }
    const worker = new Worker(opts.entry ?? THREAD, {
      name: 'tade answer cleaning',
      workerData: { text, known: [...known] },
    })
    // Never a reason for the process to stay: the request waiting on it is.
    worker.unref()
    const timer = setTimeout(
      () =>
        done(() => reject(new Error(`cleaning a ${size} answer took longer than ${ms / 1_000}s`))),
      ms,
    )
    worker.once('message', (clean: { text: string; taken: number }) => done(() => resolve(clean)))
    worker.once('error', (error: Error) =>
      done(() => reject(new Error(`cleaning a ${size} answer failed: ${error.message}`))),
    )
    worker.once('exit', (code) =>
      done(() =>
        reject(new Error(`cleaning a ${size} answer ended with nothing said (exit ${code})`)),
      ),
    )
  })
}

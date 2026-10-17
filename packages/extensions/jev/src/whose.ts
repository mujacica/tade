import type { ExtensionContext } from '@tade/extensions-core'
import { inTime } from '@tade/extensions-core'
import { commitsByTask } from './changes.ts'
import type { Review } from './reviews.ts'
import { oneAgents } from './stuck.ts'

// Whose a reading is, read out of the commits in its range rather than the
// list it was filed under.
//
// Older lines in `reviews.jsonl` filed a branch a checkout shares under every
// task working there, and the record is never rewritten. So everything that
// says whose a finding is reads it through here: `jev_findings`, the sweep and
// `jev_replay`, which may take as long as git does, and the window's own
// readers — the Jev page, the brief and the `findings` hook the landing desk
// and the away view read — which are on the window's beat and may not
// (`whoseInTime`).

/** Nothing read out of the record goes to git as anything but a commit id. */
const SHA = /^[0-9a-f]{7,64}$/

/** How many ranges are read at once, the first time a record is read. */
const READERS = 8

/** The longest a reader on the window's beat waits on trailers before it answers with what it knew. */
export const TRAILERS_MS = 1_000

/**
 * Whose commits a range holds, by their trailers. A range of commit ids is the
 * same commits for ever, and so is what they say, so one read once is never
 * read again: the first read of a record is a few hundred `git log`s, and every
 * one after it is none.
 */
const signedBy = new Map<string, string[]>()

/**
 * The ranges being read now. A beat that comes back while one is still being
 * read waits on that read rather than starting another, so a slow range is one
 * `git log` however many beats ask about it.
 */
const reading = new Map<string, Promise<void>>()

/** Where a reading's range is read, or null where the list it was filed under stands. */
function rangeIn(roots: ReadonlyMap<string, string>, review: Review) {
  const root = roots.get(review.project)
  if (oneAgents(review) || !root || !SHA.test(review.base) || !SHA.test(review.head)) return null
  const range = `${review.base}..${review.head}`
  return { key: `${root}\0${range}`, root, range }
}

function readOnce(ctx: ExtensionContext, key: string, at: { root: string; range: string }) {
  let one = reading.get(key)
  if (!one) {
    one = commitsByTask(ctx, at.root, at.range)
      .then((read) => {
        if (read.read) signedBy.set(key, [...read.byTask.keys()])
      })
      .finally(() => reading.delete(key))
    reading.set(key, one)
  }
  return one
}

/**
 * The readings, each with the tasks whose `Tade-Task:` trailer is on a commit
 * in its range, where the list it was filed under could be wrong.
 *
 * A reading of a branch a checkout shares was filed under every task working
 * there, so `jev_findings task=<x>` handed x four findings about ranges holding
 * nothing of x's, and the sweep counted thirty-three tasks as sharing a change
 * one of them made. Those lines are evidence and are never rewritten; whose a
 * commit is, is in the commit, and that is what is read here instead — nobody,
 * where no commit in the range carries one. A reading that is one task's own
 * stays as it was filed, because on a shared branch its range starts where the
 * oldest of them branched and holds everybody's commits. Where git cannot
 * answer — a range gone, a project not set up here — the filed list is all
 * there is, and stands.
 *
 * Told to stop, it starts no more reads and answers with what it knows; a read
 * already started finishes, and is kept for whoever asks next.
 */
export async function whoseReadings(
  ctx: ExtensionContext,
  reviews: readonly Review[],
  signal?: AbortSignal,
): Promise<Review[]> {
  const roots = new Map(ctx.projects.map((one) => [one.name, one.root]))
  const unread = new Map<string, { root: string; range: string }>()
  for (const review of reviews) {
    const at = rangeIn(roots, review)
    if (at && !signedBy.has(at.key)) unread.set(at.key, at)
  }
  const queue = [...unread]
  const reader = async () => {
    while (!signal?.aborted) {
      const next = queue.shift()
      if (!next) return
      await readOnce(ctx, ...next)
    }
  }
  await Promise.all(Array.from({ length: READERS }, reader))
  return reviews.map((review) => {
    const at = rangeIn(roots, review)
    const signed = at ? signedBy.get(at.key) : undefined
    return signed ? { ...review, tasks: [...signed] } : review
  })
}

/**
 * The same, for a reader on the window's beat: whatever is known by the
 * deadline. Late is the list a reading was filed under where nothing has been
 * read of its range yet — what the window drew before it read trailers at all —
 * and the reads it started go on, so the next beat has them.
 */
export async function whoseInTime(
  ctx: ExtensionContext,
  reviews: readonly Review[],
  ms = TRAILERS_MS,
): Promise<Review[]> {
  const controller = new AbortController()
  try {
    return await inTime(
      whoseReadings(ctx, reviews, controller.signal),
      ms,
      'whose the readings are was not read in time',
      controller,
    )
  } catch (err) {
    if (!controller.signal.aborted) throw err
    // Told to stop, it reads nothing and answers with what is known now.
    return whoseReadings(ctx, reviews, controller.signal)
  }
}

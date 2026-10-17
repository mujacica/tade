import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Pictures handed on by their path, and how long one is kept.
//
// A picture pasted at the orchestrator's line is saved by the window
// (`orchestratorAttachments`), and a harness that cannot be handed one writes
// its own copy and points its model at that (each adapter's
// `promptWithImages`). Both go on by the path alone, so nothing can tell when
// the last reader is done with one — and the orchestrator's conversation never
// ends, so there is no end to tie one to either. Neither was ever taken away:
// on one machine the orchestrator's harness copies alone came to 38 pictures
// and 15 MB in five days, under a folder that only grew.
//
// So a picture is kept for a while rather than for good. The model is pointed
// at it with the message it came with and reads it then; the file is wanted
// again only for a second look at something said recently. What is older goes
// the next time a picture is written into the same folder, which is the only
// time the folder grows.

/** How long a picture handed on by its path is kept: a second look is at something recent. */
export const PICTURES_KEPT_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The files in `folder` last written more than `PICTURES_KEPT_MS` before
 * `now`, removed, and their paths. A folder not made yet has nothing in it,
 * and a file gone by the time it is looked at is already what was wanted.
 * Anything else is thrown rather than passed off as tidied: a folder of Tade's
 * own it cannot read or empty is one that grows for good again, and the
 * picture going with it is where somebody hears about it.
 */
export function forgetOldPictures(folder: string, now: number): string[] {
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch (err) {
    if (isMissing(err)) return []
    throw err
  }
  const gone: string[] = []
  for (const name of names) {
    const path = join(folder, name)
    try {
      // Not followed: a link or a folder in here is nothing this wrote.
      const stat = lstatSync(path)
      if (!stat.isFile() || now - stat.mtimeMs <= PICTURES_KEPT_MS) continue
      rmSync(path)
      gone.push(path)
    } catch (err) {
      if (!isMissing(err)) throw err
    }
  }
  return gone
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

import type { ChangedIn, ChangesIn, WebChanges } from '@tade/web'
import type { Change } from '../frame.ts'

// This machine's half of an agent's changes read from away (`@tade/web`'s
// `changes.ts`): the files its CHANGES section lists and each one's diff, by
// the same look and the same git question the window's own Show changes asks
// (`changesAt`, `diffAt`), measured from the same base.
//
// Asked when a page opens them and never held. git runs asynchronously and
// every file has a deadline, a few at once, so a change of a hundred files is
// never the window waiting; a file git could not answer for in time is
// `unread` on its own row rather than the whole answer lost. `diffIn` throws
// nothing — git's failures are its answers — so nothing here catches.

/** How many files' diffs are asked of git at once. */
export const AT_ONCE = 4

/** How long one file's diff may take before it is said to be unreadable. */
export const FILE_MS = 10_000

/** What of the window's look at its checkouts this needs. */
export interface ChangesLook {
  worktreeOf(task: string): string | null
  baseOf(task: string | null): string | null
  changesAt(root: string | null, base: string | null): readonly Change[] | null
  diffAt(root: string, base: string | null, path: string): Promise<string | null>
}

export interface ChangesDeps {
  /** The window's look, or null before it has one. */
  live: () => ChangesLook | null
  /** Every value the window knows to be a key. */
  known: () => readonly string[]
  /** Said at the machine: what could not be read, and why. */
  note: (err: Error) => void
}

export function changesFrom(deps: ChangesDeps): WebChanges {
  return {
    known: () => deps.known(),
    read: async (task): Promise<ChangesIn> => {
      const live = deps.live()
      const root = live?.worktreeOf(task) ?? null
      if (live === null || root === null) return null
      const base = live.baseOf(task)
      const listed = live.changesAt(root, base)
      if (listed === null) return 'not looked'
      if (listed.length === 0) return 'none'
      const files: ChangedIn[] = listed.map((one) => ({
        path: one.path,
        mark: one.mark,
        added: one.added,
        removed: one.removed,
        text: 'unread',
      }))
      let next = 0
      const work = async (): Promise<void> => {
        while (next < files.length) {
          const file = files[next]
          next += 1
          if (file === undefined) continue
          file.text = await diffOf(live, root, base, file.path, (err) =>
            deps.note(new Error(`the away view could not read ${task}'s ${file.path}: ${err}`)),
          )
        }
      }
      await Promise.all(Array.from({ length: Math.min(AT_ONCE, files.length) }, work))
      return { files, base }
    },
  }
}

/** One file's diff, or `unread` where git took past its deadline. */
async function diffOf(
  live: ChangesLook,
  root: string,
  base: string | null,
  path: string,
  said: (why: string) => void,
): Promise<string | null | 'unread'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      live.diffAt(root, base, path),
      new Promise<'unread'>((done) => {
        timer = setTimeout(() => {
          said(`git took more than ${FILE_MS / 1000}s`)
          done('unread')
        }, FILE_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

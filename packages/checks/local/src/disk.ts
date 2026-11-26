import { statfs } from 'node:fs/promises'
import { NO_SPACE } from '@tade/checks-core'

// Whether a failing check failed because the disk was full (`OUT_OF_DISK`).
//
// The words alone are not enough: this repository's own tests fake a full disk
// and print them in a failure's diff. So a check that says them is followed by
// a look at the disks it writes to — the temp folder and where it runs — and
// only one found full counts. The look is made as the words arrive, because a
// suite that fails for want of space reports it while the disk is still full.

/**
 * The share of a filesystem free to us, 0 to 1, or null where it says no size.
 * A look that fails throws, and the run stays red with the reason in its tail.
 */
export type SpaceLeft = (path: string) => Promise<number | null>

export const spaceLeft: SpaceLeft = async (path) => {
  const fs = await statfs(path)
  return fs.blocks > 0 ? fs.bavail / fs.blocks : null
}

/** Below this share free, a filesystem is full: what `df` rounds to 100%. */
export const FULL_BELOW = 0.01

/** Characters kept from one chunk to the next, so the words are found across a split. */
const CARRY = 64

export interface DiskWatch {
  /** Every chunk of the check's output. */
  heard(chunk: string): void
  /**
   * Whether a look found a disk full, once any look in flight has answered or
   * `ms` passed, and why a look could not answer, if one could not.
   */
  full(ms: number): Promise<{ full: boolean; trouble: string | null }>
}

export function watchDisk(left: SpaceLeft, paths: readonly string[]): DiskWatch {
  let carry = ''
  let full = false
  let trouble: string | null = null
  let looking: Promise<void> | null = null
  return {
    heard(chunk) {
      if (full) return
      const text = carry + chunk
      carry = text.slice(-CARRY)
      if (looking || !NO_SPACE.test(text)) return
      looking = Promise.all(paths.map((path) => left(path)))
        .then(
          (shares) => {
            if (shares.some((share) => share !== null && share < FULL_BELOW)) full = true
          },
          (err: unknown) => {
            trouble = err instanceof Error ? err.message : String(err)
          },
        )
        .finally(() => {
          looking = null
        })
    },
    async full(ms) {
      if (looking) {
        await Promise.race([
          looking,
          new Promise<void>((done) => {
            const timer = setTimeout(done, ms)
            timer.unref?.()
          }),
        ])
      }
      return { full, trouble }
    },
  }
}

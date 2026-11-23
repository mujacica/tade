import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git } from '@tade/status'

// Whether the code this Tade runs is still the code in its own checkout.
//
// **Only where Tade runs from its repository** (`pnpm tade app`), read rather
// than configured, the way live reload reads it (`web/src/reloading.ts`): the
// published tarball renames every `.ts` to `.js`, so a module whose own URL
// ends in `.ts` is the repository's copy and nothing else is. An installed
// Tade has no checkout, owes nothing and keeps today's behaviour.
//
// Node loads a module once, so the window, the heart, every handler of the
// away view and every tool keep the code they started on while agents commit
// under them. Live reload covers the away page's own files and the bar covers
// the away view's own `.ts`; neither knows about `app/src/wire`, and
// `tade_updates` said nothing at all. So: the checkout's HEAD — and what was
// uncommitted in it — is noted as Tade starts, and on the beat that already
// looks at git, **at most once a minute**, what differs between then and now
// is asked of git. Anything under a package's `src/`, a `package.json` or the
// lockfile is a reload owed; docs and tests are not. No recursive watcher:
// a whole tree of them costs a descriptor a folder on Linux, and a beat of two
// or three gits a minute costs nothing anybody can see
// (`test/wire/own-code.test.ts` holds the count).
//
// Once owed it stays owed until Tade starts again, and is looked at no more:
// putting a file back is still a running Tade older than the one it started.

/** How often the checkout is looked at, at most. */
export const LOOK_EVERY_MS = 60_000

/** What counts as code the running Tade holds, as git pathspecs from the checkout's root. */
export const CODE = [
  ':(glob)packages/**/src/**',
  ':(glob)packages/**/package.json',
  'package.json',
  'pnpm-lock.yaml',
  // The away page's own files are read from disk and live-reloaded
  // (`reloading.ts`), never held: a change there owes the window nothing.
  ':(exclude,glob)packages/web/src/assets/**',
  ':(exclude,glob)packages/**/test/**',
  ':(exclude,glob)**/node_modules/**',
] as const

/** The checkout this Tade runs from, where it runs from source; null for an installed one. */
export function ownCheckout(url: string = import.meta.url): string | null {
  if (!url.endsWith('.ts')) return null
  // packages/app/src/wire/own-code.ts → the repository's root.
  return fileURLToPath(new URL('../../../../', url)).replace(/\/$/, '')
}

/** `checkout`, for the options a window or `tade serve` opens with: absent for an installed Tade. */
export function ownCheckoutOption(url: string = import.meta.url): { checkout?: string } {
  const checkout = ownCheckout(url)
  return checkout === null ? {} : { checkout }
}

/** What Tade started on: the commit, and every file of its code that differed from it. */
interface Start {
  head: string
  /** A fingerprint of each such file as it was, `''` where it was not there. */
  dirty: ReadonlyMap<string, string>
}

export class OwnCode {
  private readonly root: string | null
  private start: Start | null = null
  private changed: readonly string[] = []
  private lookedAt = Number.NEGATIVE_INFINITY
  private looking: Promise<void> | null = null

  /** `root` null — a Tade not run from its checkout, or a test's window — never looks at all. */
  constructor(root: string | null) {
    this.root = root
  }

  /** Note what Tade starts on. A checkout git cannot read owes nothing, and is never looked at. */
  async begin(): Promise<void> {
    if (this.root === null || this.start !== null) return
    const root = this.root
    const head = await git(root, ['rev-parse', '--verify', 'HEAD'])
    if (!head.ok) return
    const differs = await differing(root, 'HEAD')
    if (differs === null) return
    const dirty = new Map<string, string>()
    for (const path of differs) dirty.set(path, await fingerprint(root, path))
    this.start = { head: head.stdout.trim(), dirty }
  }

  /**
   * On the beat: look again where a minute has passed since the last look,
   * nothing else is looking, and nothing is owed yet. Synchronous and never
   * awaited — the beat is on the thread that draws. `moved` is called once,
   * the first time a reload is owed.
   *
   * Nothing is caught here: git answers with a code rather than throwing, so
   * what could reject is `moved` or a file that could not be read, and that is
   * an unawaited promise `watchProcess` reports rather than a look that went
   * quiet. The next beat looks again.
   */
  beat(now: number, moved: () => void): void {
    if (this.start === null || this.changed.length > 0 || this.looking !== null) return
    if (now - this.lookedAt < LOOK_EVERY_MS) return
    this.lookedAt = now
    this.looking = this.look()
      .then((changed) => {
        if (changed.length === 0 || this.changed.length > 0) return
        this.changed = changed
        moved()
      })
      .finally(() => {
        this.looking = null
      })
  }

  /** The look going now, for a test to wait on. */
  settled(): Promise<void> {
    return this.looking ?? Promise.resolve()
  }

  /** The files of Tade's code that changed since it started; empty while none have. */
  owed(): readonly string[] {
    return this.changed
  }

  /** The commit Tade started on, once noted. */
  startedOn(): string | null {
    return this.start?.head ?? null
  }

  /** What differs from what Tade started on, file by file; empty where git could not say. */
  private async look(): Promise<readonly string[]> {
    const start = this.start
    if (this.root === null || start === null) return []
    const root = this.root
    const now = await differing(root, start.head)
    if (now === null) return []
    const changed: string[] = []
    for (const path of now) {
      const was = start.dirty.get(path)
      // Differs from the start commit and was not uncommitted then: changed.
      // Was uncommitted then: changed only if it is not what it was.
      if (was === undefined || was !== (await fingerprint(root, path))) changed.push(path)
    }
    // Uncommitted at the start and the same as the start commit now: put back,
    // which is still not what was loaded.
    for (const path of start.dirty.keys()) if (!now.has(path)) changed.push(path)
    return changed.sort()
  }
}

/**
 * Every file of Tade's code whose content in the working tree differs from
 * `commit`: tracked ones by `git diff`, and untracked ones, which may have been
 * imported, by `git ls-files`. Null where git could not answer.
 */
async function differing(root: string, commit: string): Promise<Set<string> | null> {
  const diff = await git(root, ['diff', '--no-renames', '--name-only', '-z', commit, '--', ...CODE])
  if (!diff.ok) return null
  const others = await git(root, [
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
    '--',
    ...CODE,
  ])
  if (!others.ok) return null
  return new Set([...names(diff.stdout), ...names(others.stdout)])
}

function names(z: string): string[] {
  return z.split('\0').filter((name) => name !== '')
}

/** What a file holds, as a hash; `''` where it is not there. Any other failure to read it throws. */
async function fingerprint(root: string, path: string): Promise<string> {
  try {
    return createHash('sha1')
      .update(await readFile(join(root, path)))
      .digest('hex')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

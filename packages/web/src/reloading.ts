import { type FSWatcher, watch } from 'node:fs'

// Live reload, for whoever is working on the away view itself.
//
// **Only where Tade runs from its repository**, and that is read rather than
// configured: the published tarball renames every `.ts` to `.js` when it is
// staged (`cut-a-release`), so a module of this package whose own URL ends in
// `.ts` is the repository's copy, run by Node from source — `pnpm tade app`
// — and nothing else is. There is no setting for it, so there is no setting
// to leave on.
//
// Asked for by the window's own listener (`liveReload`) and by nothing else,
// so a test or the browser harness never has a page reloaded under it.
//
// When the folder the listener serves changes on disk, the listener drops what
// it read and every open page is told (`Streams.reloadAll`); the page reloads
// itself unless somebody has typed something into it (`boot.js`). A save is
// often several writes, so a burst is one reload, a beat after the last.

/** Whether this is the repository's own copy, running from source. */
export function fromSource(url: string = import.meta.url): boolean {
  return url.endsWith('.ts')
}

/** How long after the last write in a burst the pages are told. */
export const SETTLE_MS = 150

/**
 * Watch a folder, and call `changed` once per burst of writes to it.
 *
 * Returns the way to stop. Never throws and never holds the process open: a
 * folder that cannot be watched is one that is not live-reloaded, which is
 * what an installed Tade is anyway.
 */
export function watchFolder(dir: string, changed: () => void, settle = SETTLE_MS): () => void {
  let watcher: FSWatcher | null = null
  let pending: ReturnType<typeof setTimeout> | null = null
  try {
    watcher = watch(dir, { persistent: false }, () => {
      if (pending !== null) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        changed()
      }, settle)
      pending.unref?.()
    })
    watcher.on('error', () => {})
  } catch {
    return () => {}
  }
  return () => {
    if (pending !== null) clearTimeout(pending)
    watcher?.close()
  }
}

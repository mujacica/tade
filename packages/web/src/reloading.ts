import { type FSWatcher, watch } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
//
// **What is never reloaded is the server.** Node loads a module once, so the
// route table and every handler are the ones read at start, and a page that
// reloaded into a new screen asks a route this listener has never heard of —
// a `404 no_such` that reads as a refusal. So the listener watches its own
// source too (`serverDir`, `isServerCode`), and once that changed it tells
// every page, and every page that opens after, that Tade has to be restarted
// before the page can be trusted (`Streams.restartAll`).

/** Whether this is the repository's own copy, running from source. */
export function fromSource(url: string = import.meta.url): boolean {
  return url.endsWith('.ts')
}

/** How long after the last write in a burst the pages are told. */
export const SETTLE_MS = 150

/** What hears a folder change: `fs.watch`, or a test's stand-in for it. */
export type Watch = (
  dir: string,
  options: { persistent: false },
  heard: (event: string, file: string | null) => void,
) => FSWatcher

/** The folder this listener's own code is in, the away view's `src/`. */
export function serverDir(url: string = import.meta.url): string {
  return dirname(fileURLToPath(url))
}

/**
 * Whether a file that changed in `serverDir` is code the running server holds.
 *
 * Its routes and handlers are `.ts` beside this file; `assets/` is beside them
 * too, and is what is live-reloaded rather than what goes stale. A change the
 * OS could not name is not counted, because a page told to restart Tade for
 * nothing is a page whose bar is not believed the time it is true.
 */
export function isServerCode(file: string | null): boolean {
  return file?.endsWith('.ts') === true
}

/**
 * Watch a folder, and call `changed` once per burst of writes to it.
 *
 * Returns the way to stop. Never throws and never holds the process open: a
 * folder that cannot be watched is one that is not live-reloaded, which is
 * what an installed Tade is anyway.
 *
 * `on` is there for the test of the burst, because when the OS says a folder
 * changed is not ours to pace: on a loaded Mac with fseventsd at full CPU, a
 * plain `fs.watch` written to every 200 ms heard nothing in ten tries of 6–16 s.
 *
 * `only` narrows it to the files that count, by the name the OS gave.
 */
export function watchFolder(
  dir: string,
  changed: () => void,
  settle = SETTLE_MS,
  on: Watch = watch,
  only: (file: string | null) => boolean = () => true,
): () => void {
  let watcher: FSWatcher | null = null
  let pending: ReturnType<typeof setTimeout> | null = null
  try {
    watcher = on(dir, { persistent: false }, (_event, file) => {
      if (!only(file)) return
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

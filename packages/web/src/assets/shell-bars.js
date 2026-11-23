// The bars the shell itself raises about the page — not about the work: a copy
// this browser will not keep, the machine's code newer than what answers, the
// page's own files changed, and a new version ready. What each says, pure;
// `boot.js` holds the state that decides which are up and draws them with the
// rest of its bars.

import { NOT_SECURE } from './install.js'

/**
 * The shell's bars, in the order they stand.
 *
 * `standing` is what `boot.js` holds: why this browser kept no copy (`refused`,
 * null where it did), whether Tade runs older code than its own files
 * (`restart`), whether the page's files changed on the machine (`changed`),
 * and whether a new shell waits (`newer`). `does` is the two presses, so this
 * file reaches nothing itself.
 */
export function shellBars(standing, does) {
  const said = []
  if (standing.refused !== null) {
    // **The silent failure, said once.** A browser on a plain address over a
    // network refuses a worker, a cache and an install without a word, so a
    // person who turned this on at the machine sees nothing happen and has
    // nothing to go on. The clause for the fixable half is the domain's own.
    said.push({
      key: 'refused',
      tone: 'is-stale',
      glyph: '⚠',
      lead:
        standing.refused === 'insecure'
          ? 'This address cannot keep a copy of this page.'
          : 'This browser will not keep a copy of this page.',
      under:
        standing.refused === 'insecure'
          ? `Installing ${NOT_SECURE} one. Everything else here works as it is.`
          : 'Everything else here works exactly as it does now.',
    })
  }
  if (standing.restart) {
    // Said by a Tade running from its repository whose own code changed after
    // it started (`reloading.ts`): this page may be newer than what answers it.
    said.push({
      key: 'restart',
      tone: 'is-stale',
      glyph: '⚠',
      lead: 'Tade’s code changed since it started.',
      under: 'Parts of this page may not work until Tade is restarted at the machine.',
    })
  }
  if (standing.changed) {
    said.push({
      key: 'changed',
      tone: 'is-stale',
      glyph: '↻',
      lead: 'This page changed on the machine.',
      under: 'Nothing reloads while something is typed here. Reload when it is sent or kept.',
      press: { said: 'Reload', does: does.reload },
    })
  }
  // **A bar with a button and never a reload.** The page may be holding a note
  // somebody typed on a train, and there is no version of *we reloaded and
  // lost it* worth a fresher stylesheet — so the worker waits (`sw.js` never
  // calls `skipWaiting` on install), this says so, and the swap happens on a
  // press. The second line is the half people need before they dare press it.
  if (standing.newer) {
    said.push({
      key: 'update',
      tone: 'is-stale',
      glyph: '↑',
      lead: 'A new version of this page is ready.',
      under: 'Nothing reloads until you tap. Anything you have typed stays where it is.',
      press: { said: 'Reload', does: does.update },
    })
  }
  return said
}

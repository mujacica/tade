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
 * (`restart`) and where pressing to restart it stands (`restarting`, from
 * `restart.js`), whether the page's files changed on the machine (`changed`),
 * and whether a new shell waits (`newer`). `does` is the three presses, so
 * this file reaches nothing itself.
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
  if (standing.restart) said.push(restartBar(standing.restarting ?? NOT_ASKED, does.restart))
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

/** A restart nobody has pressed, on a device that may not ask for one. */
const NOT_ASKED = {
  theirs: false,
  stops: 0,
  armed: false,
  busy: false,
  going: false,
  said: null,
  cannot: false,
}

/**
 * Tade's code changed since it started — said by a Tade running from its
 * repository (`reloading.ts`), so this page may be newer than what answers it.
 *
 * **A paired device restarts it from here** (`POST /api/restart`,
 * `restart.js` holds the press): one press where nothing would stop, and where
 * lanes run inside the window and would, the machine answers how many and the
 * second press is on that number — the window's reload panel, asked from
 * away. A device paired in the clear, which never acts, is told who can. Each state is its own key, because
 * a bar keeps its press until its key changes (`barsIn`).
 */
function restartBar(asked, restart) {
  const base = { tone: 'is-stale', glyph: '⚠', lead: 'Tade’s code changed since it started.' }
  if (asked.going) {
    return {
      key: 'restart-going',
      tone: 'is-stale',
      glyph: '↻',
      lead: 'Tade is starting again.',
      under: 'This page reconnects by itself when it is back. Agents reopen where they were.',
    }
  }
  if (!asked.theirs) {
    return {
      ...base,
      key: 'restart',
      under:
        'Parts of this page may not work until Tade is restarted — at the machine, or from a device paired over https.',
    }
  }
  if (asked.busy) {
    return { ...base, key: 'restart-busy', under: 'Asking the machine to start Tade again.' }
  }
  if (asked.said !== null) {
    return {
      ...base,
      key: 'restart-said',
      under: asked.said,
      // Where Tade cannot start itself again, pressing again would not either.
      ...(asked.cannot ? {} : { press: { said: 'Try again', does: restart } }),
    }
  }
  if (asked.armed) {
    const n = asked.stops
    return {
      ...base,
      key: 'restart-armed',
      lead: `Restarting stops ${n} lane${n === 1 ? '' : 's'} running inside Tade.`,
      under: 'They reopen where they were once Tade is back. Press again to restart anyway.',
      press: { said: 'Restart anyway', does: restart },
    }
  }
  return {
    ...base,
    key: 'restart',
    under: 'Parts of this page may not work until Tade starts again on its new code.',
    press: { said: 'Restart Tade', does: restart },
  }
}

// What went wrong, in a few words, and the one thing to do about it.
//
// **The page's own words, keyed by the refusal's kind** (`src/errors.ts`'s
// `error`), never the body it came in: an answer that is not Tade's — a proxy's
// page, a dropped connection, a kind this page does not know — is drawn as the
// one line this page has for *it cannot tell*, so nothing a server or a network
// in between wrote ever reaches the page. Pure: no `document`, so every kind is
// a line of a test rather than something somebody has to make happen.
//
// **Two parts and no paragraph**: `title` says what happened, `fix` what to do,
// each a few words; `ui.js`'s `problemIn` draws them red, with an icon, as one
// component everywhere a press or a read failed.

/** Each refusal Tade answers with, as what happened and what to do. */
export const TROUBLES = {
  offline: { title: 'Can’t reach Tade', fix: 'Is the machine asleep, or Tade closed?' },
  malformed: { title: 'Request refused', fix: 'Reload this page' },
  no_session: { title: 'Signed out', fix: 'Pair this device again' },
  bad_origin: { title: 'Request refused', fix: 'Reload this page' },
  out_of_scope: { title: 'Not granted', fix: 'Grant it at the machine' },
  locked: { title: 'Turned off', fix: 'Turn it on at the machine' },
  stale: { title: 'Screen was old', fix: 'Refreshed — try again' },
  gone: { title: 'Changed meanwhile', fix: 'Look again, then retry' },
  reused: { title: 'Already used', fix: 'Try again' },
  unsure: { title: 'Couldn’t confirm', fix: 'Check before trying again' },
  no_such: { title: 'Not found', fix: 'It may have finished or gone' },
  not_offered: { title: 'Not found', fix: 'It may have finished or gone' },
  too_big: { title: 'Too long', fix: 'Shorten it and send again' },
  slow_down: { title: 'Too many tries', fix: 'Wait a moment' },
  closing: { title: 'Tade is closing', fix: 'Open it again at the machine' },
  busy: { title: 'Tade is busy', fix: 'Try again shortly' },
  broke: { title: 'Something broke', fix: 'Try again' },
}

/** What an answer this page cannot read is drawn as. */
export const UNKNOWN_TROUBLE = { title: 'Something went wrong', fix: 'Try again' }

/**
 * Pairing's own words for the same kinds: a code is the thing that failed, so
 * *signed out* is the wrong news. Every check at the door answers one kind on
 * purpose (`errors.ts`), so expired, used and refused are one line here too.
 */
const PAIRING = {
  no_session: { title: 'Code expired', fix: 'Get a new one in Tade’s window' },
  bad_origin: { title: 'Code not accepted', fix: 'Get a new one in Tade’s window' },
  slow_down: { title: 'Too many tries', fix: 'Wait a moment, then a new code' },
}

/**
 * What went wrong with an answer, or null for one that did not.
 *
 * `answer` is `ask`'s: `status` 0 for nothing came back at all, and `body` the
 * parsed JSON or null. `where` is `pair` for pairing's words, anything else for
 * the rest.
 */
export function troubleOf(answer, where = '') {
  if (answer === null || answer === undefined) return TROUBLES.offline
  if (answer.status >= 200 && answer.status < 300) return null
  if (answer.status === 0) return TROUBLES.offline
  const kind = typeof answer.body?.error === 'string' ? answer.body.error : null
  if (kind === null) return UNKNOWN_TROUBLE
  if (where === 'pair' && Object.hasOwn(PAIRING, kind)) return PAIRING[kind]
  return Object.hasOwn(TROUBLES, kind) ? TROUBLES[kind] : UNKNOWN_TROUBLE
}

/** One line of it, for a toast or a screen reader: `Code expired · Get a new one`. */
export function troubleSaid(trouble) {
  return `${trouble.title} · ${trouble.fix}`
}

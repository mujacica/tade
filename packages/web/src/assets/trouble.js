// What went wrong, in a few words, why, and what to do about it.
//
// **The page's own words, keyed by the refusal's kind** (`src/errors.ts`'s
// `error`), never the body it came in: an answer that is not Tade's — a proxy's
// page, a dropped connection, a kind this page does not know — is drawn as the
// one line this page has for *it cannot tell*, so nothing a server or a network
// in between wrote ever reaches the page. The one thing read out of a body
// besides its kind is `needs`, and only the names this file knows (`NAMES`):
// `https`. Pure: no `document`, so every kind is
// a line of a test rather than something somebody has to make happen.
//
// **Four parts and no paragraph**: `title` says what happened, `why` its cause
// in one sentence, `fix` the thing to do in a few words, and `steps` the
// small *how to fix this* list — where to click at the machine, the command to
// run, or what to pair — in the order they are done; `fix` is the line a toast
// says. Every one of them is
// something the person does themselves. `ui.js`'s `problemIn` and
// `stateBoxIn` draw them red, with an icon, as one component everywhere a
// press or a read failed.

/** Where the away view is set up and a code is shown, in the window's own words. */
export const AWAY_PLACE = 'Settings › Away view'

/** Every name a refusal's `needs` may carry that this page will draw. */
const NAMES = new Set(['https'])

/** The steps a new pairing is, from the machine's own screen or its shell. */
const PAIR_STEPS = [
  `At the machine, open ${AWAY_PLACE}`,
  'Scan its code here, or open its link',
  'No screen there? Run `tade web pair` and open its link',
]

/** Each refusal Tade answers with, as what happened, why, and what to do. */
export const TROUBLES = {
  offline: {
    title: 'Can’t reach Tade',
    why: 'Nothing answered from the machine.',
    fix: 'Wake the machine, or open Tade',
    steps: [
      'Wake the machine, or open Tade',
      'Run `tade app` there, or `tade serve` on a server',
      'Check this device is on the same network or tailnet',
    ],
  },
  malformed: {
    title: 'Request refused',
    why: 'Tade could not read what this page sent.',
    fix: 'Reload this page',
    steps: ['Reload this page', 'Still refused? Restart Tade at the machine'],
  },
  no_session: {
    title: 'Signed out',
    why: 'This device’s session ran out or was signed out.',
    fix: 'Pair this device again',
    steps: PAIR_STEPS,
  },
  bad_origin: {
    title: 'Link refused',
    why: 'This address is not the one this device was paired on.',
    fix: 'Reload this page',
    steps: [
      'Reload this page',
      'Open Tade by the address you paired on',
      `Pairing on a new address? ${AWAY_PLACE} at the machine`,
    ],
  },
  out_of_scope: {
    title: 'Refused',
    why: 'Tade would not do that for this device.',
    fix: 'Pair this device again',
    steps: PAIR_STEPS,
  },
  locked: {
    title: 'Turned off',
    why: 'That is switched off in Tade’s settings.',
    fix: 'Turn it on at the machine',
    steps: ['Turn it on at the machine', `Open ${AWAY_PLACE} and switch it on`],
  },
  unproven: {
    title: 'Passkey needed',
    why: 'Acting over the internet needs this device’s passkey, used lately.',
    fix: 'Press Use passkey at the top',
    steps: ['Press Use passkey at the top', 'No passkey yet? Pair again, then make one when asked'],
  },
  stale: {
    title: 'Screen was old',
    why: 'The page was behind the machine when you pressed.',
    fix: 'Refreshed — try again',
    steps: ['Refreshed — try again'],
  },
  gone: {
    title: 'Changed meanwhile',
    why: 'Something moved on the machine while you looked.',
    fix: 'Look again, then retry',
    steps: ['Look again, then retry'],
  },
  reused: {
    title: 'Already used',
    why: 'That press was already used for something else.',
    fix: 'Try again',
    steps: ['Try again', 'Still refused? Reload this page'],
  },
  unsure: {
    title: 'Couldn’t confirm',
    why: 'Tade stopped before saying whether it happened.',
    fix: 'Check before trying again',
    steps: ['Check before trying again', 'Look at the task, then press again only if needed'],
  },
  no_such: {
    title: 'Not found',
    why: 'Nothing by that name is on the machine now.',
    fix: 'It may have finished or gone',
    steps: ['It may have finished or gone', 'Go back and look again'],
  },
  not_offered: {
    title: 'Not found',
    why: 'Nothing by that name is on the machine now.',
    fix: 'It may have finished or gone',
    steps: ['It may have finished or gone', 'Go back and look again'],
  },
  too_big: {
    title: 'Too long',
    why: 'That was more than Tade takes in one go.',
    fix: 'Shorten it and send again',
    steps: ['Shorten it and send again'],
  },
  slow_down: {
    title: 'Too many tries',
    why: 'Tade is holding off this device for a moment.',
    fix: 'Wait a moment',
    steps: ['Wait a moment', 'Then try once'],
  },
  closing: {
    title: 'Tade is closing',
    why: 'The window at the machine is shutting down.',
    fix: 'Open it again at the machine',
    steps: ['Open it again at the machine', 'Run `tade app`, or `tade serve` on a server'],
  },
  busy: {
    title: 'Tade is busy',
    why: 'Too many pages are connected right now.',
    fix: 'Try again shortly',
    steps: ['Try again shortly', 'Close this page’s other tabs'],
  },
  starting: {
    title: 'Still starting',
    why: 'The orchestrator at the machine is not up yet.',
    fix: 'Try again shortly',
    steps: ['Try again shortly'],
  },
  broke: {
    title: 'Something broke',
    why: 'Tade hit an error and wrote it in its log.',
    fix: 'Try again',
    steps: ['Try again', 'Still broken? Run `tade logs` at the machine'],
  },
}

/**
 * A feature the Tade answering is older than: the page knows the route, and a
 * device that may use it was told there is nothing there. Never a refusal on
 * the wire — the page decides it (`tooOld`), because an older Tade cannot say.
 */
export const TOO_OLD = {
  title: 'Tade is too old',
  why: 'The Tade answering started before this feature existed.',
  fix: 'Restart Tade at the machine',
  steps: [
    'Restart Tade at the machine',
    'Quit its window, then run `tade app`',
    'On a server: `tade update`, then restart its service',
  ],
}

/** What an answer this page cannot read is drawn as. */
export const UNKNOWN_TROUBLE = {
  title: 'Something went wrong',
  why: 'The answer was not one Tade gives.',
  fix: 'Try again',
  steps: ['Try again', 'Still wrong? Reload this page'],
}

/**
 * Pairing's own words for the same kinds: a code is the thing that failed, so
 * *signed out* is the wrong news. Every check at the door answers one kind on
 * purpose (`errors.ts`), so expired, used and refused are one line here too.
 */
const PAIRING = {
  no_session: {
    title: 'Code expired',
    why: 'A code lasts minutes and works once.',
    fix: 'Get a new one in Tade’s window',
    steps: PAIR_STEPS,
  },
  bad_origin: {
    title: 'Code not accepted',
    why: 'The code was used, ran out, or names another address.',
    fix: 'Get a new one in Tade’s window',
    steps: PAIR_STEPS,
  },
  slow_down: {
    title: 'Too many tries',
    why: 'This address tried to pair too often.',
    fix: 'Wait a moment, then a new code',
    steps: ['Wait a moment', ...PAIR_STEPS],
  },
}

/** The names a body's `needs` carries that this page knows, and nothing else. */
export function needsOf(body) {
  const needs = Array.isArray(body?.needs) ? body.needs : []
  return needs.filter((one) => typeof one === 'string' && NAMES.has(one))
}

/** Locked: a setting turned off, or acting over a connection that is not trusted. */
function lockedOf(needs) {
  if (!needs.includes('https')) return TROUBLES.locked
  return {
    title: 'Needs https',
    why: 'Acting is refused over a connection that is not encrypted.',
    fix: 'Open Tade by its https name',
    steps: [
      'Open Tade by its https name',
      'Use its public name, or `tailscale serve`',
      `Pair again there from ${AWAY_PLACE}`,
    ],
  }
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
  if (kind === 'locked') return lockedOf(needsOf(answer.body))
  return Object.hasOwn(TROUBLES, kind) ? TROUBLES[kind] : UNKNOWN_TROUBLE
}

/**
 * A route a Tade too old to have it answers as nothing there — the Machines
 * page, the accounts, the restart — refused. Every paired device is the
 * person's own and is answered every such route, so `no_such` from one is a
 * Tade started before the route was built (it answers every path it does not
 * know that way). Everything else is `troubleOf`'s.
 */
export function theirsTrouble(answer) {
  const kind = answer?.body?.error
  if (kind === 'no_such' || kind === 'not_offered') return TOO_OLD
  return troubleOf(answer)
}

/** One line of it, for a toast or a screen reader: `Code expired · Get a new one`. */
export function troubleSaid(trouble) {
  return `${trouble.title} · ${trouble.fix}`
}

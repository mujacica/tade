// What went wrong, in a few words, why, and what to do about it.
//
// **The page's own words, keyed by the refusal's kind** (`src/errors.ts`'s
// `error`), never the body it came in: an answer that is not Tade's — a proxy's
// page, a dropped connection, a kind this page does not know — is drawn as the
// one line this page has for *it cannot tell*, so nothing a server or a network
// in between wrote ever reaches the page. The one thing read out of a body
// besides its kind is `needs`, and only the names this file knows (`NAMES`):
// which boxes a device lacks, or `https`. Pure: no `document`, so every kind is
// a line of a test rather than something somebody has to make happen.
//
// **Four parts and no paragraph**: `title` says what happened, `why` its cause
// in one sentence, `fix` the thing to do in a few words, and `steps` the
// small *how to fix this* list — where to click at the machine, the command to
// run, or what to pair — in the order they are done; `fix` is the line a toast
// says. Every one of them is
// something the person does themselves: the page never says "not granted"
// without saying which box and where it is. `ui.js`'s `problemIn` and
// `stateBoxIn` draw them red, with an icon, as one component everywhere a
// press or a read failed.

/** Where every grant is ticked, in the window's own words (`AWAY_LABELS`). */
export const AWAY_PLACE = 'Settings › Away view'

/** Each scope and reading grant, as the box in the window that gives it (`BOXES`, `AWAY_LABELS`). */
const BOX_OF = {
  answer: 'answer & steer',
  steer: 'answer & steer',
  agents: 'stop agents',
  projects: 'close projects',
  ask: 'talk to Tade',
  talk: 'talk to Tade',
  configure: 'change settings',
  lanes: 'see screens',
  settings: 'read settings',
}

/** Every scope and reading grant (`SCOPES`, `GRANTS`), held equal by `trouble-client.test.ts`. */
export const SCOPE_NAMES = [
  'read',
  'answer',
  'steer',
  'ask',
  'draft',
  'agents',
  'projects',
  'configure',
]
export const GRANT_NAMES = [
  'titles',
  'intent',
  'notes',
  'findings',
  'spend',
  'reviews',
  'accounts',
  'talk',
  'requests',
  'material',
  'workflows',
  'lanes',
  'settings',
]

/** Every name a refusal's `needs` may carry that this page will draw. */
const NAMES = new Set([...SCOPE_NAMES, ...GRANT_NAMES, 'https'])

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
    title: 'Not granted',
    why: 'This device was not given that at the machine.',
    fix: 'Grant it at the machine',
    steps: [
      `At the machine, open ${AWAY_PLACE}`,
      'Choose this device in its devices',
      'Tick the box it needs, or full access',
    ],
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

/**
 * The boxes in the window that give what is missing: one each where the window
 * has one, `full access` where any of it has none — or where it is everything.
 */
export function boxesFor(needs) {
  const missing = needs.filter((one) => one !== 'https')
  if (missing.length === 0) return []
  if (missing.some((one) => BOX_OF[one] === undefined)) return ['full access']
  return [...new Set(missing.map((one) => BOX_OF[one]))]
}

/** A device, as the steps name it: its own label where the page knows it. */
function deviceSaid(you) {
  const label = typeof you?.label === 'string' ? you.label.trim() : ''
  return label === '' ? 'this device' : `“${label}”`
}

/** `a`, `a and b`, `a, b and c`. */
function listSaid(names) {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Out of scope, with the exact boxes and where they are. */
function notGranted(needs, you) {
  const boxes = boxesFor(needs)
  if (boxes.length === 0) return TROUBLES.out_of_scope
  const ticks = listSaid(boxes)
  // Every name it lacks where there are a few; past that the box says it.
  const lacks = needs.length <= 3 ? listSaid(needs) : `full access (${needs.length} boxes)`
  return {
    title: 'Not granted',
    why: `This device lacks ${lacks}.`,
    fix: `Tick ${ticks} at the machine`,
    steps: [
      `At the machine, open ${AWAY_PLACE}`,
      `Choose ${deviceSaid(you)} in its devices`,
      `Tick ${ticks}; it applies at once`,
    ],
  }
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
 * the rest. `you` is the session the page holds (`ctx.session()`), for the
 * device's own name in a step; absent, the steps say *this device*.
 */
export function troubleOf(answer, where = '', you = null) {
  if (answer === null || answer === undefined) return TROUBLES.offline
  if (answer.status >= 200 && answer.status < 300) return null
  if (answer.status === 0) return TROUBLES.offline
  const kind = typeof answer.body?.error === 'string' ? answer.body.error : null
  if (kind === null) return UNKNOWN_TROUBLE
  if (where === 'pair' && Object.hasOwn(PAIRING, kind)) return PAIRING[kind]
  if (kind === 'out_of_scope') return notGranted(needsOf(answer.body), you)
  if (kind === 'locked') return lockedOf(needsOf(answer.body))
  return Object.hasOwn(TROUBLES, kind) ? TROUBLES[kind] : UNKNOWN_TROUBLE
}

/** Whether a session has every scope and every reading grant: the person's own device. */
export function fullAccessOf(you) {
  const scopes = Array.isArray(you?.scopes) ? you.scopes : []
  const reads = Array.isArray(you?.reads) ? you.reads : []
  return (
    SCOPE_NAMES.every((one) => scopes.includes(one)) &&
    GRANT_NAMES.every((one) => reads.includes(one))
  )
}

/** What a session lacks of full access, by name: the scopes, then the grants. */
export function fullAccessLacks(you) {
  const scopes = Array.isArray(you?.scopes) ? you.scopes : []
  const reads = Array.isArray(you?.reads) ? you.reads : []
  return [
    ...SCOPE_NAMES.filter((one) => !scopes.includes(one)),
    ...GRANT_NAMES.filter((one) => !reads.includes(one)),
  ]
}

/**
 * A route only the person's own device is answered — the Machines page —
 * refused: told apart by what the page knows of its own session.
 *
 * `no_such` from a device with full access is a Tade too old to have the
 * route (one started before it was built answers every path it does not know
 * that way); from any other device it is the door refusing one that is not
 * theirs, which off this machine's door is a `404` on purpose — so the page
 * names the boxes it lacks, out of its own session. `out_of_scope` names them
 * out of the body. Everything else is `troubleOf`'s.
 */
export function theirsTrouble(answer, you) {
  const kind = answer?.body?.error
  if (kind === 'no_such' || kind === 'not_offered') {
    return fullAccessOf(you) ? TOO_OLD : notGranted(fullAccessLacks(you), you)
  }
  if (kind === 'out_of_scope') {
    const needs = needsOf(answer.body)
    return notGranted(needs.length > 0 ? needs : fullAccessLacks(you), you)
  }
  return troubleOf(answer, '', you)
}

/** One line of it, for a toast or a screen reader: `Code expired · Get a new one`. */
export function troubleSaid(trouble) {
  return `${trouble.title} · ${trouble.fix}`
}

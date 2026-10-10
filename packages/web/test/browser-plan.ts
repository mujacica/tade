import { ROUTES } from '../src/routes.ts'

// What a real browser is asked, and how a run of it is reported.
//
// **Pure, and that is the point.** The offline suite cannot drive a browser, so
// what it holds instead is this: that the plan covers every screen the server
// serves, that 360px is in it, and — the one that matters — that **a run with no
// browser on the machine reports every check as `unrun`, with a reason, and the
// word `pass` appears nowhere in it.**
//
// A missing browser must never read as a passing suite. That is the whole
// failure mode this file exists to make impossible: an a11y harness that
// silently did nothing is worse than none, because the badge says otherwise.
//
// `scripts/browser.ts` is what runs it. Nothing here imports a browser, a test
// runner or a `node:` module.

/** One width, and what the layout is meant to do at it. */
export interface Width {
  name: string
  width: number
  height: number
  /** The one width where sideways scrolling is a failure rather than a table. */
  narrow?: true
}

/**
 * Three widths, content-driven like the breakpoints themselves.
 *
 * 360 is the floor the brief names and the one a phone in a case actually has;
 * 834 is a tablet in portrait, which is where the glyph rail has to work; 1440
 * is a laptop, where the rail gains its names.
 */
export const WIDTHS: readonly Width[] = [
  { name: 'phone', width: 360, height: 780, narrow: true },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desk', width: 1440, height: 900 },
]

/** One screen to look at: the real path, and a name for a file and a report. */
export interface Look {
  path: string
  name: string
}

/**
 * One parameter per name the fixtures actually use.
 *
 * A table rather than a chain of replacements, so a route with a parameter
 * nobody filled in fails the test that no path still has a `:` in it — which
 * is what stops a new screen being looked at as `/r/:run` and reported green
 * because the page drew its *nothing here* state.
 */
const NAMES: Readonly<Record<string, string>> = {
  ':project': 'sentry',
  ':task': 'away-projection',
  ':source': 'github',
  ':id': '1402',
  ':run': 'shop-1402',
  ':name': 'reproduce-and-fix',
}

function filled(path: string): string {
  return path
    .split('/')
    .map((part) => NAMES[part] ?? part)
    .join('/')
}

/**
 * Every screen, as **the real path the server serves it at**.
 *
 * Built from the route table rather than written out, so a screen added to the
 * server and not to this list is impossible. A parameter is filled with the
 * names the projection fixtures actually use, so the project and task screens
 * are looked at with something on them rather than empty.
 */
export const LOOKS: readonly Look[] = ROUTES.filter((route) => route.document === true).map(
  (route) => ({ path: filled(route.path), name: route.name.replace(/\s+/g, '-') }),
)

/** What a check came to. `unrun` is a first-class answer and never a pass. */
export type Verdict = 'pass' | 'fail' | 'unrun'

export interface Finding {
  /** What was asked, in a word: `axe`, `landmarks`, `sideways`, `targets`. */
  check: string
  /** Which screen and which width, or `—` for a check about the whole run. */
  where: string
  verdict: Verdict
  /** What happened, in a sentence. For `unrun`, **why** it could not be asked. */
  said: string
}

/** The checks a full run makes, named so an `unrun` report can list them all. */
export const CHECKS = [
  'pairing',
  'landmarks',
  'axe',
  'sideways',
  'targets',
  'titles',
  'honesty',
  'granted',
  'quiet',
  'delta',
  // The three a control owns, and none of them is answerable offline. A tap is
  // a real pointer on a real target; a keyboard is a real Tab order and a real
  // Enter on a `<button>`; and what somebody typed surviving a refusal is a
  // real `fetch` coming back `409` while a `<textarea>` still holds its value.
  'controls',
  'touch',
  'typing',
  // The three an installed shell owns. `install` is a real registration in a
  // real browser; `offline-cold` is a deep link opened with the network off,
  // which is the whole point of the thing; `no-api-cache` enumerates every
  // cache on the device afterwards and is the claim most able to break
  // quietly. An upgrade, a rollback and an uninstall are **not** here: each
  // means different bytes at the same URL, and a listener reads its files once
  // — so a harness would need a second origin, and a second origin is a
  // different registration. `test/worker.test.ts` runs all three properly.
  'install',
  'offline-cold',
  'no-api-cache',
] as const

/**
 * Sentences a page may not say to a device that was granted nothing.
 *
 * The bug this catches has turned up three times already in one slice, in
 * three different regions: a field is null because this device may not read
 * it, and the page draws the sentence it keeps for *nobody wrote it down*. The
 * two are different facts, and the second blames the work for the reader's own
 * read scope. The harness pairs a device granted nothing, so **any of these on
 * any screen is that bug**.
 */
export const NOT_FOR_A_GRANTED_DEVICE = ['not granted']

/**
 * Sentences a page may not say to a device that **was** granted the content.
 *
 * The same bug from the other side, and the reason the harness pairs twice: a
 * device granted nothing renders every figure as a dash, so the page with
 * actual money, notes and sign-ins on it — the one the owner will look at —
 * would otherwise never have been laid out in a browser at all, and neither
 * axe nor the tap targets nor the 360px overflow would have been asked about
 * it.
 */
export const NOT_FOR_A_DEVICE_GRANTED_NOTHING = [
  'not recorded',
  'reported no money',
  'nobody wrote down',
  'no harness was written down',
]

/**
 * The steps nothing in this repository can take, written down so that a green
 * run is not read as more than it is.
 *
 * **A browser emulating a phone is not a phone.** Headless Chromium at 360px
 * registers a worker and loads offline, and none of that is evidence about
 * Safari's *Add to Home Screen*, about which icon iOS actually picks, about
 * what an installed window looks like with a notch in it, or about what
 * happens to a shell on a phone that has been in a drawer for a fortnight.
 * Those are a person's, and the honest thing is to say which rather than to
 * let the report imply they were covered.
 *
 * Printed at the end of every report, pass or fail, and counted as nothing:
 * `worstOf` never sees them.
 */
export const MANUAL: readonly string[] = [
  'On a real iPhone, over the https name (tailscale serve, or a proxy named in Trusted hostnames): Share → Add to Home Screen. The icon should be the amber mark on the dark ground, not a screenshot of the page.',
  'Open it from the home screen. It should have no Safari address bar, and the status bar should be dark rather than white.',
  'Pair it there. A device paired on localhost has no session on the https name — that is the host binding working, not a bug.',
  'Turn the phone to airplane mode and open it again. It should draw the page and say it cannot reach the machine; with Let a device keep what it last saw on, it should say when it last could and what it then knew.',
  'Turn Let a device install it off at the machine, restart Tade, and open the phone once with a signal. The app should stop working offline from then on — a 404 would not have done that.',
  'Sign the device out, then look at Settings → Safari → Advanced → Website Data for the origin. What is left should be the page and nothing of the work.',
  // **Notifications, and every step of this one is a person's.** Nothing
  // offline can deliver a push: it needs a VAPID key of the owner's, a real
  // push service's cooperation and a permission only somebody holding the
  // phone can grant. `push-out.test.ts` checks the protocol against
  // `node:crypto` and `web-push.test.ts` checks the wiring against a push
  // service that is not one; what is left is whether Apple accepts it, which
  // is this.
  'Turn Send notifications to a device on at the machine. On the installed app, Devices → NOTIFICATIONS → Tell this device. iOS should raise its own permission prompt — in Safari’s tab rather than the installed app it should not, and the page should say so instead of looking broken.',
  'Lock the phone and make something want you: start an agent on a task whose tools need approving. One notification should arrive, saying how many pieces of work want you and naming nothing — no project, no task, no title.',
  'Turn Let a notification name the work on at the machine, grant that device what work is called, and do it again. The name should appear; with either half off, it should not.',
  'Tap the notification. It should open the app where it was, not a new window and not the root of a browser.',
  'Close Tade and make something else happen. Nothing should arrive — there is no background service, and nothing is caught up when the window comes back.',
  'Sign the device out at the machine and make something happen. Nothing should arrive, with the phone never asked anything.',
]

/**
 * Every check, unrun, with one reason — what a machine with no browser reports.
 *
 * One row per check rather than one line saying "skipped", because a report
 * that lists what it did not do is one somebody can act on, and a single
 * skipped line is one nobody reads.
 */
export function allUnrun(why: string): Finding[] {
  return CHECKS.map((check) => ({ check, where: '—', verdict: 'unrun' as const, said: why }))
}

/** The worst thing in a report, which is what an exit code is made of. */
export function worstOf(findings: readonly Finding[]): Verdict {
  if (findings.some((one) => one.verdict === 'fail')) return 'fail'
  if (findings.length === 0 || findings.every((one) => one.verdict === 'unrun')) return 'unrun'
  return findings.some((one) => one.verdict === 'unrun') ? 'unrun' : 'pass'
}

/**
 * The report, as text.
 *
 * The check column is as wide as the longest name there is, so a row does not
 * push the ones beside it out of line — a report somebody skims is one whose
 * columns line up.
 *
 * The last line is the one somebody reads, and it says `unrun` where anything
 * was — never `pass` with a footnote, because a footnote is what gets quoted
 * as a green run.
 */
export function sayReport(findings: readonly Finding[]): string {
  const rows = findings.map(
    (one) =>
      `  ${one.verdict.padEnd(6)} ${one.check.padEnd(12)} ${one.where.padEnd(28)} ${one.said}`,
  )
  const worst = worstOf(findings)
  const counts = (['pass', 'fail', 'unrun'] as const)
    .map((verdict) => `${findings.filter((one) => one.verdict === verdict).length} ${verdict}`)
    .join(' · ')
  return [
    'the away view, in a real browser',
    ...rows,
    '',
    // **Not findings, and never counted as any.** A browser emulating a phone
    // is not a phone, and the report says which steps are still somebody's.
    'asked of a person, not of this harness:',
    ...MANUAL.map((step) => `  · ${step}`),
    '',
    `${counts}`,
    worst === 'unrun'
      ? 'UNRUN — something could not be asked, so this is not a pass'
      : worst === 'fail'
        ? 'FAILED'
        : 'PASSED',
  ].join('\n')
}

/** `0` for a pass, `1` for a failure, `2` for a run that could not be made. */
export function exitFor(worst: Verdict): number {
  return worst === 'pass' ? 0 : worst === 'fail' ? 1 : 2
}

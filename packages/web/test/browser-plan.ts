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
 * Every screen, as **the real path the server serves it at**.
 *
 * Built from the route table rather than written out, so a screen added to the
 * server and not to this list is impossible. A parameter is filled with the
 * names the projection fixtures actually use, so the project and task screens
 * are looked at with something on them rather than empty.
 */
export const LOOKS: readonly Look[] = ROUTES.filter((route) => route.document === true).map(
  (route) => ({
    path: route.path.replace(':project', 'sentry').replace(':task', 'away-projection'),
    name: route.name.replace(/\s+/g, '-'),
  }),
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
 * The last line is the one somebody reads, and it says `unrun` where anything
 * was — never `pass` with a footnote, because a footnote is what gets quoted
 * as a green run.
 */
export function sayReport(findings: readonly Finding[]): string {
  const rows = findings.map(
    (one) =>
      `  ${one.verdict.padEnd(6)} ${one.check.padEnd(10)} ${one.where.padEnd(28)} ${one.said}`,
  )
  const worst = worstOf(findings)
  const counts = (['pass', 'fail', 'unrun'] as const)
    .map((verdict) => `${findings.filter((one) => one.verdict === verdict).length} ${verdict}`)
    .join(' · ')
  return [
    'the away view, in a real browser',
    ...rows,
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

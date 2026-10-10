// What the page offers on one task, and what it sends — the decisions, pure.
//
// **Its own file, and the split is the point.** Everything here is a function
// of a row and this device's scopes: which controls to draw, what each one
// sends, and what to do with the answer. `screens.js` turns these into nodes
// and listeners. That is what makes the page's own rules testable at all —
// there is no DOM in this repository's `lib` and no jsdom in its lockfile, so
// a rule that lived inside a listener could only be checked in a real browser
// (`scripts/browser.ts`), and that harness is `unrun` on a machine with none.
//
// The three rules that break things quietly:
//
// - **A control nothing could carry out is absent, never disabled.** The row
//   says what may be asked of it and what may not with the reason (`can`,
//   `cannot`), so a harness that cannot take a message, an agent that is not
//   running and work that is already finished each turn a control off *and*
//   say why. A disabled button invites a tap and then says nothing.
// - **What was typed survives a refusal.** A `409` is the world having moved,
//   not a reason to throw somebody's paragraph away: only a `200` clears a
//   box. That is one line (`afterAnswer`) and it is the line somebody would
//   write the other way round.
// - **The scope is a drawing hint and never an authority.** It is the scopes
//   on this device's own session; the machine re-asks the setting, the origin,
//   the project and the state at the act. A page that lied here would get a
//   `403`, which is the right way round.

/** The verbs this page draws a control for, in the order they are drawn. */
export const SHOWN = ['answer', 'steer', 'queue', 'done', 'note', 'context', 'intake', 'park']

/**
 * The scope each verb needs, as the page's copy of `VERBS`.
 *
 * Two copies of one rule, for the reason `live.js` and `glyphs.js` have two:
 * a browser cannot import a `.ts` file and there is no build step.
 * `test/acts-client.test.ts` runs the verb table through both and asserts they
 * agree, so a verb filed at another tier makes the test fail rather than
 * making the page draw a button that is refused.
 */
export const NEEDS = {
  park: 'steer',
  answer: 'answer',
  steer: 'steer',
  queue: 'steer',
  done: 'steer',
  note: 'steer',
  context: 'steer',
  intake: 'answer',
}

/**
 * What the queue control offers, and the word on each.
 *
 * `starts` marks the two that only make sense for work that could actually
 * start: parked work is not startable queued work, so offering them on a
 * parked row is a tap that can only be refused. The machine refuses it too
 * (`refuseParked` is the rule) — this is the page not asking.
 */
export const QUEUE_ASKS = [
  { change: 'pause', said: 'Pause' },
  { change: 'resume', said: 'Resume' },
  { change: 'start', said: 'Start when there is room', starts: true },
  { change: 'wait', said: 'Wait again' },
  { change: 'first', said: 'Do this first', starts: true },
]

/** The queue choices worth offering on this row. */
export function asksFor(row) {
  return row?.parked === true ? QUEUE_ASKS.filter((one) => one.starts !== true) : QUEUE_ASKS
}

/**
 * Which scopes this device's own session carries.
 *
 * Out of `/api/devices`, which is the same record the machine re-checks. A
 * device that was granted nothing has every control **absent** rather than
 * present and refused.
 */
export function actsOf(session) {
  const scopes = session === null || session === undefined ? [] : (session.scopes ?? [])
  const has = (scope) => Array.isArray(scopes) && scopes.includes(scope)
  return { answer: has('answer'), steer: has('steer') }
}

/**
 * One verb's standing on one row: whether to draw it, and what to say.
 *
 * Three answers and not two, because the third is the one a person acts on:
 *
 * - `off` — this device was not granted the scope. **Nothing is drawn**, not
 *   even a reason: a sentence naming a scope somebody does not have is a map
 *   of what else there is to ask for.
 * - `no` — it was granted, and the thing is not possible. The control is
 *   absent and the row's own `why` is drawn, because *this harness has no way
 *   to take a message mid-turn* is a sentence somebody wrote and an absence is
 *   not.
 * - `yes` — drawn, with `how` beside it where it would not happen now.
 */
export function standingOf(verb, row, acts) {
  const needs = NEEDS[verb]
  if (needs === undefined || acts[needs] !== true) return { kind: 'off', why: '' }
  const can = (row?.can ?? []).find((one) => one.verb === verb)
  if (can !== undefined) return { kind: 'yes', how: can.how ?? 'now', why: '' }
  const cannot = (row?.cannot ?? []).find((one) => one.verb === verb)
  return { kind: 'no', why: cannot?.why ?? '' }
}

/**
 * Every verb's standing on one row, in the order the page draws them.
 *
 * One pass, so a screen cannot ask about one verb and forget another: the page
 * walks this and the list is `SHOWN`.
 */
export function controlsFor(row, acts) {
  return SHOWN.map((verb) => ({ verb, ...standingOf(verb, row, acts) }))
}

/**
 * What one act sends: the four fields every verb carries, plus its own.
 *
 * `was` is the row's own revision — **what the screen said, echoed back** — so
 * an act against a world that has moved is a `409` that redraws the truth
 * rather than a button that undoes somebody's decision. The key is the
 * caller's, minted once per press and kept across a retry.
 */
export function bodyFor(verb, row, key, rev, typed) {
  const every = { task: row.id, was: row.rev, key, rev }
  switch (verb) {
    case 'park':
      return { ...every, parked: !row.parked }
    case 'answer':
      return { ...every, approval: row.approval?.id ?? '', allow: typed.allow === true }
    case 'steer':
      return { ...every, said: typed.said ?? '' }
    case 'queue':
      return { ...every, change: typed.change ?? 'pause' }
    case 'done':
      return { ...every, confirm: true, summary: typed.summary ?? '' }
    case 'note':
      return { ...every, text: typed.text ?? '' }
    case 'context':
      return { ...every, add: typed.add ?? '' }
    case 'intake':
      return { ...every, confirm: true }
    default:
      return every
  }
}

/**
 * What to do with an answer: what to say, and whether to clear the box.
 *
 * **Only a `200` clears it**, which is the whole of this function and the line
 * somebody would write the other way round. A `409` means the world moved
 * under the screen — the next frame already carries what is true — and
 * throwing away the paragraph somebody typed on a phone because of it is the
 * one failure they cannot undo. `said` is Tade's own sentence either way: the
 * server's for a success, the refusal's for everything else.
 */
export function afterAnswer(answer, sentence) {
  const ok = answer?.status === 200
  return {
    ok,
    clear: ok,
    said: ok ? (answer.body?.said ?? 'done') : sentence,
    // A refusal the page cannot do anything about but say. `gone` and `stale`
    // are the two it should not apologise for, so they are named rather than
    // lumped in with a failure.
    moved: answer?.body?.error === 'gone' || answer?.body?.error === 'stale',
  }
}

/**
 * Whether a press needs asking again before it happens.
 *
 * Two of the verbs are not undoable by asking again — marking work finished
 * starts whatever waits on it, and approving a stranger's request puts an
 * agent on this machine to work on it — so each takes a second tap. The
 * schema's own `confirm` literal is the other half and neither stands in for
 * the other: this is what stops a mis-tap, and the literal is what stops a
 * body that means *do not*.
 */
export function confirms(verb) {
  return verb === 'done' || verb === 'intake'
}

/**
 * What one control's press says, in Tade's words.
 *
 * **Empty for `queue`, which has no single press**: its five choices are
 * `QUEUE_ASKS` and each carries its own word, so a word here would be one
 * nobody ever sees. Empty rather than a plausible default, because a default
 * is how a control ends up labelled *Do it*.
 */
export function wordsFor(verb, row) {
  switch (verb) {
    case 'park':
      return row.parked === true ? 'Pick this back up' : 'Set this aside'
    case 'answer':
      return `Allow ${row.approval?.tool ?? 'it'}`
    case 'steer':
      return 'Send'
    case 'done':
      return 'Mark it finished'
    case 'note':
      return 'Write it down'
    case 'context':
      return 'Add to its context'
    case 'intake':
      return 'Approve this request'
    default:
      return ''
  }
}

/** The heading each control's block gets, so a screen reads as sections. */
export function headingFor(verb) {
  switch (verb) {
    case 'answer':
      return 'WAITING ON YOU'
    case 'steer':
      return 'TELL ITS AGENT'
    case 'queue':
      return 'IN THE QUEUE'
    case 'done':
      return 'FINISHED'
    case 'note':
      return 'A NOTE'
    case 'context':
      return 'WHAT IT IS TOLD'
    case 'intake':
      return 'FROM OUTSIDE'
    default:
      return 'SET ASIDE'
  }
}

/**
 * What to say beside a control that would not take effect now.
 *
 * The harness's own word, mapped into a clause rather than drawn as a code:
 * `next-turn` is a real wait somebody should know about before they type a
 * paragraph into a box.
 */
export function howSaid(how) {
  if (how === 'next-turn') return 'when its turn ends'
  if (how === 'restart') return 'by starting it again, keeping the conversation'
  return ''
}

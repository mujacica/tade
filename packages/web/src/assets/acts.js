// What the page offers on one task, and what it sends — the decisions, pure.
//
// **Its own file, and the split is the point.** Everything here is a function
// of a row and what this device may ask for: which controls to draw, what each one
// sends, and what to do with the answer. `controls.js` turns these into nodes
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
// - **What this device may ask for is a drawing hint and never an authority.**
//   It is read off this device's own session (`actsOf`); the machine re-asks
//   the setting, the origin, the passkey and the state at the act. A page that lied here would get a
//   `403`, which is the right way round.

import { troubleOf } from './trouble.js'

/** The verbs a task's page draws a control for, in the order they are drawn. */
export const SHOWN = ['answer', 'steer', 'queue', 'done', 'park', 'stop']

/**
 * The verbs an agent's menu carries (`agent-menu.js`) rather than a block of
 * their own on its page: the rest of what the window's own row offers. With
 * `SHOWN` they are every verb about a task, and neither list has the other's.
 */
export const MENU_SHOWN = ['start', 'remove', 'rename', 'model', 'account']

/**
 * The verb a project's page draws a control for: the one about the whole of
 * it. A project row carries `can` and `cannot` over exactly these, as a task
 * row does over `SHOWN`.
 */
export const PROJECT_SHOWN = ['close']

/**
 * What kind of act each verb is (`SCOPES`), as the page's copy of `VERBS`.
 *
 * Two copies of one rule, for the reason `live.js` and `glyphs.js` have two:
 * a browser cannot import a `.ts` file and there is no build step.
 * `test/acts-client.test.ts` runs the verb table through both and asserts they
 * agree, so a verb filed under another kind makes the test fail rather than
 * making the page draw a button that is refused.
 */
export const NEEDS = {
  park: 'steer',
  answer: 'steer',
  steer: 'steer',
  queue: 'steer',
  done: 'steer',
  // The lifecycle.
  stop: 'agents',
  close: 'projects',
  // The rest of an agent's own menu.
  start: 'agents',
  remove: 'agents',
  rename: 'agents',
  model: 'agents',
  account: 'agents',
}

/**
 * Which kinds of act this device's own session may ask for.
 *
 * Every paired device is the person's own and may ask for every one — except
 * one paired in the clear (`you.clear`), which reads and never acts, and the
 * page before it knows who it is. Out of `/api/devices`, which is the same
 * record the machine re-checks; a control nothing could carry out is
 * **absent** rather than present and refused.
 */
export function actsOf(session) {
  const acts = session !== null && session !== undefined && session.clear !== true
  return {
    steer: acts,
    ask: acts,
    agents: acts,
    projects: acts,
  }
}

/**
 * What one message sends.
 *
 * `was` is the **conversation's** own revision — what the screen said, echoed
 * back. A message is not refused for it: words typed while a turn started wait
 * for it to be over and are a turn of their own, never joining one they were
 * not meant for. A stop is the one that compares it, and a `409` redraws the
 * truth. The key is minted once per press and kept across a retry, which
 * is what makes the one failure a phone on a train actually has — send, lose
 * signal, send again — one turn rather than two.
 */
export function askBody(talk, key, rev, said) {
  return { was: talk?.rev ?? '', key, rev, said }
}

/** What stopping the turn sends: the same four fields, minus the words. */
export function stopBody(talk, key, rev) {
  return { was: talk?.rev ?? '', key, rev }
}

/**
 * One verb's standing on one row: whether to draw it, and what to say.
 *
 * Three answers and not two, because the third is the one a person acts on:
 *
 * - `off` — this device cannot act at all (paired in the clear, or not known
 *   yet). **Nothing is drawn**, not even a reason.
 * - `no` — it may, and the thing is not possible. The control is
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
 * walks this, and the list is `SHOWN` for a task and `PROJECT_SHOWN` for a
 * project.
 */
export function controlsFor(row, acts, verbs = SHOWN) {
  return verbs.map((verb) => ({ verb, ...standingOf(verb, row, acts) }))
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
  // A project verb's target is the project, and its revision the project's own.
  if (verb === 'close') return { project: row.name, was: row.rev, key, rev, confirm: true }
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
    case 'stop':
    case 'remove':
      return { ...every, confirm: true }
    case 'rename':
      return { ...every, title: typed.title ?? '' }
    case 'model':
      return { ...every, model: typed.choice ?? '' }
    case 'account':
      return { ...every, account: typed.choice ?? '' }
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
    // What went wrong and what to do, for a refusal that is trouble (`trouble.js`);
    // null for a success and for the world having moved, which is news, not trouble.
    trouble:
      ok || ['gone', 'stale', 'there'].includes(answer?.body?.error) ? null : troubleOf(answer),
  }
}

/**
 * Whether a press needs asking again before it happens.
 *
 * One of the verbs is not undoable by asking again — marking work finished
 * starts whatever waits on it — and two more are destructive-adjacent:
 * stopping an agent cuts off whatever turn it was in, and closing a project
 * takes its own settings with it. So each takes a second tap. The schema's own
 * `confirm` literal is the other half and neither stands in for the other:
 * this is what stops a mis-tap, and the literal is what stops a body that
 * means *do not*.
 */
export function confirms(verb) {
  // Removing an agent deletes its worktree and branch: not undone by asking
  // again.
  return verb === 'done' || verb === 'stop' || verb === 'close' || verb === 'remove'
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

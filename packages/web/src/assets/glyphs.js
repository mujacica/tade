// What a state looks like, what it is called, and what colour it is — in that
// order of importance.
//
// **No state is ever carried by colour alone.** Every one of these is a glyph, a
// word and a tone, and the word goes out as visible text or as an `sr-only`
// span beside the glyph — which is 1.4.1, and is also what the window already
// does ("a colour is not an answer to 'is this on?'"). The pairs that would
// otherwise collide are deliberately far apart in shape: *wants you* (`◆`,
// violet) against *working* (`●`, amber), and *failed* (`▲`, red) against
// *finished* (`✓`, green).
//
// **Nothing here derives a state.** `deriveState` already decided, and the
// projection carries its answer and its own `reason` clause; this file maps that
// answer to a drawing and nothing more. A second rule about when a task is
// blocked would be a second state machine, and the two would disagree on the
// morning it mattered.
//
// The one place that is not a pure mapping is `queueSaid`, which puts a
// `QueueStateOut` into words. Those words are **`@tade/core`'s**, out of
// `describeQueueState`, copied here because a browser cannot import a `.ts`
// file — and `test/glyphs.test.ts` runs the same table through both and asserts
// they agree, so the two cannot drift. DESIGN §5.6's sketch says `ready` where
// the domain says `next`; the domain wins, because one wording of a state is
// the whole point.
//
// Nothing here touches the DOM.

/** A glyph, the word under it, and the tone class that colours it. */
const mark = (glyph, word, tone) => ({ glyph, word, tone })

/**
 * What kind of line one of the conversation's lines is: who is speaking.
 *
 * **Five, and they are about *who* rather than about how it should look.** The
 * window draws a routed line, a note and a suggestion differently because it
 * has the room; a phone does not, and a page that chose a shape from a guess
 * would be a second reading of the same entries. `tade` is Tade stating
 * something, whatever prompted it.
 *
 * `t-quiet` for a tool line is deliberate: a tool that worked is the least
 * interesting thing on the screen, and one that failed is already a `problem`
 * line beside it.
 */
export const CHAT_KINDS = {
  asked: mark('❯', 'asked', 't-wants'),
  reply: mark('·', 'Tade', 't-working'),
  tool: mark('⌸', 'used a tool', 't-quiet'),
  tade: mark('·', 'Tade', 't-quiet'),
  problem: mark('▲', 'went wrong', 't-failed'),
}

/**
 * A task's state, as `deriveState` answered it.
 *
 * `t-quiet` for queued and parked is deliberate: neither is a thing to look at,
 * and a queue that shouted would make the two that do get lost in it.
 */
export const TASK_STATES = {
  blocked: mark('◆', 'blocked', 't-wants'),
  failed: mark('▲', 'failed', 't-failed'),
  working: mark('●', 'working', 't-working'),
  review: mark('✓', 'review', 't-done'),
  merged: mark('✓', 'merged', 't-done'),
  queued: mark('·', 'queued', 't-quiet'),
  parked: mark('◻', 'parked', 't-quiet'),
}

/** What a state looks like, or a named unknown for a word nothing here knows. */
export function taskMark(state) {
  return TASK_STATES[state] ?? mark('?', state === '' ? 'unknown' : state, 't-quiet')
}

/**
 * A check rollup.
 *
 * `unknown` is first-class and is **not** drawn as a pass: a check nobody ran
 * here is not a check that passed, and a rollup is what a run *here* adds up
 * to.
 */
export const CHECK_STATES = {
  pass: mark('✓', 'green', 't-done'),
  fail: mark('✕', 'red', 't-failed'),
  unknown: mark('—', 'not run here', 't-quiet'),
}

export function checkMark(state) {
  return CHECK_STATES[state] ?? CHECK_STATES.unknown
}

/** A branch offered for merge, as the forge answered. */
export const REVIEW_STATES = {
  draft: mark('◌', 'draft', 't-quiet'),
  open: mark('◴', 'open', 't-working'),
  merged: mark('✓', 'merged', 't-done'),
  closed: mark('✕', 'closed', 't-quiet'),
}

export function reviewMark(state) {
  return REVIEW_STATES[state] ?? mark('?', state === '' ? 'unknown' : state, 't-quiet')
}

/**
 * Where a judge's finding stands — and the thing a phone is actually asking,
 * which is *whose move is it*.
 *
 * A verdict is somebody's reading and is the end of it. Before that there are
 * two different waits, and they are not the same wait: an unanswered finding is
 * waiting on the agent, and an answered one is waiting on a person. Only the
 * second is *wants you*.
 */
export function findingMark(finding) {
  if (finding.verdict !== null && finding.verdict !== undefined) {
    return finding.verdict.was === 'confirmed'
      ? mark('▲', 'confirmed', 't-failed')
      : mark('✓', 'false positive', 't-done')
  }
  if (finding.accounted) return mark('◆', 'wants reading', 't-wants')
  return mark('◴', 'not answered yet', 't-working')
}

/** Where queued work stands. */
export function queueMark(state) {
  switch (state.kind) {
    case 'ready':
      return mark('●', 'next', 't-working')
    case 'waiting':
      return mark('○', 'waiting', 't-quiet')
    case 'held':
      return mark('⚠', 'held', 't-failed')
    case 'scheduled':
      return mark('◴', 'scheduled', 't-quiet')
    default:
      return state.parked
        ? mark('◻', 'parked', 't-quiet')
        : mark('⏸', state.all ? 'paused with the queue' : 'paused', 't-quiet')
  }
}

/** `a`, `a and b`, `a, b and c`. `@tade/core`'s `joined`. */
export function joined(items) {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/**
 * Where queued work stands, in a few words. `@tade/core`'s
 * `describeQueueState`, held to it by `test/glyphs.test.ts`.
 *
 * `clock` turns the wire's ISO moment into words, which is the one difference
 * from the domain's copy: on the wire a moment is a string, because an elapsed
 * figure in a row would make every tick of the clock a change to every row
 * (`delta.ts`).
 */
export function queueSaid(state, clock) {
  switch (state.kind) {
    case 'waiting':
      return `after ${joined(state.on)}`
    case 'held':
      return `held: ${state.because}`
    case 'scheduled':
      return `at ${clock(state.at)}`
    case 'paused':
      if (state.parked) return 'parked'
      return state.all ? 'paused with the queue' : 'paused'
    default:
      return 'next'
  }
}

/**
 * Whose a task is, in words. `@tade/core`'s `saidBy`, over the wire's shape.
 *
 * `you` carries no name — it is the person at the machine — and the others
 * carry the name the projection gave, which is a name Tade wrote down and never
 * a path.
 */
export function originSaid(origin) {
  switch (origin.kind) {
    case 'orchestrator':
      return 'the orchestrator'
    case 'extension':
      return origin.name === '' ? 'an extension' : origin.name
    case 'schedule':
      return origin.name === '' ? 'a schedule' : `the ${origin.name} schedule`
    case 'intake':
      // Never "you". What arrived from outside is somebody else's request, and
      // a page that said the owner asked for it would be the one sentence this
      // whole surface must not say.
      return origin.name === '' ? 'a request from outside' : `a ${origin.name} request`
    default:
      return 'you'
  }
}

/**
 * Where one request from outside stands, as `inboxStateOf` answered it.
 *
 * **Seven, and `proposed` against `started` is the pair this exists for.** One
 * is waiting for a person to say yes and the other is an agent spending money,
 * and a surface that drew them as one word is the drawing the domain's own
 * comment says was unreadable. So they are the two furthest apart in shape and
 * in tone — `◆` violet against `●` amber, the same pair *wants you* and
 * *working* already are, because that is exactly what they mean here.
 *
 * `refused` is `⏸` and quiet rather than red: nothing went wrong, somebody
 * said no, and a red row would have people looking for a bug.
 */
export const INTAKE_STATES = {
  noticed: mark('·', 'noticed', 't-quiet'),
  proposed: mark('◆', 'proposed', 't-wants'),
  accepted: mark('○', 'accepted', 't-quiet'),
  started: mark('●', 'started', 't-working'),
  held: mark('⚠', 'held', 't-failed'),
  refused: mark('⏸', 'refused', 't-quiet'),
  failure: mark('▲', 'gave up', 't-failed'),
}

export function intakeMark(row) {
  // Work that has an agent on it and has finished wears the finished mark: a
  // spinner over work nobody is doing is the one reading of `started` that is
  // simply untrue. The window's own INTAKE section does this (`inboxMark`) and
  // this is the same rule, because two surfaces reading one state two ways is
  // how one of them comes to be wrong.
  const over =
    row.state === 'started' && row.work.length > 0 && row.work.every((one) => one.finished)
  if (over) return mark('✓', 'finished', 't-done')
  return INTAKE_STATES[row.state] ?? mark('?', row.state === '' ? 'unknown' : row.state, 't-quiet')
}

/**
 * Where one door stands, as `sourceStandingOf` answered it.
 *
 * **Nine, and the four this page exists to tell apart are the last four.** An
 * empty inbox has five meanings and four of them are somebody at the machine's
 * to fix; a page with one word for them says *nothing yet* while a connector
 * has been answering `429` since Tuesday. So: off, ungranted and unwatched are
 * decisions somebody made and are quiet; `unreachable` and `trouble` are red,
 * because they are the two a person has to act on; `rate-limited` is amber,
 * because it clears on its own and the row says when.
 */
export const SOURCE_STATES = {
  off: mark('⏸', 'off', 't-quiet'),
  ungranted: mark('⏸', 'not granted', 't-quiet'),
  unwatched: mark('○', 'nothing looks with it', 't-quiet'),
  paused: mark('⏸', 'paused', 't-quiet'),
  unlooked: mark('◴', 'not looked with yet', 't-quiet'),
  unreachable: mark('▲', 'unreachable', 't-failed'),
  'rate-limited': mark('⚠', 'rate limited', 't-working'),
  trouble: mark('▲', 'could not be read', 't-failed'),
  quiet: mark('✓', 'found nothing', 't-done'),
  found: mark('●', 'found something', 't-working'),
}

export function sourceMark(state) {
  return SOURCE_STATES[state] ?? mark('?', state === '' ? 'unknown' : state, 't-quiet')
}

/**
 * Where one step of a run stands.
 *
 * `deriveState`'s word with two facts laid over it, and both are the journal's
 * rather than a state: a step the journal says is finished wears the finished
 * mark however its branch looks, and a step with an agent on it *now* is the
 * active one. Everything else is `taskMark`, so a step and the task row it is
 * about never disagree.
 */
export function stepMark(step) {
  if (step.finished) return mark('✓', 'finished', 't-done')
  if (step.active) return mark('●', 'working', 't-working')
  return taskMark(step.state)
}

/**
 * The six ways the page can stand to the machine, as §5.10's state machine.
 *
 * `reconnecting` and `unreachable` are the same *connection* — not open — told
 * apart by whether the retries have got anywhere: a tunnel that blinked is
 * reconnecting, and one that has been through the whole backoff and still has
 * nothing is unreachable. `connectionOf` is deliberately not asked to know
 * that, because what it is for is what the stream did; how many tries have
 * failed is the page's own count (`live.js` holds the backoff curve).
 */
export const FRESH_MARKS = {
  live: mark('●', 'live', 'is-live'),
  stale: mark('●', 'live, quiet for a while', 'is-stale'),
  reconnecting: mark('◴', 'reconnecting', 'is-reconnecting'),
  unreachable: mark('○', 'unreachable', 'is-gone'),
  closed: mark('⏸', 'closed', 'is-closed'),
}

export function freshMark(kind) {
  return FRESH_MARKS[kind] ?? FRESH_MARKS.unreachable
}

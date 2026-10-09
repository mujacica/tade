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
    default:
      return 'you'
  }
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

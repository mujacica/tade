// Restarting Tade from the page's restart bar (`shell-bars.js` draws it): the
// press, what the machine answered, and nothing else. `POST /api/restart` is
// every paired device's (`restarted.ts`) but one paired in the clear, which
// is drawn the bar with no press and told who can.
//
// **Stopping work is a second press on a number somebody was shown.** The
// first press says nought would stop; where lanes run inside the window the
// machine answers how many and does nothing, and the next press sends that
// number back, which the machine asks again at the act.

import { actsOf } from './acts.js'
import { theirsTrouble, troubleSaid, UNKNOWN_TROUBLE } from './trouble.js'

export const RESTART_PATH = '/api/restart'

/** Nothing pressed yet. */
const FRESH = { stops: 0, armed: false, busy: false, going: false, said: null, cannot: false }

/**
 * How long a Tade that said it is starting again has to end this page's
 * stream. It answers first and goes half a second later, so a stream still
 * open after this is a restart that did not happen, and the bar says so
 * rather than saying *starting again* for ever.
 */
export const GONE_BY_MS = 30_000

/** Said where Tade answered that it would start again and its stream never ended. */
export const DID_NOT_GO =
  'Tade said it would start again and has not: what went wrong is said at the machine.'

/**
 * The press and where it stands. `ctx` is the shell's (`ask`, `session`);
 * `paint` redraws the bars; `later` is the clock, a test's own where given.
 */
export function restarter(ctx, paint, later = (fn, ms) => setTimeout(fn, ms)) {
  let asked = FRESH
  /** Whether the stream ended since Tade said it would go. */
  let ended = false

  async function press() {
    if (asked.busy || asked.going) return
    asked = { ...asked, busy: true, said: null }
    paint()
    const got = await ctx.ask('POST', RESTART_PATH, { stops: asked.stops })
    asked = { ...asked, busy: false, ...answered(got) }
    paint()
    if (!asked.going) return
    ended = false
    const was = asked
    later(() => {
      if (asked !== was || ended) return
      asked = { ...FRESH, said: DID_NOT_GO }
      paint()
    }, GONE_BY_MS)
  }

  return {
    /**
     * What the bar draws: where the press stands, and whether this device may
     * ask — every paired device may, but one paired in the clear (`actsOf`).
     */
    standing: () => ({ ...asked, theirs: actsOf(ctx.session()).steer }),
    press: () => void press(),
    /** Asked to start again and told it is: the stream's end is Tade going, not a door shut. */
    going: () => asked.going,
    /** The stream ended while Tade was going, which is it going. */
    ended() {
      ended = true
    },
    /** The stream is back, from a Tade that says again for itself whether a restart is owed. */
    back() {
      asked = FRESH
    },
  }
}

/** What one answer makes of the press. */
function answered(got) {
  const body = got.status === 200 ? got.body : null
  if (body?.restarting === true) return { going: true }
  if (typeof body?.stops === 'number') return { armed: true, stops: body.stops }
  // A Tade with no window to start again says where it can be.
  if (typeof body?.said === 'string') return { said: body.said, cannot: true }
  return { said: troubleSaid(theirsTrouble(got) ?? UNKNOWN_TROUBLE) }
}

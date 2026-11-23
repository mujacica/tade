// Restarting Tade from the page's restart bar (`shell-bars.js` draws it): the
// press, what the machine answered, and nothing else. `POST /api/restart` is
// the person's own phone's (`restarted.ts`), so a device without full access
// is drawn the bar with no press and told who can.
//
// **Stopping work is a second press on a number somebody was shown.** The
// first press says nought would stop; where lanes run inside the window the
// machine answers how many and does nothing, and the next press sends that
// number back, which the machine asks again at the act.

import { fullAccessOf, theirsTrouble, troubleSaid, UNKNOWN_TROUBLE } from './trouble.js'

export const RESTART_PATH = '/api/restart'

/** Nothing pressed yet. */
const FRESH = { stops: 0, armed: false, busy: false, going: false, said: null, cannot: false }

/**
 * The press and where it stands. `ctx` is the shell's (`ask`, `session`);
 * `paint` redraws the bars.
 */
export function restarter(ctx, paint) {
  let asked = FRESH

  async function press() {
    if (asked.busy || asked.going) return
    asked = { ...asked, busy: true, said: null }
    paint()
    const got = await ctx.ask('POST', RESTART_PATH, { stops: asked.stops })
    asked = { ...asked, busy: false, ...answered(got, ctx.session()) }
    paint()
  }

  return {
    /** What the bar draws: where the press stands, and whether this device may ask. */
    standing: () => ({ ...asked, theirs: fullAccessOf(ctx.session()) }),
    press: () => void press(),
    /** Asked to start again and told it is: the stream's end is Tade going, not a door shut. */
    going: () => asked.going,
    /** The stream is back, from a Tade that says again for itself whether a restart is owed. */
    back() {
      asked = FRESH
    },
  }
}

/** What one answer makes of the press. */
function answered(got, you) {
  const body = got.status === 200 ? got.body : null
  if (body?.restarting === true) return { going: true }
  if (typeof body?.stops === 'number') return { armed: true, stops: body.stops }
  // A Tade with no window to start again says where it can be.
  if (typeof body?.said === 'string') return { said: body.said, cannot: true }
  return { said: troubleSaid(theirsTrouble(got, you) ?? UNKNOWN_TROUBLE) }
}

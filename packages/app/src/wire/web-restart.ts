import type { WebRestarting } from '@tade/web'
import { type Wiring, why } from './context.ts'

// Tade started again from the person's own phone (`@tade/web`'s
// `restarted.ts`): the window's own reload — the one ctrl+r's `reload` and the
// orchestrator's `tade_reload` end in (`AppOptions.reloadWindow`) — asked from
// the page's restart bar when Tade's code changed since it started.
//
// **The count is the window's reload panel, asked from away.** Where the
// driver's lanes outlive the window nothing stops and nothing is asked; where
// they would stop, the window asks at its screen and the phone is answered the
// number, so the press that ends them is one made on it (`Window.reloadStops`,
// which a face hands in). With no face (`tade serve`) there is no window to
// start again, and that is said rather than offered.
//
// Written down as the device's (`web_did`, `verb: restart`) before the window
// goes, and started a moment after the answer, so the phone is told.

/** How long the answer is given to reach the phone before the window ends. */
const ANSWERED_MS = 500

/** Said where Tade has no window to start again. */
export const NO_WINDOW =
  'Tade here runs with no window (`tade serve`), so it cannot start itself again: restart it where it was started.'

export function restartingFrom(wire: Wiring, stops?: () => number): WebRestarting {
  let going = false
  return {
    standing: () => {
      const reload = wire.opts.reloadWindow
      if (stops === undefined || reload === undefined) return { cannot: NO_WINDOW }
      return { stops: going ? 0 : stops() }
    },
    restart: (device) => {
      const reload = wire.opts.reloadWindow
      // A second press while the first is on its way starts nothing twice.
      if (going || reload === undefined) return
      going = true
      void wire.opts.client.log
        .append({ type: 'web_did', detail: { device, verb: 'restart', state: 'done' } })
        .catch((err: unknown) => wire.note(new Error(`A restart from away: ${why(err)}`)))
        .finally(() => {
          setTimeout(() => {
            reload().catch((err: unknown) => {
              going = false
              wire.note(new Error(`A restart from away failed: ${why(err)}`))
            })
          }, ANSWERED_MS)
        })
    },
  }
}

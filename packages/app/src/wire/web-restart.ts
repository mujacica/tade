import type { WebOrchestratorRestart, WebRestarting } from '@tade/web'
import { type Wiring, why } from './context.ts'
import { reloadStopsOf } from './window.ts'

// Tade started again from the person's own phone (`@tade/web`'s
// `restarted.ts`): the window's own reload — the one ctrl+r's `reload` and the
// orchestrator's `tade_reload` end in (`AppOptions.reloadWindow`) — asked from
// the page's restart bar when Tade's code changed since it started.
//
// **The count is the window's reload panel, asked from away.** Where the
// driver's lanes outlive the window nothing stops and nothing is asked; where
// they would stop, the window asks at its screen and the phone is answered the
// number, so the press that ends them is one made on it (`Window.reloadStops`,
// which a face hands in). With no face (`tade serve`) the count is the same
// fold over the lanes (`reloadStopsOf`), and starting again is its service's:
// under the unit `tade host service` wrote, `serve.ts` hands in a reload that
// asks systemd to restart it. A `tade serve` nothing keeps has nobody to start
// it again, and that is said rather than offered.
//
// **One press reloads every machine**, as the strip's reload does: where the
// window hands in its reload of every machine it is an owner of
// (`fleet-reload.ts`), the phone's press is that, each machine said in the
// conversation as it comes back. The count stays this window's lanes, as the
// reload panel's does; a machine whose lanes would stop refuses and is said.
// A press that came over another machine's link is that machine's reload of
// every machine reaching this one, so it starts this window alone — never a
// second fan-out back at the machine waiting for it.
//
// Written down as the device's (`web_did`, `verb: restart`) before the window
// goes, and started a moment after the answer, so the phone is told.

/** How long the answer is given to reach the phone before the window ends. */
const ANSWERED_MS = 500

/** Said where nothing could start this Tade again: a `tade serve` no service keeps. */
export const NO_WINDOW =
  'Tade here runs with no window and no service keeping it (`tade serve`, started by hand), so nothing would start it again: restart it where it was started, or run it as the service (`tade host service`).'

export function restartingFrom(
  wire: Wiring,
  stops: () => number = () => reloadStopsOf(wire),
  everyMachine?: () => Promise<void>,
): WebRestarting {
  let going = false
  return {
    standing: () => {
      if (wire.opts.reloadWindow === undefined) return { cannot: NO_WINDOW }
      return { stops: going ? 0 : stops() }
    },
    restart: (device, link) => {
      // Nothing could start this window again: nothing is restarted anywhere.
      if (wire.opts.reloadWindow === undefined) return
      const reload = link ? wire.opts.reloadWindow : (everyMachine ?? wire.opts.reloadWindow)
      // A second press while the first is on its way starts nothing twice.
      if (going) return
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

/** Said where this Tade has no orchestrator it could start again. */
export const NO_ORCHESTRATOR =
  'Tade here has no orchestrator it can start again: it starts on its sign-in now the next time Tade does.'

/**
 * The orchestrator alone started again from another of the person's machines
 * (`@tade/web`'s `orchestratorRestartHere`), once its sign-in there finished:
 * its harness runs headless and keeps the sign-in it started with. Once any
 * turn it is in is over, because somebody at this machine may be in one —
 * one that could not answer ends at once — and written down as the device's
 * (`web_did`, `verb: orchestrator restart`).
 */
export function orchestratorRestartFrom(
  wire: Wiring,
  move: (() => void) | undefined,
): WebOrchestratorRestart {
  return {
    restart: (device) => {
      if (move === undefined || wire.opts.restartThinker === undefined) {
        return { cannot: NO_ORCHESTRATOR }
      }
      void wire.opts.client.log
        .append({
          type: 'web_did',
          detail: { device, verb: 'orchestrator restart', state: 'done' },
        })
        .catch((err: unknown) =>
          wire.note(new Error(`An orchestrator restart from away: ${why(err)}`)),
        )
      move()
      return { restarting: true }
    },
  }
}

import type { ConnectWhere, Tickets } from '@tade/web'
import { launch, openerForLink } from '../editor.ts'
import { AWAY_CONTROLS } from '../panels/away/state.ts'
import { CONNECT_CONTROLS } from '../panels/settings/connect.ts'
import { flash, type Wiring } from './context.ts'

// The pairing link's two buttons, `Open` and `Copy`, and a press on the link
// itself, which is `Open`: there on the AWAY VIEW panel and on the Away page
// of Settings alike, because both draw the same lines.
//
// **The link carries a ticket, and a ticket is a credential** — whoever
// presents it first is asked in. So it is read here from the one place it
// lives, the window's own ticket store, at the moment of the press: never out
// of a hit, a control's name or anything else drawn, and never said. What the
// flash says is the act and not the address, a failure is the panel's own
// `problem` in Tade's words, and nothing here journals, logs or tells the
// orchestrator anything at all.
//
// Opened the way the window opens every link — `openerForLink`, started by
// the window's `open` seam, detached in its own group (`launch`) — so a test
// is handed one that records the command rather than reaching a browser.
//
// And the guided pages that connect a source, from Settings › Intake: the
// same two buttons over an address that is no credential — the pages ask for
// none on this machine's own door — so the flash may say what it did.

/** Whether a control is one of the link's, for `carryLink`. */
export function isLink(control: string): boolean {
  return control === AWAY_CONTROLS.open || control === AWAY_CONTROLS.copy
}

/**
 * Open the link the panel draws now, or copy it. Throws a sentence for the
 * panel to say where none is outstanding — a code that ran out between the
 * frame and the press — or the clipboard would not take it.
 */
export async function carryLink(
  wire: Wiring,
  control: string,
  tickets: Pick<Tickets, 'outstanding'>,
  deps: { copy(text: string): Promise<boolean> },
): Promise<void> {
  const url = tickets.outstanding(wire.now())[0]?.url
  if (url === undefined) throw new Error('That code has run out: press New code for another.')
  if (control === AWAY_CONTROLS.open) {
    const opener = openerForLink(url)
    if (opener.kind === 'detached') await (wire.opts.open ?? launch)(opener)
    flash(wire, 'opened the pairing link')
    return
  }
  if (!(await deps.copy(url))) throw new Error('The pairing link could not be copied.')
  flash(wire, 'copied the pairing link')
}

/** Whether a control is one of Settings › Intake's connect row, for `carryConnect`. */
export function isConnect(control: string): boolean {
  return control === CONNECT_CONTROLS.open || control === CONNECT_CONTROLS.copy
}

/**
 * Open the guided pages that connect a source, or copy where they are: read
 * at the press from the listener as it is then (`connectWhere`), never out of
 * what was drawn. Throws a sentence where nothing serves them any more, or the
 * clipboard would not take it.
 */
export async function carryConnect(
  wire: Wiring,
  control: string,
  where: ConnectWhere,
  deps: { copy(text: string): Promise<boolean> },
): Promise<void> {
  if (where.url === null) throw new Error(`The connect pages are not here: ${where.why}.`)
  if (control === CONNECT_CONTROLS.open) {
    const opener = openerForLink(where.url)
    if (opener.kind === 'detached') await (wire.opts.open ?? launch)(opener)
    flash(wire, 'opened the connect pages')
    return
  }
  if (!(await deps.copy(where.url)))
    throw new Error('Where the connect pages are could not be copied.')
  flash(wire, 'copied where the connect pages are')
}

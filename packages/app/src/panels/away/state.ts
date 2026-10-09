import { pageBy } from '../frame.ts'
import { close, type PanelOutcome, stay } from '../outcome.ts'

// The AWAY VIEW panel's own state: where the device list is scrolled to, and
// which row of it is chosen.
//
// Everything else it draws is a *fact*, not state: whether anything is
// listening, what addresses it is on, which ticket is outstanding, which
// devices there are, and whether somebody is waiting to be let in. All of
// those change under the panel while it is open — a device pairs, a ticket
// expires, the wifi changes — so remembering any of them here would be a panel
// that disagrees with the machine. They arrive on `PanelContext` every frame.
//
// Pure, like every other panel's state.

export interface AwayPanel {
  kind: 'away'
  /** Rows of the scrolling region scrolled past. */
  scroll: number
  /** The device the keyboard is on, by index into the list drawn. */
  chosen: number
  /**
   * Whether the keyboard has been moved into the device list.
   *
   * **The anchor is off until it has**, because a chosen row pulls the region
   * to wherever that row is: on a short terminal the panel would open showing
   * the bottom of the list, with the code — the thing somebody opened it for —
   * scrolled off the top. `chosen` is a real answer only once somebody has
   * expressed one, and this is how a `0` that nobody chose is told from a `0`
   * they did.
   */
  moved: boolean
  busy: false
}

export function awayPanel(): AwayPanel {
  return { kind: 'away', scroll: 0, chosen: 0, moved: false, busy: false }
}

/**
 * What the away panel's own controls are, by name.
 *
 * Written out so `wire/web.ts` and the drawing agree on one spelling, and so
 * that the two that are not reversible — letting a device in, and
 * disconnecting everything — are visible together in one list.
 */
export const AWAY_CONTROLS = {
  /** Mint a fresh ticket and redraw the code. */
  code: 'away-code',
  /** Let the device that is asking in. */
  allow: 'away-allow',
  /** Refuse it. */
  deny: 'away-deny',
  /** Every device, disconnected. Needs no network. */
  all: 'away-revoke-all',
  /** One device, by its id: `away-revoke:<id>`. */
  revoke: 'away-revoke:',
  /**
   * Let one device act, or take it back: `away-act:<id>`.
   *
   * **The only door a scope widens through, and it is a keypress here.**
   * DESIGN.md §9.1's *pairing and scopes are never remote*: the thing that
   * grants authority is never reachable from inside the authority it granted,
   * so there is no route, no tool and no config key for this — it is a control
   * on this panel, at this machine, about one device. Drawn only where
   * `surfaces.web.acting` is on, because a control for a capability nobody
   * turned on is a button that cannot do what it says.
   */
  act: 'away-act:',
} as const

/**
 * A key, while the panel has the keyboard.
 *
 * **The keys that let a device in are the window's own `approve`/`deny`**,
 * because letting a device in is the same act in the same vocabulary as
 * approving a tool call and a second pair of keys for it would be a second
 * thing to learn. They are recognised *here* rather than by the keyboard,
 * because a panel has the keyboard while it is open — a rule that was already
 * true and that a question drawn in a panel has to live with.
 *
 * The arrows read down the device list. `escape` and `enter` close, and
 * neither answers the question: a pairing refused by accident is a code to
 * mint again, and a pairing *allowed* by accident is a device in your control
 * room — so the only way to say yes is the key that means yes.
 */
export function awayKey(
  panel: AwayPanel,
  key: string | undefined,
  inputs: { devices?: number; bindings?: Readonly<Record<string, string>> } = {},
): PanelOutcome {
  const bindings = inputs.bindings ?? {}
  if (key !== undefined && key === (bindings.approve ?? 'a')) {
    return { panel, submit: true, choice: AWAY_CONTROLS.allow }
  }
  if (key !== undefined && key === (bindings.deny ?? 'd')) {
    return { panel, submit: true, choice: AWAY_CONTROLS.deny }
  }
  if (key === 'escape' || key === 'enter') return close
  const by = pageBy(key)
  if (by === null) return stay(panel)
  const most = Math.max(0, (inputs.devices ?? 0) - 1)
  return stay({
    ...panel,
    moved: true,
    chosen: Math.min(most, Math.max(0, panel.chosen + by)),
  })
}

export function awayClick(panel: AwayPanel, control: string): PanelOutcome {
  if (control === 'close') return close
  // Everything else is carried out by the subject that owns the server, and
  // **the panel stays open while it happens**: a device list you have just
  // disconnected everything from is the list that proves it, and a panel that
  // closed on the press would leave you guessing.
  return { panel, submit: true, choice: control }
}

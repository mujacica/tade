import { pageBy } from '../frame.ts'
import { close, type PanelOutcome, scrolled, stay } from '../outcome.ts'

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
  /**
   * Whether the region follows the chosen device, as every other panel's
   * keyboard is followed: the arrows turn it on, and the wheel, the bar and
   * `home` let go of it (`atOffset`), so they move from the rows on screen
   * rather than from a `scroll` the chosen device was pulling past.
   */
  following: boolean
  /** Why the last key did nothing: a yes or a no to a device that was out of view. */
  said: string | null
  busy: false
  /**
   * The machine whose tab is in front, by its `remotes.<name>`; absent is this
   * machine's own. **A panel marked `there` is carried out by the remotes'
   * `submitsThere` alone**, so a press on another machine's tab is that
   * machine's act over its link and can never reach this machine's away view.
   */
  there?: string
}

export function awayPanel(): AwayPanel {
  return {
    kind: 'away',
    scroll: 0,
    chosen: 0,
    moved: false,
    following: false,
    said: null,
    busy: false,
  }
}

/**
 * Said for a yes or a no while the card asking it is out of view. Not answered
 * is the whole of it: the key did nothing, and the way back to the card.
 */
export const ASKING_OUT_OF_VIEW =
  'Not answered: the device asking is out of view — press home, or scroll up to it.'

/**
 * Said when the window's own yes or no opened the panel, shut while a device
 * asks: neither the device nor the agent in front was answered by that press.
 */
export const ASKING_FIRST = 'Nothing answered: a device is asking to be let in first.'

/**
 * Said for a yes or a no on the panel with no device asking: the agent's card
 * it would have answered is behind the panel, and closing it is the way back.
 */
export const BEHIND_THE_PANEL =
  'Nothing answered: no device is asking, and this panel is in front of the agents — close it to answer one.'

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
  /**
   * The link the code carries, opened in the browser — its `Open`, and a press
   * on the link itself. Named, never carrying the link: it holds a ticket, and
   * the subject reads the one outstanding at the press (`web-link.ts`).
   */
  open: 'away-open',
  /** The same link, put on the clipboard. */
  copy: 'away-copy',
  /** Let the device that is asking in. */
  allow: 'away-allow',
  /** Refuse it. */
  deny: 'away-deny',
  /** Every device, disconnected. Needs no network. */
  all: 'away-revoke-all',
  /** One device, by its id: `away-revoke:<id>`. */
  revoke: 'away-revoke:',
  /** A machine's tab, by its `remotes.<name>`: `away-tab:ipax`, and `away-tab:` for this machine. */
  tab: 'away-tab:',
} as const

/**
 * The panel on one machine's tab: the same panel, scrolled to its top, with
 * nothing chosen — the devices under the next tab are another list. Empty is
 * this machine's own.
 */
export function onTab(panel: AwayPanel, machine: string): AwayPanel {
  const { there: _was, ...rest } = panel
  const fresh = { ...rest, scroll: 0, chosen: 0, moved: false, following: false, said: null }
  return machine === '' ? fresh : { ...fresh, there: machine }
}

/**
 * The tab `by` steps from the one in front, round the ends: this machine
 * first, then every other in the order the config names them. A machine no
 * longer in the list counts as this one.
 */
export function tabBy(panel: AwayPanel, machines: readonly string[], by: number): string {
  const tabs = ['', ...machines]
  const at = Math.max(0, tabs.indexOf(panel.there ?? ''))
  return tabs[(((at + by) % tabs.length) + tabs.length) % tabs.length] ?? ''
}

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
 * **A device is answered only from where its card was drawn.** The card is the
 * first thing in the region that scrolls (`middleOf`), so it is on the screen
 * only while that region was drawn from its top (`drawnFrom`); scrolled away by
 * the wheel, or pulled away by the keyboard following a device further down,
 * a yes would let in a device nobody could see. Then the key says so and does
 * nothing, and `home` brings the card back — every other key here moves the
 * chosen device. With nobody asking the key is handed on to the window's own
 * rule, whether an agent's approval card is in front (`approvalInFront`), which
 * says no while this panel stands over the pane: nothing is answered, and the
 * panel says why (`BEHIND_THE_PANEL`).
 *
 * The arrows read down the device list. `escape` and `enter` close, and
 * neither answers the question: a pairing refused by accident is a code to
 * mint again, and a pairing *allowed* by accident is a device in your control
 * room — so the only way to say yes is the key that means yes.
 */
export function awayKey(
  panel: AwayPanel,
  key: string | undefined,
  inputs: {
    devices?: number
    asking?: boolean
    drawnFrom?: number
    bindings?: Readonly<Record<string, string>>
    /** The other machines with a tab, in order (`awayMachines`); none is this machine's alone. */
    awayMachines?: readonly string[]
  } = {},
): PanelOutcome {
  const bindings = inputs.bindings ?? {}
  // Tab walks the machines, as it walks the tabs of every other panel with tabs.
  const machines = inputs.awayMachines ?? []
  if ((key === 'tab' || key === 'shift+tab') && machines.length > 0) {
    return stay(onTab(panel, tabBy(panel, machines, key === 'tab' ? 1 : -1)))
  }
  // Another machine's door is answered at that machine, never by this window's
  // keys: the card these answer is this machine's.
  const yesNo =
    key !== undefined && (key === (bindings.approve ?? 'a') || key === (bindings.deny ?? 'd'))
  if (yesNo && panel.there !== undefined) return stay({ ...panel, said: BEHIND_THE_PANEL })
  const answer = (choice: string): PanelOutcome =>
    inputs.asking === true && inputs.drawnFrom !== 0
      ? stay({ ...panel, said: ASKING_OUT_OF_VIEW })
      : { panel: { ...panel, said: null }, submit: true, choice }
  if (key !== undefined && key === (bindings.approve ?? 'a')) return answer(AWAY_CONTROLS.allow)
  if (key !== undefined && key === (bindings.deny ?? 'd')) return answer(AWAY_CONTROLS.deny)
  if (key === 'escape' || key === 'enter') return close
  const quiet = { ...panel, said: null }
  // The top, where the card is: as far up as it goes, through the one move.
  if (key === 'home') return scrolled(quiet, Number.NEGATIVE_INFINITY)
  const by = pageBy(key)
  if (by === null) return stay(quiet)
  const most = Math.max(0, (inputs.devices ?? 0) - 1)
  return stay({
    ...quiet,
    moved: true,
    following: true,
    chosen: Math.min(most, Math.max(0, panel.chosen + by)),
  })
}

export function awayClick(panel: AwayPanel, control: string): PanelOutcome {
  if (control === 'close') return close
  // Which tab is in front is the panel's own, and asks nothing of anybody.
  if (control.startsWith(AWAY_CONTROLS.tab)) {
    return stay(onTab(panel, control.slice(AWAY_CONTROLS.tab.length)))
  }
  // Everything else is carried out by the subject that owns the server, and
  // **the panel stays open while it happens**: a device list you have just
  // disconnected everything from is the list that proves it, and a panel that
  // closed on the press would leave you guessing.
  return { panel, submit: true, choice: control }
}

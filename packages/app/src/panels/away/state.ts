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
  /**
   * Give one device everything, or take everything back: `away-all:<id>`.
   *
   * **The owner's default, as one press**: a device let in now gets every
   * reading grant and every scope (`EVERYTHING`), and one paired before that
   * — or narrowed since — gets the same from here, rather than a box per
   * reading grant somebody has to find. Ticked when it has all of them;
   * pressing a ticked one leaves it reading names and counts, and the boxes
   * beside it take back one thing at a time.
   */
  everything: 'away-all:',
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
  /**
   * Let one device talk to Tade, or take it back: `away-talk:<id>`.
   *
   * **A second control and not a wider first one.** Acting's eight verbs are
   * each a target plus the state it expects; this is free text to a model that
   * holds tools, which is the difference between answering a question and
   * being able to ask for anything. A person who granted the first has not
   * answered the second, and one control for both would be a yes to a question
   * nobody was asked. Drawn only where `surfaces.web.orchestrator` is on, for
   * the reason the act chip is drawn only where acting is.
   */
  talk: 'away-talk:',
  /**
   * Let one device see agents' screens, or take it back: `away-see:<id>`.
   *
   * **A reading grant, and the only one with a control after pairing**,
   * because it is the one whose content Tade did not write: whatever an agent
   * printed, scrubbed of paths and keys (`cleanScreen`) and nothing more. So
   * it is off for every device until somebody here turns it on for one, and
   * the row says `lanes` in its own words once they have. Drawn always — it
   * needs no setting, because nothing it grants can change anything.
   */
  see: 'away-see:',
  /**
   * Let one device stop an agent and open it again, or take it back:
   * `away-agents:<id>`.
   *
   * **A chip of its own and not a wider `act`**, for the reason `talk` is one:
   * a device that may say something to an agent has not been granted a say in
   * whether it runs at all. Drawn only where acting is on, because these verbs
   * are acting routes and there is no route to reach with it off.
   */
  agents: 'away-agents:',
  /**
   * Let one device close a project and open it again, or take it back:
   * `away-projects:<id>`. Its own chip again: closing changes what every
   * surface draws and takes the project's own settings with it.
   */
  projects: 'away-projects:',
  /**
   * Let one device read the settings, or take it back: `away-settings:<id>`.
   *
   * **A reading grant like `lanes`, and drawn always for the same reason**:
   * nothing it grants can change anything, and a key is never in what it lets
   * through under any grant (`settingsFor`). It is also what changing one
   * needs — a device may not change what it was not allowed to see.
   */
  settings: 'away-settings:',
  /**
   * Let one device change a setting, or take it back: `away-configure:<id>`.
   *
   * **Its own chip, and drawn only where `surfaces.web.settings` is on**, for
   * the reason `act` is drawn only where acting is: with it off there is no
   * route a grant could reach. What it reaches is `settingReach`'s `open` tier
   * and nothing else (`SETTINGS_FROM_AWAY`).
   */
  configure: 'away-configure:',
} as const

/**
 * What each per-device control is called on screen, by its prefix in
 * `AWAY_CONTROLS`: the drawing's word and the foot's clause (`grantsHelp`)
 * start with the same one, so pointing at a box and reading what it grants
 * never name it two ways. Words for what the device may then do, not the
 * scope's own name — `act` was a word somebody had to look up.
 */
export const AWAY_LABELS = {
  [AWAY_CONTROLS.act]: 'answer & steer',
  [AWAY_CONTROLS.agents]: 'stop agents',
  [AWAY_CONTROLS.projects]: 'close projects',
  [AWAY_CONTROLS.talk]: 'talk to Tade',
  [AWAY_CONTROLS.configure]: 'change settings',
  [AWAY_CONTROLS.see]: 'see screens',
  [AWAY_CONTROLS.settings]: 'read settings',
  [AWAY_CONTROLS.revoke]: 'Sign out',
  [AWAY_CONTROLS.everything]: 'full access',
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
  } = {},
): PanelOutcome {
  const bindings = inputs.bindings ?? {}
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
  // Everything else is carried out by the subject that owns the server, and
  // **the panel stays open while it happens**: a device list you have just
  // disconnected everything from is the list that proves it, and a panel that
  // closed on the press would leave you guessing.
  return { panel, submit: true, choice: control }
}

import { SPEND_WINDOWS, type SpendWindow } from '../../spend.ts'
import { pageBy } from '../frame.ts'
import { close, type PanelOutcome, stay, typed } from '../outcome.ts'

// The two panels that open out of the Extensions page: setting an extension
// up — the guide and the fields — and the page an extension writes about
// itself. Both are small enough to share a file, and neither is anything to
// do with the list they came from. Their drawing is in `view.ts` with the
// rest of the page's.

/** What an extension shows when its status is clicked: a document, kept fresh while open. */
export interface ExtensionViewPanel {
  kind: 'extension-view'
  extension: string
  /**
   * The tab it is on, out of the ones the extension declares, or empty for a
   * page that offers none. Kept here rather than worked out on every draw, so
   * the page does not jump back to the first tab on the beat that refreshes it.
   */
  tab: string
  /** How far back it is showing, the same three windows the Spend panel has. */
  window: SpendWindow
  scroll: number
  busy: false
}

export function extensionViewPanel(extension: string, tab = ''): ExtensionViewPanel {
  // Today, because that is what the person is looking at when they click the
  // strip — and because a page that opens on everything Jev has ever read made
  // the figure that matters the one that never changes.
  return { kind: 'extension-view', extension, tab, window: 'today', scroll: 0, busy: false }
}

/** Setting an extension up, or changing its settings: a guide, and fields. */
export interface ExtensionSetupPanel {
  kind: 'extension-setup'
  extension: string
  /** Which control the keyboard is on, of `setupControls`. */
  index: number
  /** Lines of the page scrolled past: the panel's place in the one scroll area. */
  scroll: number
  /** Whether the page follows the control the keyboard is on, until you scroll it. */
  following: boolean
  /** What is typed into each field, by key. */
  values: Record<string, string>
  busy: boolean
  error: string | null
  /** What saving came to: ready, or what it still needs. */
  said: string | null
}

/** A field on the setup panel, as the panel is given it. */
export interface SetupFieldView {
  key: string
  label: string
  help: string
  placeholder: string
  kind: 'text' | 'list' | 'map' | 'flag' | 'secret'
  /** What it offers to choose from, once looked up. */
  choices: readonly string[]
  /**
   * For a secret: where the one that is used comes from — `$TYPESAFE_API_KEY`
   * or `config.yaml` — or empty. The value is in `value` like any other
   * field's; this says which of the two the extension will actually read.
   */
  have?: string
}

export function extensionSetupPanel(
  extension: string,
  fields: readonly { key: string; value: string }[],
): ExtensionSetupPanel {
  return {
    kind: 'extension-setup',
    extension,
    index: 0,
    scroll: 0,
    following: true,
    values: Object.fromEntries(fields.map((field) => [field.key, field.value])),
    busy: false,
    error: null,
    said: null,
  }
}

/** The setup panel's controls in keyboard order: each field, the choices it offers, then save and close. */
export function setupControls(fields: readonly SetupFieldView[]): string[] {
  return [
    ...fields.flatMap((field) => [
      `field:${field.key}`,
      ...field.choices.map((choice) => `pick:${field.key}:${choice}`),
    ]),
    'save',
    'cancel',
  ]
}

export function setupKey(
  panel: ExtensionSetupPanel,
  key: string | undefined,
  data: string,
  fields: readonly SetupFieldView[],
): PanelOutcome {
  const controls = setupControls(fields)
  const at = controls[panel.index] ?? ''
  if (key === 'escape') return close
  if (panel.busy) return stay(panel)
  if (key === 'tab' || key === 'down')
    return stay({ ...panel, index: (panel.index + 1) % controls.length, following: true })
  if (key === 'shift+tab' || key === 'up') {
    return stay({
      ...panel,
      index: (panel.index - 1 + controls.length) % controls.length,
      following: true,
    })
  }
  // A page key reads on rather than walking, which is the wheel's own move
  // said with a key. Not space: in a field it types one.
  if (key === 'pageUp' || key === 'pageDown') {
    const by = pageBy(key)
    if (by !== null)
      return stay({ ...panel, scroll: Math.max(0, panel.scroll + by), following: false })
  }
  if (key === 'enter' || (key === 'space' && !at.startsWith('field:')))
    return setupPress(panel, at, fields)
  if (at.startsWith('field:')) {
    const field = fields.find((one) => `field:${one.key}` === at)
    if (!field) return stay(panel)
    const value = panel.values[field.key] ?? ''
    if (field.kind === 'flag') {
      return key === 'space' ? setupPress(panel, at, fields) : stay(panel)
    }
    if (key === 'backspace')
      return stay(setValue(panel, field.key, [...value].slice(0, -1).join('')))
    if (key === 'ctrl+u') return stay(setValue(panel, field.key, ''))
    if (key === 'space') return stay(setValue(panel, field.key, `${value} `))
    // A credential is pasted in far more often than it is typed — this is
    // where a Sentry DSN and a client key arrive — so `typed` reads the
    // markers a terminal wraps a paste in, and the break at the end of a
    // copied line is the clipboard's rather than part of the key.
    const text = typed(data, key)
    if (text) return stay(setValue(panel, field.key, value + text))
  }
  return stay(panel)
}

/** Pressing one of the setup panel's controls. */
export function setupPress(
  panel: ExtensionSetupPanel,
  at: string,
  fields: readonly SetupFieldView[],
): PanelOutcome {
  if (at === 'cancel') return close
  if (at === 'save')
    return {
      panel: { ...panel, busy: true, error: null, said: null },
      submit: true,
      choice: 'save',
    }
  if (at.startsWith('pick:')) {
    const [, key, ...rest] = at.split(':')
    return stay(setValue(panel, key ?? '', rest.join(':')))
  }
  const field = fields.find((one) => `field:${one.key}` === at)
  if (field?.kind === 'flag') {
    // Unset, on, off, and round again: unset is the extension's own default.
    const next = { '': 'on', on: 'off', off: '' }[panel.values[field.key] ?? ''] ?? ''
    return stay(setValue(panel, field.key, next))
  }
  // Enter in a text field moves on, as it would in a form.
  const controls = setupControls(fields)
  return stay({ ...panel, index: Math.min(controls.length - 1, panel.index + 1) })
}

function setValue(panel: ExtensionSetupPanel, key: string, value: string): ExtensionSetupPanel {
  return { ...panel, values: { ...panel.values, [key]: value }, error: null, said: null }
}

/** The page an extension writes about itself: nothing to answer, only to read. */
/** What a page offers, as the extension declared it: nothing is sniffed off the text. */
export interface ViewOffers {
  tabs: readonly { id: string }[]
  windowed: boolean
}

/**
 * The keys the page answers: tab moves through its tabs, ← → through its
 * windows, and the rest scrolls — exactly the Spend panel's, because a page
 * with tabs and a window is the same thing twice and nobody should have to
 * learn it in two places.
 *
 * A tab or a window changed is a different page, so it starts at the top.
 */
export function extensionViewKey(
  panel: ExtensionViewPanel,
  key: string | undefined,
  lines: number,
  at: ViewOffers = { tabs: [], windowed: false },
): PanelOutcome {
  const most = Math.max(0, lines - 1)
  if (key === 'escape' || key === 'enter') return close
  if ((key === 'tab' || key === 'shift+tab') && at.tabs.length > 1) {
    return stay({ ...panel, tab: cycle(at.tabs, panel.tab, key === 'tab' ? 1 : -1), scroll: 0 })
  }
  if ((key === 'left' || key === 'right') && at.windowed) {
    return stay({
      ...panel,
      window: cycle(SPEND_WINDOWS, panel.window, key === 'left' ? -1 : 1),
      scroll: 0,
    })
  }
  if (key === 'home') return stay({ ...panel, scroll: 0 })
  if (key === 'end') return stay({ ...panel, scroll: most })
  const by = pageBy(key)
  return by === null
    ? stay(panel)
    : stay({ ...panel, scroll: Math.max(0, Math.min(most, panel.scroll + by)) })
}

/**
 * A press on the page: a tab, a window, or Close.
 *
 * Held to what the page declared, the same as the keys are and through the same
 * two facts — a control the page never drew is a control nothing may press, and
 * a panel left on the seven-day window of a page that has no windows is a page
 * the window would then keep asking again for no reason.
 */
export function extensionViewClick(
  panel: ExtensionViewPanel,
  control: string,
  at: ViewOffers = { tabs: [], windowed: false },
): PanelOutcome {
  if (control === 'close') return close
  const [kind, id] = control.split(':')
  if (kind === 'tab' && id && at.tabs.some((tab) => tab.id === id)) {
    return stay({ ...panel, tab: id, scroll: 0 })
  }
  if (kind === 'window' && at.windowed && SPEND_WINDOWS.some((one) => one.id === id)) {
    return stay({ ...panel, window: id as SpendWindow, scroll: 0 })
  }
  return stay(panel)
}

/** The next one along, wrapping. The same move the Spend panel's tabs make. */
function cycle<T extends string>(options: readonly { id: T }[], current: T, delta: number): T {
  const at = options.findIndex((option) => option.id === current)
  return options[(at + delta + options.length) % options.length]?.id ?? current
}

export function setupClick(
  panel: ExtensionSetupPanel,
  control: string,
  fields: readonly SetupFieldView[],
): PanelOutcome {
  const index = setupControls(fields).indexOf(control)
  if (index < 0) return stay(panel)
  // A field is clicked into; anything else is pressed.
  return control.startsWith('field:') &&
    fields.find((one) => `field:${one.key}` === control)?.kind !== 'flag'
    ? stay({ ...panel, index })
    : setupPress({ ...panel, index }, control, fields)
}

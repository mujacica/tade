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
  scroll: number
  busy: false
}

export function extensionViewPanel(extension: string): ExtensionViewPanel {
  return { kind: 'extension-view', extension, scroll: 0, busy: false }
}

/** Setting an extension up, or changing its settings: a guide, and fields. */
export interface ExtensionSetupPanel {
  kind: 'extension-setup'
  extension: string
  /** Which control the keyboard is on, of `setupControls`. */
  index: number
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
   * For a secret: where the key it has now is (`$TYPESAFE_API_KEY`, `the
   * macOS keychain`), or empty. Never the key itself — nothing draws that.
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
    return stay({ ...panel, index: (panel.index + 1) % controls.length })
  if (key === 'shift+tab' || key === 'up') {
    return stay({ ...panel, index: (panel.index - 1 + controls.length) % controls.length })
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
export function extensionViewKey(
  panel: ExtensionViewPanel,
  key: string | undefined,
  lines: number,
): PanelOutcome {
  const most = Math.max(0, lines - 1)
  if (key === 'escape' || key === 'enter') return close
  const by =
    key === 'up' ? -1 : key === 'down' ? 1 : key === 'pageUp' ? -10 : key === 'pageDown' ? 10 : 0
  if (key === 'home') return stay({ ...panel, scroll: 0 })
  if (key === 'end') return stay({ ...panel, scroll: most })
  return by === 0
    ? stay(panel)
    : stay({ ...panel, scroll: Math.max(0, Math.min(most, panel.scroll + by)) })
}

export function extensionViewClick(panel: ExtensionViewPanel, control: string): PanelOutcome {
  return control === 'close' ? close : stay(panel)
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

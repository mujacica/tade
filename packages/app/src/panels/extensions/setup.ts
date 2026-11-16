import { SPEND_WINDOWS, type SpendWindow } from '../../spend.ts'
import { pageBy } from '../frame.ts'
import { close, type PanelOutcome, scrolled, stay, typed } from '../outcome.ts'

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
  /**
   * What is filled into each map field, a row per name, by key. A map is
   * names each with its values — which Sentry projects each of yours reports
   * to — and typed as one line of `a=b+c, d=e` it was a shape nobody could
   * guess and that dropped what it could not read.
   */
  maps: Record<string, readonly MapRow[]>
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
  /**
   * What it offers to choose from, once looked up. For a map, the names it
   * offers to add a row for: the open projects, where its names are those.
   */
  choices: readonly string[]
  /** For a map: whether one name may have several values beside it. */
  several?: boolean
  /**
   * For a secret: where the one that is used comes from — `$TYPESAFE_API_KEY`
   * or `config.yaml` — or empty. The value is in `value` like any other
   * field's; this says which of the two the extension will actually read.
   */
  have?: string
}

/** One row of a map field: a name, and its values as typed, a space between. */
export interface MapRow {
  key: string
  value: string
}

export function extensionSetupPanel(
  extension: string,
  fields: readonly { key: string; value: string }[],
  maps: Record<string, readonly MapRow[]> = {},
): ExtensionSetupPanel {
  return {
    kind: 'extension-setup',
    extension,
    index: 0,
    scroll: 0,
    following: true,
    values: Object.fromEntries(fields.map((field) => [field.key, field.value])),
    maps,
    busy: false,
    error: null,
    said: null,
  }
}

/**
 * The setup panel's controls in keyboard order: each field, the choices it
 * offers, then save and close. A map field is its rows — the name, the values
 * and the `×` of each — then a row to add for each name offered that has none
 * yet, then a row to add by typing its name.
 */
export function setupControls(
  fields: readonly SetupFieldView[],
  maps: Readonly<Record<string, readonly MapRow[]>> = {},
): string[] {
  return [
    ...fields.flatMap((field) =>
      field.kind === 'map'
        ? mapControls(field, maps[field.key] ?? [])
        : [`field:${field.key}`, ...field.choices.map((choice) => `pick:${field.key}:${choice}`)],
    ),
    'save',
    'cancel',
  ]
}

function mapControls(field: SetupFieldView, rows: readonly MapRow[]): string[] {
  return [
    ...rows.flatMap((_, i) => [
      `map:${field.key}:${i}:key`,
      `map:${field.key}:${i}:value`,
      `map:${field.key}:${i}:remove`,
    ]),
    ...unmapped(field, rows).map((name) => `map:${field.key}:add:${name}`),
    `map:${field.key}:add`,
  ]
}

/** The names a map field offers that have no row yet, in the order offered. */
export function unmapped(field: SetupFieldView, rows: readonly MapRow[]): string[] {
  return field.choices.filter((name) => !rows.some((row) => row.key.trim() === name))
}

/** A map row's text box, read out of its control: which field, which row, which half. */
function mapCell(at: string): { key: string; row: number; part: 'key' | 'value' } | null {
  const [kind, key, row, part] = at.split(':')
  if (kind !== 'map' || !key || !/^\d+$/.test(row ?? '')) return null
  return part === 'key' || part === 'value' ? { key, row: Number(row), part } : null
}

/** Whether a control is somewhere to type, rather than something to press. */
function typesInto(at: string): boolean {
  return at.startsWith('field:') || mapCell(at) !== null
}

export function setupKey(
  panel: ExtensionSetupPanel,
  key: string | undefined,
  data: string,
  fields: readonly SetupFieldView[],
): PanelOutcome {
  const controls = setupControls(fields, panel.maps)
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
    if (by !== null) return scrolled(panel, by)
  }
  if (key === 'enter' || (key === 'space' && !typesInto(at))) return setupPress(panel, at, fields)
  const cell = mapCell(at)
  if (cell) {
    const rows = panel.maps[cell.key] ?? []
    const text = rows[cell.row]?.[cell.part] ?? ''
    const put = (next: string) =>
      stay(
        setRows(
          panel,
          cell.key,
          rows.map((row, i) => (i === cell.row ? { ...row, [cell.part]: next } : row)),
        ),
      )
    if (key === 'backspace') return put([...text].slice(0, -1).join(''))
    if (key === 'ctrl+u') return put('')
    const typedHere = typed(data, key)
    return typedHere ? put(text + typedHere) : stay(panel)
  }
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
  if (at.startsWith('map:') && mapCell(at) === null) return mapPress(panel, at, fields)
  const field = fields.find((one) => `field:${one.key}` === at)
  if (field?.kind === 'flag') {
    // Unset, on, off, and round again: unset is the extension's own default.
    const next = { '': 'on', on: 'off', off: '' }[panel.values[field.key] ?? ''] ?? ''
    return stay(setValue(panel, field.key, next))
  }
  // Enter in a text field moves on, as it would in a form.
  const controls = setupControls(fields, panel.maps)
  return stay({ ...panel, index: Math.min(controls.length - 1, panel.index + 1) })
}

function setValue(panel: ExtensionSetupPanel, key: string, value: string): ExtensionSetupPanel {
  return { ...panel, values: { ...panel.values, [key]: value }, error: null, said: null }
}

function setRows(
  panel: ExtensionSetupPanel,
  key: string,
  rows: readonly MapRow[],
): ExtensionSetupPanel {
  return { ...panel, maps: { ...panel.maps, [key]: rows }, error: null, said: null }
}

/**
 * Adding a row to a map or taking one out, and the keyboard put where the
 * next thing to do is: a row added for a name offered is waiting for its
 * values, one added by hand for its name, and the row after one taken out has
 * its `×` under the keyboard, so pressing it again goes on down the list.
 */
function mapPress(
  panel: ExtensionSetupPanel,
  at: string,
  fields: readonly SetupFieldView[],
): PanelOutcome {
  const [, key = '', which = '', ...rest] = at.split(':')
  const rows = panel.maps[key] ?? []
  const focus = (next: ExtensionSetupPanel, control: string) => {
    const index = setupControls(fields, next.maps).indexOf(control)
    return stay({ ...next, index: index < 0 ? panel.index : index, following: true })
  }
  if (which === 'add') {
    const name = rest.join(':')
    const next = setRows(panel, key, [...rows, { key: name, value: '' }])
    return focus(next, `map:${key}:${rows.length}:${name === '' ? 'key' : 'value'}`)
  }
  const row = Number(which)
  if (rest[0] === 'remove' && Number.isInteger(row) && row < rows.length) {
    const left = rows.filter((_, i) => i !== row)
    const next = setRows(panel, key, left)
    return focus(
      next,
      left.length === 0 ? `map:${key}:add` : `map:${key}:${Math.min(row, left.length - 1)}:remove`,
    )
  }
  return stay(panel)
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
 * A tab or a window changed is a different page, so it starts at the top. Home
 * and end are as far as it goes either way, which the window knows and the
 * page does not: it went to its last line, a screen past where it is drawn.
 */
export function extensionViewKey(
  panel: ExtensionViewPanel,
  key: string | undefined,
  at: ViewOffers = { tabs: [], windowed: false },
): PanelOutcome {
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
  if (key === 'home') return scrolled(panel, Number.NEGATIVE_INFINITY)
  if (key === 'end') return scrolled(panel, Number.POSITIVE_INFINITY)
  const by = pageBy(key)
  return by === null ? stay(panel) : scrolled(panel, by)
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
  const index = setupControls(fields, panel.maps).indexOf(control)
  if (index < 0) return stay(panel)
  // A field is clicked into; anything else is pressed.
  return typesInto(control) && fields.find((one) => `field:${one.key}` === control)?.kind !== 'flag'
    ? stay({ ...panel, index })
    : setupPress({ ...panel, index }, control, fields)
}

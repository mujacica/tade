// Keys for the full view (§10 T4 of the Duo plan): what a phone's keyboard,
// a key row and a desk's keyboard type, as the bytes a terminal would send the
// window — because the window's own keymap runs on the phone (`FarFace.key`)
// and reads keys exactly as the machine's terminal hands them over.
//
// - **A row of the keys a phone's keyboard does not have**, above it: Esc,
//   Tab, a ctrl that holds for the next key, the arrows, F1 (the keys sheet),
//   ctrl+] (the leader, which hands the window a key while an agent has the
//   keyboard), ctrl+/ (the orchestrator's line) and ctrl+, (Settings).
// - **A hidden field at 16 px**, which is what the phone's keyboard types
//   into: at 16 px or more iOS does not zoom the page to it. It is emptied
//   after every key, so what it holds is never anybody's words for longer
//   than one event.
// - **A desk's keyboard** reaches the same field: a key the field would not
//   type — Escape, an arrow, ctrl and a letter — is read off `keydown` and
//   turned into its bytes here (`bytesOf`).

import { el } from './dom.js'

/** The bytes a terminal sends for the keys a phone's keyboard has none of. */
export const BYTES = {
  Escape: '\x1b',
  Tab: '\t',
  ShiftTab: '\x1b[Z',
  Enter: '\r',
  Backspace: '\x7f',
  Delete: '\x1b[3~',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  F1: '\x1bOP',
}

/** ctrl and a key that is not a letter, as the kitty keyboard protocol spells it (`CSI u`). */
const CTRL_CSI = { '/': '\x1b[47;5u', ',': '\x1b[44;5u', '.': '\x1b[46;5u' }

/**
 * A key as a terminal sends it, or null for one the field types itself (a
 * letter with no modifier) or none of ours (cmd, which is the browser's).
 */
export function bytesOf(key, { ctrl = false, shift = false, alt = false, meta = false } = {}) {
  if (meta) return null
  if (key === 'Tab' && shift) return BYTES.ShiftTab
  if (ctrl) {
    if (/^[a-z]$/i.test(key)) return String.fromCharCode(key.toLowerCase().charCodeAt(0) - 96)
    if (key === ']') return '\x1d'
    if (key === '[') return '\x1b'
    if (key === '\\') return '\x1c'
    if (key === ' ') return '\x00'
    const csi = CTRL_CSI[key]
    if (csi !== undefined) return csi
  }
  if (Object.hasOwn(BYTES, key)) return BYTES[key]
  if (alt && key.length === 1) return `\x1b${key}`
  return null
}

/** The key row, in the order it is drawn: a label, what it is called, and its bytes or `ctrl`. */
export const ROW = [
  { label: 'esc', name: 'Escape', bytes: BYTES.Escape },
  { label: 'tab', name: 'Tab', bytes: BYTES.Tab },
  { label: 'ctrl', name: 'Hold ctrl for the next key', bytes: 'ctrl' },
  { label: '←', name: 'Left', bytes: BYTES.ArrowLeft },
  { label: '↑', name: 'Up', bytes: BYTES.ArrowUp },
  { label: '↓', name: 'Down', bytes: BYTES.ArrowDown },
  { label: '→', name: 'Right', bytes: BYTES.ArrowRight },
  { label: '^]', name: 'The leader, ctrl+]', bytes: '\x1d' },
  { label: 'F1', name: 'The keys, F1', bytes: BYTES.F1 },
  { label: '^/', name: 'The orchestrator, ctrl+/', bytes: CTRL_CSI['/'] },
  { label: '^,', name: 'Settings, ctrl+,', bytes: CTRL_CSI[','] },
]

/**
 * The row in `bar` and the field in `host`; `send(bytes)` is the window's.
 * Returns what the page needs of them: to raise or drop the keyboard.
 */
export function keysOn(bar, host, send) {
  let ctrl = false
  const field = el('textarea', {
    class: 'fv-type',
    attrs: {
      'aria-label': 'Type to the window',
      autocapitalize: 'off',
      autocomplete: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'send',
      rows: '1',
    },
  })
  host.append(field)

  const press = (bytes) => {
    if (ctrl && bytes.length === 1 && /[a-z\]\\/, .]/i.test(bytes)) {
      const held = bytesOf(bytes, { ctrl: true })
      ctrl = false
      paintCtrl()
      if (held !== null) {
        send(held)
        return
      }
    }
    send(bytes)
  }

  const ctrlButton = { node: null }
  const paintCtrl = () => {
    ctrlButton.node?.setAttribute('aria-pressed', ctrl ? 'true' : 'false')
  }

  for (const key of ROW) {
    const button = el('button', {
      class: 'fv-key',
      text: key.label,
      attrs: { type: 'button', 'aria-label': key.name },
    })
    if (key.bytes === 'ctrl') {
      ctrlButton.node = button
      button.setAttribute('aria-pressed', 'false')
    }
    // Pressed on the way down, so the field keeps the focus and the keyboard stays up.
    button.addEventListener('pointerdown', (event) => event.preventDefault())
    button.addEventListener('click', () => {
      if (key.bytes === 'ctrl') {
        ctrl = !ctrl
        paintCtrl()
        return
      }
      ctrl = false
      paintCtrl()
      send(key.bytes)
    })
    bar.append(button)
  }

  // What the phone's keyboard typed: a letter, a word it completed, a paste.
  field.addEventListener('beforeinput', (event) => {
    const kind = event.inputType
    if (kind === 'deleteContentBackward') {
      event.preventDefault()
      send(BYTES.Backspace)
      return
    }
    if (kind === 'deleteContentForward') {
      event.preventDefault()
      send(BYTES.Delete)
      return
    }
    if (kind === 'insertLineBreak' || kind === 'insertParagraph') {
      event.preventDefault()
      send(BYTES.Enter)
      return
    }
    const data = event.data ?? event.dataTransfer?.getData('text/plain') ?? ''
    if (data === '') return
    event.preventDefault()
    // One character at a time where it is one, so a held ctrl reaches it.
    if ([...data].length === 1) press(data)
    else send(data.replace(/\r?\n/g, '\r'))
  })
  // Whatever got past `beforeinput` (an older keyboard, composition) is sent once it lands.
  field.addEventListener('input', () => {
    if (field.value === '') return
    send(field.value.replace(/\r?\n/g, '\r'))
    field.value = ''
  })
  field.addEventListener('keydown', (event) => {
    if (event.isComposing) return
    const bytes = bytesOf(event.key, {
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      meta: event.metaKey,
    })
    if (bytes === null) return
    event.preventDefault()
    ctrl = false
    paintCtrl()
    send(bytes)
  })

  return {
    raise: () => field.focus({ preventScroll: true }),
    drop: () => field.blur(),
    up: () => document.activeElement === field,
  }
}

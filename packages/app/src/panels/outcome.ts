import { pastedText } from '../input.ts'
import type { Panel } from '../panels.ts'

// What a press does to a panel, and the two answers every panel gives.
//
// Here rather than in `panels.ts` so that a panel's own `state.ts` can reach
// them without the dispatch reaching back: `panels.ts` imports each panel, each
// panel imports this, and the arrows only ever point down.

/** What a keystroke or click did: the panel as it now is, and whether to run it. */
export interface PanelOutcome {
  panel: Panel | null
  submit: boolean
  /** For a menu: which item was chosen. */
  choice?: string
}

export const stay = (panel: Panel): PanelOutcome => ({ panel, submit: false })
export const close: PanelOutcome = { panel: null, submit: false }

/** A control character: never something a person meant to type. */
export function control(char: string): boolean {
  const code = char.charCodeAt(0)
  return code < 32 || code === 127
}

/**
 * What a keystroke or a paste puts into a field that holds one line.
 *
 * A paste first, because a terminal wraps one in escape markers and every key
 * a field has no meaning for also begins with an escape: reading the markers
 * before the escape is the difference between a pasted key arriving and a
 * pasted key vanishing, which is what pasting a Sentry DSN into Settings did.
 *
 * Then whatever it is goes through `oneLine`, typing included — because a
 * terminal with bracketed paste turned off types a paste at us character for
 * character, and the rule that used to be here threw away the whole of
 * anything holding a control character, so such a paste vanished for the one
 * newline at the end of it.
 */
export function typed(data: string, key: string | undefined): string {
  if (key === 'space') return ' '
  const paste = pastedText(data)
  if (paste !== null) return oneLine(paste)
  // Every key a terminal reports and this field has no meaning for: an arrow,
  // a function key, a modifier held with a letter. None of them is text.
  if (data.startsWith('\x1b')) return ''
  return oneLine(data)
}

/**
 * Text as a field with room for one line takes it.
 *
 * The line breaks are what matter. A trailing one is the clipboard's rather
 * than the value's — copying a line out of a terminal or off a web page takes
 * the break at the end of it too — and in a field it must neither submit what
 * was pasted nor put a second line in something that has room for one. So the
 * ends are trimmed of breaks, a break inside becomes the single space it
 * reads as, and everything else a person cannot type is dropped.
 */
function oneLine(text: string): string {
  return [...text.replace(/^[\r\n]+|[\r\n]+$/g, '').replace(/[^\S\r\n]*[\r\n]+[^\S\r\n]*/g, ' ')]
    .filter((char) => !control(char))
    .join('')
}

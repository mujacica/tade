import { close, type PanelOutcome, stay } from '../outcome.ts'

// Bringing a chat back: the chats that were closed whose harness kept the
// conversation, and the other conversations a harness keeps for the folder a
// chat opens in. What is in the list is the subject's to find
// (`wire/chat-picker.ts`), by asking each harness's adapter; the drawing is
// beside this in `view.ts`.

/** Choosing a conversation to bring back into a chat in the lower pane. */
export interface ChatsPanel {
  kind: 'chats'
  index: number
  /** Lines of the list scrolled past: the panel's place in the one scroll area. */
  scroll: number
  /** Whether the list follows the row the keyboard is on; scrolling it yourself stops that. */
  following: boolean
  busy: boolean
  error: string | null
}

/** One conversation the panel offers, as the window has it. */
export interface ChatRow {
  /** What bringing it back is asked by, and survives the list being read again. */
  key: string
  /** A chat that was closed, or a conversation no chat of Tade's had. */
  kind: 'closed' | 'other'
  /** `claude-code 5` for a closed chat; the harness, as it is called, for another. */
  name: string
  /** Where it stands, as you would type it. */
  cwd: string
  /** When it closed, or was last written to; null where nobody heard it close. */
  at: number | null
  /** The first thing said in it, on one line. */
  first: string
}

/** What the panel draws: whether the harnesses are still being asked, what they said, and what could not be read. */
export interface ChatsView {
  looking: boolean
  rows: readonly ChatRow[]
  problems: readonly string[]
}

/** Rows a page key moves by. */
const PAGE = 5

export function chatsPanel(): ChatsPanel {
  return { kind: 'chats', index: 0, scroll: 0, following: true, busy: false, error: null }
}

function chosen(panel: ChatsPanel, row: ChatRow | undefined): PanelOutcome {
  return row
    ? { panel: { ...panel, busy: true, error: null }, submit: true, choice: row.key }
    : stay(panel)
}

export function chatsKey(
  panel: ChatsPanel,
  key: string | undefined,
  rows: readonly ChatRow[],
): PanelOutcome {
  if (key === 'escape') return close
  // One at a time: a second enter while the first is starting would start two.
  if (panel.busy) return stay(panel)
  const last = Math.max(0, rows.length - 1)
  const at = (index: number) => stay({ ...panel, index, following: true, error: null })
  if (key === 'up') return at(Math.max(0, panel.index - 1))
  if (key === 'down') return at(Math.min(last, panel.index + 1))
  if (key === 'pageUp') return at(Math.max(0, panel.index - PAGE))
  if (key === 'pageDown') return at(Math.min(last, panel.index + PAGE))
  if (key === 'home') return at(0)
  if (key === 'end') return at(last)
  if (key === 'enter') return chosen(panel, rows[panel.index])
  return stay(panel)
}

export function chatsClick(
  panel: ChatsPanel,
  control: string,
  rows: readonly ChatRow[],
): PanelOutcome {
  if (control === 'cancel') return close
  if (panel.busy || !control.startsWith('row:')) return stay(panel)
  const index = Number(control.slice('row:'.length))
  return chosen({ ...panel, index }, rows[index])
}

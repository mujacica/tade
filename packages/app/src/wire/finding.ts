import { matchingLines } from '@tade/workbench'
import type { Frame } from '../frame.ts'
import type { Panel } from '../panels.ts'

// Looking for text in a terminal's scrollback.
//
// Its own object because it is its own subject and holds its own state: the
// scrollback as it was read, and which terminal it was read from. The panel
// says what is being looked for; this says what there is to look through, and
// answers about the terminal the panel is actually open on — a find box opened
// on one terminal must never match lines read from another.

export class Finding {
  private held: { id: string; lines: string[] } | null = null

  /** Read a terminal's scrollback to look through. */
  async read(id: string, readTerminal: (id: string) => Promise<string>): Promise<void> {
    const text = await readTerminal(id).catch(() => '')
    this.held = { id, lines: text.split('\n') }
  }

  /** The scrollback the find box is looking through, and the line it is on. */
  view(panel: Panel | null): NonNullable<Frame['terminal']>['find'] {
    if (panel?.kind !== 'find' || this.held?.id !== panel.terminal) return null
    const matches = this.matches(panel)
    return {
      lines: this.held.lines,
      line: matches.length > 0 ? (matches[panel.index % matches.length] ?? null) : null,
      query: panel.query,
    }
  }

  /** The lines it matches, newest first, as line numbers into the scrollback read. */
  matches(panel: Panel | null): number[] {
    if (panel?.kind !== 'find' || this.held?.id !== panel.terminal || panel.query === '') return []
    return matchingLines(this.held.lines.join('\n'), panel.query, 10_000)
      .map((match) => match.line - 1)
      .reverse()
  }
}

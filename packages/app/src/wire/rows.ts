import type { ListRow, ListSection } from '@tade/extensions-core'
import type { Frame, RowSummaryView } from '../frame.ts'
import { type RowSummaryPanel, rowSummaryPanel } from '../panels/summary/state.ts'
import { type Wiring, why } from './context.ts'

// Clicking a row an extension keeps.
//
// Its own object because it is its own subject and holds its own state: which
// row was asked about and what came back. A row down the side says what it is
// in two rows and nothing more, because a side twenty-eight columns wide has
// nothing more; clicking one used to run the extension's tool and drop its
// markdown into the conversation, which is the right answer for a model and
// the wrong one for somebody who only wanted to look — the page you were on
// went away, and what came back was a wall of prose in a transcript.
//
// So a list that can say what one of its rows is gets a window instead, and
// putting it to the conversation is a button on that window. A list that
// cannot is clicked exactly as every list was before this existed.
//
// The extensions subject owns one of these, the way it owns nothing else —
// `wire/finding.ts` is the other object of this shape. It is not a subject of
// its own: the lists are the extensions' and so are the rows, and a second
// entry in `app.ts` for something that only ever answers about them would be
// wiring with nothing of its own to wire.

/** What this subject needs of the rest of the window. */
export interface RowsDeps {
  /** The sections extensions keep, as they last answered: whose row was clicked. */
  sections(): readonly ListSection[]
  openLink(url: string): Promise<void>
  /**
   * What a row opens, put to the conversation. The extensions subject's, not
   * this one's: it owns the host call and the line each one is given.
   */
  ask(row: ListRow): Promise<void>
}

export class Rows {
  private readonly wire: Wiring
  private readonly deps: RowsDeps
  /**
   * The row being read in front of you, and which row it is the answer to.
   *
   * Kept beside the panel rather than in it, because it is somebody else's
   * answer arriving after the click: the panel is opened at once and says it
   * is looking, and this is what fills it in. Which row it is for is kept with
   * it so a slow answer can never land under another row's name.
   */
  private shown: { section: string; row: string; summary: RowSummaryView } | null = null

  constructor(wire: Wiring, deps: RowsDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** What the open panel needs: only the answer to the row it is actually on. */
  panel(): Frame['panel'] {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'row-summary') return {}
    const shown = this.shown
    return {
      summary:
        shown && shown.section === panel.section && shown.row === panel.row ? shown.summary : null,
    }
  }

  /**
   * A row was clicked. A list that can say what one of its rows is puts it in
   * front of you; everything else is what clicking a row always did — the tool
   * the row names, or its link where it names none.
   */
  async open(section: string, id: string): Promise<void> {
    const host = this.wire.opts.extensions
    const found = this.deps.sections().find((one) => one.id === section)
    const row = found?.rows.find((one) => one.id === id)
    if (!host || !row) return
    if (found?.summarises) return void (await this.openSummary(section, row))
    if (!row.opens) {
      const link = row.links?.[0]
      if (link) await this.deps.openLink(link.url)
      return
    }
    await this.deps.ask(row)
  }

  /** Its two buttons: where it lives, and what the conversation makes of it. */
  async from(panel: RowSummaryPanel, choice: string): Promise<void> {
    const row = this.deps
      .sections()
      .find((one) => one.id === panel.section)
      ?.rows.find((one) => one.id === panel.row)
    if (choice === 'open') {
      const url = panel.url ?? row?.links?.[0]?.url
      if (url) await this.deps.openLink(url)
      return
    }
    if (choice === 'ask' && row) await this.deps.ask(row)
  }

  /**
   * One row, in front of you: the panel opens at once saying it is looking,
   * and the extension is asked while it is up.
   *
   * Opened before the ask, never after it, because an ask is a request and a
   * click that does nothing visible for a second is a click people make twice.
   */
  private async openSummary(section: string, row: ListRow): Promise<void> {
    const tade = this.wire.opts.extensionWorkbench
    const host = this.wire.opts.extensions
    this.shown = null
    this.wire.put({
      ...this.wire.state,
      panel: rowSummaryPanel(
        section,
        row.id,
        [row.label, row.title].filter(Boolean).join('  '),
        row.links?.[0]?.url ?? null,
      ),
    })
    this.wire.draw()
    if (!host || !tade) return
    try {
      this.settle(section, row.id, await host.summary(section, row.id, tade))
    } catch (err) {
      this.settle(section, row.id, null, why(err))
    }
  }

  /**
   * The panel is no longer looking: it has an answer, or the reason there is
   * none.
   *
   * Nothing at all happens where the panel has moved on to another row — the
   * answer is not kept either. Kept, it would be the *held* answer when the
   * row clicked next has already answered for itself: two clicks in a row,
   * the slower ask landing second, and the window drawn under the second
   * row's name with nothing in it.
   */
  private settle(
    section: string,
    row: string,
    summary: RowSummaryView | null,
    problem = summary ? null : 'Nothing more is known about it.',
  ): void {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'row-summary' || panel.section !== section || panel.row !== row) return
    if (summary) this.shown = { section, row, summary }
    this.wire.put({ ...this.wire.state, panel: { ...panel, busy: false, problem } })
    this.wire.draw()
  }
}

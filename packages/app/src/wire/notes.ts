import { notice } from '../model.ts'
import { notePanel } from '../panels/small/state.ts'
import type { Wiring } from './context.ts'

// Notes are the one thing Tade is told rather than derives, and this is the
// small subject that opens one, copies it and takes it back. Nothing here
// touches the words: `parseUtterance` recovered the original casing for a
// reason, and what is kept is what somebody said.

/** A note as the window knows it: when it was taken down, and what it says. */
export interface Note {
  at: string
  text: string
}

/** What this subject needs from the rest of the window. */
export interface NotesDeps {
  /** Put text on the system clipboard, and say so. */
  copy(text: string): Promise<void>
}

export class Notes {
  private readonly wire: Wiring
  private readonly deps: NotesDeps

  constructor(wire: Wiring, deps: NotesDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * Read a note on its own page.
   *
   * The headline, the scope and who took it down are looked up rather than
   * carried in: what a row was drawn from is the note's words, and the page
   * says everything that is known about it.
   */
  open(note: Note): void {
    const kept = this.wire.opts.client
      .recallAll()
      .find((one) => one.at === note.at && one.text === note.text)
    this.wire.put({
      ...this.wire.state,
      panel: notePanel(
        {
          at: note.at,
          summary: kept?.summary ?? null,
          scope: kept?.scope ?? null,
          by: kept?.by ?? 'unknown',
        },
        note.text,
      ),
    })
    this.wire.draw()
  }

  /** What a note's menu does: open it, copy its words, or forget it. */
  async fromMenu(note: Note, item: string): Promise<void> {
    if (item === 'edit') {
      this.open(note)
      return
    }
    if (item === 'copy') {
      await this.deps.copy(note.text)
      return
    }
    if (item === 'forget') this.forget(note)
  }

  /** Take a note back. It is not recalled again, by anyone, after a restart too. */
  forget(note: Note): void {
    const forgot = this.wire.opts.client.forget(note, 'window')
    this.wire.put(
      notice(this.wire.state, forgot ? 'forgot that note' : 'that note was already forgotten'),
    )
    this.wire.draw()
  }
}

import { scopesOf } from '@tade/core'
import { acknowledge } from '../flash.ts'
import type { Frame } from '../frame.ts'
import { noteMenuItems } from '../panels/menu/state.ts'
import { noteHeadlinePanel, notePanel, promptPanel } from '../panels/small/state.ts'
import {
  type Actions,
  flash,
  type Menus,
  type Prompts,
  promptFailed,
  type Subject,
  type Wiring,
} from './context.ts'

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

export class Notes implements Subject {
  private readonly wire: Wiring
  private readonly deps: NotesDeps

  constructor(wire: Wiring, deps: NotesDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** The notes about this project and about everything, as the side draws them. */
  facts(): Partial<Frame> {
    const project = this.wire.state.project
    return {
      notes: this.wire.live?.notes(project) ?? [],
      retiredNotes: this.wire.live?.retiredNotes(project) ?? [],
    }
  }

  actions(): Actions {
    return {
      'add-note': () => {
        this.wire.put({
          ...this.wire.state,
          panel: promptPanel(
            'note',
            'New note',
            `NOTE ABOUT ${(this.wire.state.project ?? 'THIS PROJECT').toUpperCase()}`,
          ),
        })
        this.wire.draw()
      },
      'forget-note:': (rest) => {
        const [at, ...text] = rest.split('\u0000')
        this.forget({ at: at ?? '', text: text.join('\u0000') })
      },
    }
  }

  menus(): Menus {
    return {
      note: {
        title: () => 'Note',
        items: () => noteMenuItems(),
        choose: (subject, item) => this.fromMenu(subject, item),
      },
    }
  }

  /**
   * A note is kept verbatim, so changing one says it again in its new words
   * and takes the old line back rather than editing anything: nothing can
   * recover what somebody said, and a line rewritten in place is a guess at it.
   */
  prompts(): Prompts {
    return {
      note: (panel, text) => {
        const scope = panel.everywhere ? null : this.wire.state.project
        const kept = this.wire.opts.client.remember(text, scope, 'window')
        // The same words twice are one note, and that is said rather than
        // looking as though a second one was taken.
        const said = kept.already === 'noted' ? 'already noted' : 'noted'
        this.wire.put(acknowledge({ ...this.wire.state, panel: null }, said, this.wire.now()))
      },
      'note-headline': (panel, text) => {
        const was = this.noteBehind(panel.target)
        if (!was) return promptFailed(this.wire, panel, 'That note is not there any more.')
        // Said again with the headline it is read by, and the old line taken
        // back: the words are handed over exactly as they were kept. Taken
        // back first, because the same words still there are already noted.
        this.wire.opts.client.forget({ at: was.at, text: was.text }, 'window')
        this.wire.opts.client.remember(was.text, scopesOf(was), 'window', text)
        this.wire.put(acknowledge({ ...this.wire.state, panel: null }, 'noted', this.wire.now()))
      },
      'edit-note': async (panel, text, choice) => {
        // A note's page offers what its menu does, and each does exactly the
        // same thing from either place.
        if (panel.note && (choice === 'copy' || choice === 'forget' || choice === 'headline')) {
          const note = {
            at: panel.note.at,
            text: (panel.target ?? '').split('\u0000').slice(1).join('\u0000'),
          }
          if (choice === 'copy') return this.deps.copy(note.text)
          if (choice === 'headline') {
            this.wire.put({ ...this.wire.state, panel: noteHeadlinePanel(panel.note, note.text) })
            this.wire.draw()
            return
          }
          this.wire.put({ ...this.wire.state, panel: null })
          this.forget(note)
          return
        }
        const was = this.noteBehind(panel.target)
        if (!was) return promptFailed(this.wire, panel, 'That note is not there any more.')
        if (was.text !== text) {
          // Said again in its new words, about what it was about, and the old
          // words taken back. The headline it was given goes with it: it says
          // what the note is for, which changing its wording does not.
          this.wire.opts.client.remember(text, scopesOf(was), 'window', was.summary ?? null)
          this.wire.opts.client.forget({ at: was.at, text: was.text }, 'window')
        }
        this.wire.put(acknowledge({ ...this.wire.state, panel: null }, 'noted', this.wire.now()))
      },
    }
  }

  /** The note a page is about, as memory still holds it: when it was said, and what. */
  private noteBehind(target: string | undefined) {
    const [at = '', ...said] = (target ?? '').split('\u0000')
    const text = said.join('\u0000')
    return this.wire.opts.client
      .recallAll({ retired: true })
      .find((one) => one.at === at && one.text === text)
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
      .recallAll({ retired: true })
      .find((one) => one.at === note.at && one.text === note.text)
    this.wire.put({
      ...this.wire.state,
      panel: notePanel(
        {
          at: note.at,
          summary: kept?.summary ?? null,
          scope: kept?.scope ?? null,
          ...(kept?.also ? { also: kept.also } : {}),
          by: kept?.by ?? 'unknown',
          ...(kept?.retired ? { retired: kept.retired } : {}),
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
    flash(this.wire, forgot ? 'forgot that note' : 'that note was already forgotten')
    this.wire.draw()
  }
}

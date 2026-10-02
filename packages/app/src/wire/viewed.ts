import type { ParsedDiff } from '../diff.ts'
import { type InlineRow, inlineRows } from '../panels/file/inline.ts'
import { fileViewSize } from '../panels/file/view.ts'
import {
  type Edited,
  editedText,
  formattable,
  formattedLines,
  readForView,
  saveEdited,
  sourceLines,
  textLines,
  type ViewedFile,
} from '../viewer.ts'

// The file the window has open, and everything worked out about it once.
//
// The viewer keeps the file it read rather than reading again per frame: a file
// is coloured as a whole file, Markdown is laid out for the width it has, and
// what git says about it is a pass over the whole of it — so all three are kept
// beside the lines and redone only when what they are made of moves.
//
// It is here rather than in `files.ts` because none of it is about what is on
// disk *here*: the tree, the marks, the branches and the changes are one
// question — what git says about this checkout — and this is the other, which
// is one file, read.

/** What the drawing is handed about the open file. */
export interface Showing {
  file: ViewedFile
  source: readonly string[]
  text: readonly string[]
  formatted: readonly string[] | null
  inline: readonly InlineRow[] | null
}

/** The file read in, with its colouring, its layout and git's answer beside it. */
interface Held {
  file: ViewedFile
  source: string[]
  /** The same lines uncoloured: what a find looks through and a caret counts in. */
  text: string[]
  formatted: { width: number; lines: string[] } | null
  /** What git says about it, once somebody has asked. */
  diff: ParsedDiff | null
  /**
   * Whose changes the diff is of — a task, or the checkout itself. Kept so the
   * same question can be asked again after a save, rather than guessed at then.
   */
  task: string | null
  /**
   * The rows git's answer makes of the file, and the edit they were worked out
   * from. `from` is `Edited.from` by identity: an edit is replaced wholesale on
   * every keystroke, so the one that is still the same object is the one whose
   * rows still stand.
   */
  rows: { from: readonly number[] | null; count: number; shown: InlineRow[] | null } | null
}

export class Viewed {
  private held: Held | null = null

  /** Read a file in, throwing away whatever was open. */
  open(path: string, plain: boolean): void {
    const file = readForView(path)
    this.held = {
      file,
      source: sourceLines(file, plain),
      text: textLines(file),
      formatted: null,
      diff: null,
      task: null,
      rows: null,
    }
  }

  /** Whether this is the file that is open. */
  has(path: string): boolean {
    return this.held?.file.path === path
  }

  file(): ViewedFile | null {
    return this.held?.file ?? null
  }

  /** Its own lines, uncoloured — and only while it is the file asked about. */
  text(path: string): readonly string[] {
    return this.has(path) ? (this.held?.text ?? []) : []
  }

  /** Whether the file can be read formatted as well as as source. */
  markdown(): boolean {
    const file = this.held?.file
    return file !== undefined && formattable(file)
  }

  /** What git says about it, once asked, and whose changes that was. */
  diff(): ParsedDiff | null {
    return this.held?.diff ?? null
  }

  about(): string | null {
    return this.held?.task ?? null
  }

  /**
   * What git said, kept with the file it is about — and only if that is still
   * the file open, because a slow git must never draw one file's changes into
   * another. Says whether it was taken.
   */
  tell(path: string, task: string | null, diff: ParsedDiff | null): boolean {
    const held = this.held
    if (!held || held.file.path !== path) return false
    held.diff = diff
    held.task = task
    held.rows = null
    return true
  }

  /**
   * The rows the file is drawn as with git's answer laid into them, for the
   * edit as it stands — or nothing, where nobody has asked git yet.
   *
   * Worked out once per edit rather than per frame: it is a pass over the whole
   * file, and the file is drawn four times a second.
   */
  rows(edit: Edited | null): readonly InlineRow[] | null {
    const held = this.held
    if (!held?.diff) return null
    const from = edit?.from ?? null
    const count = edit ? edit.lines.length : held.text.length
    if (held.rows?.from !== from || held.rows.count !== count) {
      held.rows = { from, count, shown: inlineRows(held.diff, from, count) }
    }
    return held.rows.shown
  }

  /** What the viewer draws, with Markdown laid out for the width it has now. */
  showing(width: number, height: number, plain: boolean, edit: Edited | null): Showing | null {
    const held = this.held
    if (!held) return null
    const inline = this.rows(edit)
    if (!formattable(held.file))
      return { file: held.file, source: held.source, text: held.text, formatted: null, inline }
    const room = fileViewSize(width, height).width - 4
    if (held.formatted?.width !== room) {
      held.formatted = { width: room, lines: formattedLines(held.file, room, plain) }
    }
    return {
      file: held.file,
      source: held.source,
      text: held.text,
      formatted: held.formatted.lines,
      inline,
    }
  }

  /**
   * How much there is to scroll through, as the panel is showing it: rows where
   * git's answer is drawn in, and lines where it is not.
   *
   * Through `showing`, which is what the drawing reads, so the two can never
   * disagree about how many there are — and so the Markdown is laid out at the
   * width and in the colour it is actually drawn in.
   */
  lines(at: {
    edit: Edited | null
    formatted: boolean
    inline: boolean
    width: number
    height: number
    plain: boolean
  }): number {
    const held = this.held
    if (!held) return 0
    const showing = this.showing(at.width, at.height, at.plain, at.edit)
    if (at.inline && showing?.inline) return showing.inline.length
    if (at.edit) return at.edit.lines.length
    return at.formatted && showing?.formatted ? showing.formatted.length : held.source.length
  }

  /**
   * Write what was typed into the file back, and read it again — so what is on
   * screen is what is on disk, coloured as a whole file rather than line by
   * line. Throws what the viewer throws, with nothing lost: the file stays open
   * and everything typed is still in it.
   */
  save(edit: Edited, plain: boolean): readonly string[] {
    const held = this.held
    if (!held) throw new Error('There is no file open to save.')
    const file = saveEdited(held.file, editedText(edit, held.file))
    this.held = {
      file,
      source: sourceLines(file, plain),
      text: textLines(file),
      formatted: null,
      // What git said is about the file as it was: it is asked again now.
      diff: null,
      task: held.task,
      rows: null,
    }
    return this.held.text
  }
}

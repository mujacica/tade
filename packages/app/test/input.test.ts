import { Editor, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import {
  caretOf,
  cellsOf,
  clickedSpan,
  cutSpan,
  lineAt,
  lineKey,
  offsetOf,
  placeOf,
  putCaret,
  rowStarts,
  spanOf,
  withSelection,
  wordAt,
} from '../src/input.ts'
import { COLOUR, PLAIN } from '../src/skin.ts'

// Selecting text in the line you type on. All of it is arithmetic over a
// string: what a second click takes, what a key does to what is selected,
// and which cells of a drawn row it covers. None of it needs a terminal.

describe('a selection', () => {
  it('reads the same whichever way it was made, and is nothing when it covers nothing', () => {
    expect(spanOf({ anchor: 9, head: 3 })).toEqual({ from: 3, to: 9 })
    expect(spanOf({ anchor: 3, head: 9 })).toEqual({ from: 3, to: 9 })
    expect(spanOf({ anchor: 4, head: 4 })).toBeNull()
    expect(spanOf(null)).toBeNull()
  })
})

describe('an offset and a place', () => {
  const lines = ['why is', 'refunds', '', 'slow']

  it('are the same position said two ways', () => {
    for (let at = 0; at <= lines.join('\n').length; at++) {
      expect(offsetOf(lines, placeOf(lines, at))).toBe(at)
    }
  })

  it('counts the newline between two lines', () => {
    expect(offsetOf(lines, { line: 1, col: 0 })).toBe(7)
    expect(placeOf(lines, 7)).toEqual({ line: 1, col: 0 })
    expect(placeOf(lines, 15)).toEqual({ line: 2, col: 0 })
  })

  it('clamps a place past the end of what there is', () => {
    expect(offsetOf(lines, { line: 9, col: 9 })).toBe(lines.join('\n').length)
    expect(placeOf(lines, 999)).toEqual({ line: 3, col: 4 })
  })
})

describe('what a click takes', () => {
  const text = 'why is refunds slow'

  it('takes the word under it on the second press', () => {
    expect(wordAt(text, 9)).toEqual({ from: 7, to: 14 })
    expect(text.slice(7, 14)).toBe('refunds')
  })

  it('takes the word it is at either end of', () => {
    expect(wordAt(text, 7)).toEqual({ from: 7, to: 14 })
    expect(wordAt(text, 14)).toEqual({ from: 7, to: 14 })
  })

  it('takes the run of spaces between words when that is all there is', () => {
    expect(wordAt('why   is', 5)).toEqual({ from: 3, to: 6 })
  })

  it('takes punctuation as its own run', () => {
    expect(wordAt('tade_status(...)', 12)).toEqual({ from: 11, to: 16 })
  })

  it('takes nothing on an empty line', () => {
    expect(wordAt('a\n\nb', 2)).toEqual({ from: 2, to: 2 })
  })

  it('takes the line on the third press, without the break that ends it', () => {
    const lines = 'first line\nsecond line\nthird'
    expect(lineAt(lines, 3)).toEqual({ from: 0, to: 10 })
    expect(lineAt(lines, 12)).toEqual({ from: 11, to: 22 })
    expect(lineAt(lines, 25)).toEqual({ from: 23, to: 28 })
  })

  it('puts the caret down and selects nothing on the first press', () => {
    expect(clickedSpan(text, 4, 1)).toEqual({ from: 4, to: 4 })
    expect(clickedSpan(text, 9, 2)).toEqual({ from: 7, to: 14 })
    expect(clickedSpan(text, 9, 3)).toEqual({ from: 0, to: text.length })
  })
})

describe('what a key means to the line', () => {
  it('selects everything with ctrl+a and cmd+a', () => {
    expect(lineKey('ctrl+a')).toEqual({ do: 'select all' })
    expect(lineKey('super+a')).toEqual({ do: 'select all' })
    expect(lineKey('a')).toBeNull()
  })

  it('names backspace and delete, either way round', () => {
    expect(lineKey('backspace')).toEqual({ do: 'delete', forward: false })
    expect(lineKey('delete')).toEqual({ do: 'delete', forward: true })
  })

  it('names a motion, how far it goes and whether it takes the selection with it', () => {
    expect(lineKey('left')).toEqual({ do: 'move', by: 'char', back: true, extend: false })
    expect(lineKey('shift+right')).toEqual({ do: 'move', by: 'char', back: false, extend: true })
    expect(lineKey('alt+left')).toEqual({ do: 'move', by: 'word', back: true, extend: false })
    expect(lineKey('shift+ctrl+right')).toEqual({
      do: 'move',
      by: 'word',
      back: false,
      extend: true,
    })
    expect(lineKey('shift+home')).toEqual({ do: 'move', by: 'line', back: true, extend: true })
    expect(lineKey('shift+up')).toEqual({ do: 'move', by: 'row', back: true, extend: true })
  })

  it('leaves everything else to the editor', () => {
    for (const key of ['ctrl+w', 'ctrl+k', 'enter', 'escape', 'tab', 'ctrl+r', null])
      expect(lineKey(key)).toBeNull()
  })
})

// Rows as pi's editor draws them: one column of padding, the text, then
// spaces out to the width. The caret is a reversed cell in the middle of it.
const PAD = 1
const WIDTH = 20
const drawRow = (text: string) => ` ${text}${' '.repeat(Math.max(0, WIDTH - 2 - text.length))} `

describe('the rows the editor drew', () => {
  it('are placed in the text by what they say, not by wrapping it again', () => {
    const text = 'why is refunds slow'
    const rows = [drawRow('why is refunds'), drawRow('slow')]
    expect(rowStarts(rows, text, PAD).map((row) => row.at)).toEqual([0, 15])
  })

  it('places an empty line, and the blank row a caret sits on', () => {
    const text = 'one\n\ntwo'
    const rows = [drawRow('one'), drawRow(''), drawRow('two')]
    expect(rowStarts(rows, text, PAD).map((row) => row.at)).toEqual([0, 4, 5])
  })

  it('places a row with the caret drawn in it', () => {
    const text = 'refunds'
    const rows = [` re\x1b[7mf\x1b[0munds${' '.repeat(WIDTH - 9)} `]
    expect(rowStarts(rows, text, PAD).map((row) => row.at)).toEqual([0])
  })

  it('leaves a row it cannot place alone rather than guessing', () => {
    expect(rowStarts([drawRow('nowhere')], 'something else', PAD)[0]?.at).toBeNull()
  })
})

describe('the cells a selection covers', () => {
  const text = 'why is refunds slow'
  const rows = rowStarts([drawRow('why is refunds'), drawRow('slow')], text, PAD)

  it('are the columns of the row it is on, padding counted in', () => {
    // "refunds" on the first row: seven cells, one column in from the edge.
    expect(cellsOf(rows[0] as never, text, { from: 7, to: 14 }, PAD)).toEqual({ from: 8, to: 15 })
    expect(cellsOf(rows[1] as never, text, { from: 7, to: 14 }, PAD)).toBeNull()
  })

  it('takes one more cell where a line break is inside it', () => {
    const wrapped = 'one\ntwo'
    const both = rowStarts([drawRow('one'), drawRow('two')], wrapped, PAD)
    expect(cellsOf(both[0] as never, wrapped, { from: 1, to: 6 }, PAD)).toEqual({ from: 2, to: 5 })
  })

  it('counts a wide character as the two cells it takes', () => {
    const wide = '半角 x'
    const row = rowStarts([drawRow(wide)], wide, PAD)[0] as never
    expect(cellsOf(row, wide, { from: 0, to: 2 }, PAD)).toEqual({ from: 1, to: 5 })
  })
})

describe('the line with its selection laid on', () => {
  const text = 'why is refunds slow'
  const rows = [drawRow('why is refunds'), drawRow('slow')]

  it('paints the selected cells and moves nothing', () => {
    const lit = withSelection(rows, text, { from: 7, to: 14 }, COLOUR, PAD, WIDTH)
    expect(lit[0]).toContain('\x1b[48;5;')
    expect(lit[1]).toBe(rows[1])
    for (const row of lit) expect(visibleWidth(row)).toBe(WIDTH)
  })

  it('leaves the text itself exactly as it was drawn', () => {
    const lit = withSelection(rows, text, { from: 0, to: text.length }, COLOUR, PAD, WIDTH)
    expect(lit.map((row) => stripTerminalSequences(row))).toEqual(rows)
  })

  it('changes nothing where the skin has no colour to lay under it', () => {
    expect(withSelection(rows, text, { from: 0, to: 4 }, PLAIN, PAD, WIDTH)).toEqual(rows)
  })
})

// Against pi's own editor, which is what holds the line: the selection is
// worked on it by pressing the keys a person would press, so these are the
// tests that say the two agree about where the caret is and what one press
// takes. It needs no terminal — the editor asks its TUI for two things.
class FakeTui {
  terminal = { rows: 40, columns: 80 }
  requestRender(): void {}
}

const plainly = (text: string) => text
const held = (text: string): Editor => {
  const editor = new Editor(
    new FakeTui() as never,
    {
      borderColor: plainly,
      selectList: {
        selectedPrefix: plainly,
        selectedText: plainly,
        description: plainly,
        scrollInfo: plainly,
        noMatch: plainly,
      },
    },
    { paddingX: PAD },
  )
  editor.setText(text)
  editor.render(WIDTH)
  return editor
}

describe('the caret, put where a selection needs it', () => {
  it('reaches every offset of a line that wraps and a line that does not', () => {
    const text = 'why is refunds slow\nbecause the webhook retries twice\n\nand charges again'
    const editor = held(text)
    for (const at of [0, 5, 19, 20, 33, 52, 53, text.length, 7]) {
      putCaret(editor, at)
      expect(caretOf(editor)).toBe(at)
    }
  })

  it('stops at the ends rather than spinning past them', () => {
    const editor = held('short')
    putCaret(editor, 99)
    expect(caretOf(editor)).toBe(5)
    putCaret(editor, -4)
    expect(caretOf(editor)).toBe(0)
  })
})

describe('a selection taken out of the line', () => {
  it('leaves the text either side of it, and the caret where it was', () => {
    const editor = held('why is refunds slow')
    cutSpan(editor, { from: 7, to: 15 })
    expect(editor.getText()).toBe('why is slow')
    expect(caretOf(editor)).toBe(7)
  })

  it('takes a selection that runs over a line break with it', () => {
    const editor = held('first line\nsecond line')
    cutSpan(editor, { from: 5, to: 17 })
    expect(editor.getText()).toBe('first line')
    expect(caretOf(editor)).toBe(5)
  })

  it('empties the line when everything is selected', () => {
    const editor = held('all of it\nevery line')
    cutSpan(editor, { from: 0, to: 20 })
    expect(editor.getText()).toBe('')
    expect(caretOf(editor)).toBe(0)
  })

  it('takes a word double clicked, and typing after it goes where it was', () => {
    const text = 'why is refunds slow'
    const editor = held(text)
    const word = clickedSpan(text, 9, 2)
    cutSpan(editor, word)
    editor.handleInput('p')
    expect(editor.getText()).toBe('why is p slow')
  })

  it('takes a character as the editor counts one, emoji and all', () => {
    const editor = held('a 👍🏽 b')
    cutSpan(editor, { from: 2, to: 2 + '👍🏽'.length })
    expect(editor.getText()).toBe('a  b')
  })
})

describe('a click on a row of the line', () => {
  // The rows the window draws are the editor's own, minus the rules above
  // and below them: row `n` of them is the editor's `n + 1`. This is the one
  // number a selection by mouse depends on, so it is the one worth pinning.
  const click = (editor: Editor, line: number, x: number) =>
    editor.handleMouse({
      type: 'click',
      button: 'left',
      x,
      y: line + 1,
      screenX: x,
      screenY: 0,
      width: WIDTH,
      height: 40,
      shift: false,
      alt: false,
      ctrl: false,
    })

  it('puts the caret under the pointer, padding counted in', () => {
    const editor = held('why is refunds slow')
    click(editor, 0, 1 + 7)
    expect(caretOf(editor)).toBe(7)
  })

  it('counts the row it was on, not the line the text is on', () => {
    const text = 'first line\nsecond line'
    const editor = held(text)
    click(editor, 1, 1 + 3)
    expect(caretOf(editor)).toBe('first line\nsec'.length)
  })

  it('agrees with the rows the window placed in the text', () => {
    const text = 'first line\nsecond line'
    const editor = held(text)
    const rows = rowStarts(editor.render(WIDTH).slice(1, -1), text, PAD)
    click(editor, 1, PAD)
    expect(caretOf(editor)).toBe(rows[1]?.at)
  })
})

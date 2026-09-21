import { readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { offsetOf, placeOf } from '../src/input.ts'
import {
  caretAt,
  cellOf,
  columnOf,
  cutSelection,
  type Edited,
  editable,
  editedText,
  editFrom,
  editKey,
  formattable,
  formattedLines,
  leftOf,
  matchesIn,
  readForView,
  saveEdited,
  sourceLines,
  textLines,
  typeIn,
} from '../src/viewer.ts'

// A file, read for the viewer from a real disk.

describe('reading a file to look at', () => {
  it('reads text, and knows its language', () => {
    const dir = tmp('tade-view-')
    writeFileSync(join(dir, 'app.ts'), 'const a = 1\nconst b = 2\n')
    const file = readForView(join(dir, 'app.ts'))
    expect(file).toMatchObject({
      binary: false,
      truncated: false,
      language: 'typescript',
      error: null,
    })
    // No empty line for the newline at the end.
    expect(sourceLines(file, true)).toEqual(['const a = 1', 'const b = 2'])
  })

  it('says a binary file is one, rather than showing it', () => {
    const dir = tmp('tade-view-')
    writeFileSync(join(dir, 'logo.png'), Buffer.from([137, 80, 78, 71, 0, 0, 1]))
    const file = readForView(join(dir, 'logo.png'))
    expect(file.binary).toBe(true)
    expect(sourceLines(file, true)).toEqual([])
  })

  it('reads only the start of a big file, and says so', () => {
    const dir = tmp('tade-view-')
    writeFileSync(join(dir, 'big.log'), 'x'.repeat(5_000))
    const file = readForView(join(dir, 'big.log'), 1_000)
    expect(file.truncated).toBe(true)
    expect(file.text).toHaveLength(1_000)
  })

  it('says why when a file cannot be read', () => {
    expect(readForView('/nowhere/at/all.ts').error).toBe('It is not there any more.')
  })

  it('lays Markdown out, and offers it only for Markdown', () => {
    const dir = tmp('tade-view-')
    writeFileSync(join(dir, 'README.md'), '# Title\n\nSome **bold** words.\n')
    const file = readForView(join(dir, 'README.md'))
    expect(formattable(file)).toBe(true)
    const text = formattedLines(file, 40, true)
      .map((line) => stripTerminalSequences(line))
      .join('\n')
    expect(text).toContain('Some bold words.')
    expect(text).not.toContain('**')
    expect(formattable(readForView(join(dir, 'nope.md')))).toBe(false)
  })

  it('gives the same lines uncoloured, one for one with the coloured ones', () => {
    const dir = tmp('tade-view-')
    writeFileSync(join(dir, 'app.ts'), "const a = 'x'\nconst b = 2\n")
    const file = readForView(join(dir, 'app.ts'))
    expect(textLines(file)).toEqual(["const a = 'x'", 'const b = 2'])
    expect(textLines(file)).toHaveLength(sourceLines(file, false).length)
  })
})

describe('finding in a file', () => {
  const lines = ['const event = 1', 'if (event) return Event', '']

  it('finds every place, ignoring case until a capital is typed', () => {
    expect(matchesIn(lines, 'event')).toEqual([
      { line: 0, column: 6, length: 5 },
      { line: 1, column: 4, length: 5 },
      { line: 1, column: 18, length: 5 },
    ])
    expect(matchesIn(lines, 'Event')).toEqual([{ line: 1, column: 18, length: 5 }])
    expect(matchesIn(lines, '')).toEqual([])
  })

  it('stops counting long before anyone could page through them', () => {
    const many = Array.from({ length: 200 }, () => 'aaaaa')
    expect(matchesIn(many, 'a', 50)).toHaveLength(50)
  })
})

describe('typing into a file', () => {
  const lines = ['function one() {', '\treturn 1', '}']

  it('refuses the files that are not there to be typed into', () => {
    const dir = tmp('tade-edit-')
    writeFileSync(join(dir, 'logo.png'), Buffer.from([137, 80, 78, 71, 0, 0, 1]))
    expect(editable(readForView(join(dir, 'logo.png')))).toContain('binary')
    writeFileSync(join(dir, 'big.log'), 'x'.repeat(5_000))
    expect(editable(readForView(join(dir, 'big.log'), 1_000))).toContain('open it in your editor')
    writeFileSync(join(dir, 'app.ts'), 'const a = 1\n')
    expect(editable(readForView(join(dir, 'app.ts')))).toBeNull()
  })

  it('puts a caret down inside the text, wherever it was aimed', () => {
    const edit = editFrom(lines, 9, 400)
    expect([edit.row, edit.column]).toEqual([2, 1])
    expect(edit.dirty).toBe(false)
    // Every line still comes from the file, so every line keeps its colour.
    expect(edit.from).toEqual([0, 1, 2])
  })

  it('types where the caret is, and only that line stops coming from the file', () => {
    const edit = typeIn(editFrom(lines, 0, 16), ' // hi')
    expect(edit.lines[0]).toBe('function one() { // hi')
    expect(edit.column).toBe(22)
    expect(edit.dirty).toBe(true)
    expect(edit.from).toEqual([-1, 1, 2])
  })

  it('splits a line on enter, under the indentation it was under', () => {
    const edit = editKey(editFrom(lines, 1, 9), 'enter')
    expect(edit?.lines).toEqual(['function one() {', '\treturn 1', '\t', '}'])
    expect([edit?.row, edit?.column]).toEqual([2, 1])
  })

  it('pastes lines as they came, indenting nothing again', () => {
    const edit = typeIn(editFrom(lines, 1, 9), '\n\tconst x = 1\n\treturn x')
    expect(edit.lines).toEqual([
      'function one() {',
      '\treturn 1',
      '\tconst x = 1',
      '\treturn x',
      '}',
    ])
  })

  it('joins lines back with backspace at the front and delete at the end', () => {
    const joined = editKey(editFrom(lines, 1, 0), 'backspace')
    expect(joined?.lines).toEqual(['function one() {\treturn 1', '}'])
    expect([joined?.row, joined?.column]).toEqual([0, 16])
    const ahead = editKey(editFrom(lines, 0, 16), 'delete')
    expect(ahead?.lines).toEqual(['function one() {\treturn 1', '}'])
    expect([ahead?.row, ahead?.column]).toEqual([0, 16])
  })

  it('walks off the end of a line onto the next one', () => {
    expect(editKey(editFrom(lines, 0, 16), 'right')).toMatchObject({ row: 1, column: 0 })
    expect(editKey(editFrom(lines, 1, 0), 'left')).toMatchObject({ row: 0, column: 16 })
    expect(editKey(editFrom(lines, 0, 0), 'left')).toMatchObject({ row: 0, column: 0 })
  })

  it('types what the file indents with, not what this file happens to prefer', () => {
    expect(editKey(editFrom(lines, 2, 0), 'tab')?.lines[2]).toBe('\t}')
    expect(editKey(editFrom(['const a = 1', '  const b = 2'], 0, 0), 'tab')?.lines[0]).toBe(
      '  const a = 1',
    )
  })

  it('crosses a word with ctrl and alt, and the line break when there is none left', () => {
    const words = ['const total = 1', 'done()']
    expect(editKey(editFrom(words, 0, 0), 'ctrl+right')).toMatchObject({ row: 0, column: 5 })
    expect(editKey(editFrom(words, 0, 5), 'alt+right')).toMatchObject({ row: 0, column: 11 })
    expect(editKey(editFrom(words, 0, 11), 'ctrl+left')).toMatchObject({ row: 0, column: 6 })
    // Nothing left to cross on this line, so it goes off the end of it as
    // the plain arrow does.
    expect(editKey(editFrom(words, 0, 0), 'ctrl+left')).toMatchObject({ row: 0, column: 0 })
    expect(editKey(editFrom(words, 1, 0), 'ctrl+left')).toMatchObject({ row: 0, column: 15 })
    expect(editKey(editFrom(words, 0, 15), 'ctrl+right')).toMatchObject({ row: 1, column: 0 })
  })

  it('leaves keys it does not know to the panel, ctrl+a included', () => {
    expect(editKey(editFrom(lines), 'ctrl+s')).toBeNull()
    expect(editKey(editFrom(lines), 'escape')).toBeNull()
    // What a key means to text with a selection in it is `lineKey`'s to say,
    // and it reads ctrl+a as selecting everything. Home is the start of the line.
    expect(editKey(editFrom(lines, 1, 4), 'ctrl+a')).toBeNull()
    expect(editKey(editFrom(lines, 1, 4), 'home')).toMatchObject({ row: 1, column: 0 })
  })

  describe('a selection taken out of it', () => {
    // What it must agree with: the caret at the far end of the span, and the
    // editor's own backspace pressed until it reaches the near one. That is
    // what a person does by hand, and it is the whole definition of what one
    // press takes — `cutSelection` only has to be faster, never different.
    const pressed = (edit: Edited, span: { from: number; to: number }) => {
      const end = placeOf(edit.lines, span.to)
      let out = caretAt(edit, end.line, end.col)
      for (let guard = span.to - span.from; guard > 0; guard--) {
        if (offsetOf(out.lines, { line: out.row, col: out.column }) <= span.from) break
        const back = editKey(out, 'backspace')
        if (!back || back === out) break
        out = back
      }
      return out
    }

    it('says exactly what holding backspace over it says', () => {
      const file = ['function one() {', '', '\treturn 1', '', '}', 'const after = 2']
      const whole = file.join('\n').length
      for (const span of [
        { from: 0, to: 0 },
        { from: 3, to: 8 },
        { from: 9, to: 20 },
        { from: 0, to: 17 },
        { from: 16, to: 30 },
        { from: 2, to: whole },
        { from: 0, to: whole },
      ]) {
        const edit = editFrom(file, 0, 0)
        const cut = cutSelection(edit, span)
        const byHand = pressed(edit, span)
        expect({ lines: cut.lines, row: cut.row, column: cut.column, from: cut.from }).toEqual({
          lines: byHand.lines,
          row: byHand.row,
          column: byHand.column,
          from: byHand.from,
        })
      }
    })

    it('leaves the text either side of it, and the caret where it began', () => {
      const cut = cutSelection(editFrom(['const total = 1'], 0, 0), { from: 6, to: 12 })
      expect(cut.lines).toEqual(['const = 1'])
      expect([cut.row, cut.column]).toEqual([0, 6])
      expect(cut.dirty).toBe(true)
    })

    it('takes the line breaks inside it, joining what is left', () => {
      const many = ['first line', 'second line', 'third line']
      // From the middle of the first to the middle of the last.
      const cut = cutSelection(editFrom(many, 0, 0), { from: 6, to: 6 + 4 + 1 + 11 + 1 + 6 })
      expect(cut.lines).toEqual(['first line'])
      expect([cut.row, cut.column]).toEqual([0, 6])
    })

    it('empties the file when everything is selected', () => {
      const many = ['first line', 'second line']
      const cut = cutSelection(editFrom(many, 1, 0), { from: 0, to: many.join('\n').length })
      expect(cut.lines).toEqual([''])
      expect([cut.row, cut.column]).toEqual([0, 0])
    })

    it('costs what one press costs, however much of the file it takes', () => {
      // The presses it agrees with are quadratic — each copies the file's
      // lines — so a big selection is where the two part company, and where
      // typing over one used to stop the window for a second.
      const big = Array.from({ length: 4_000 }, (_, i) => `  const value${i} = compute(${i})`)
      const edit = editFrom(big, 0, 0)
      const started = performance.now()
      const cut = cutSelection(edit, { from: 0, to: big.join('\n').length })
      expect(performance.now() - started).toBeLessThan(20)
      expect(cut.lines).toEqual([''])
    })

    it('takes nothing it was not asked for, whatever is in the text', () => {
      const emoji = ['a 👍🏽 b']
      const cut = cutSelection(editFrom(emoji, 0, 0), { from: 2, to: 2 + '👍🏽'.length })
      expect(cut.lines).toEqual(['a  b'])
    })
  })

  it('counts cells rather than characters, for the tabs and the wide ones', () => {
    expect(cellOf('\tabc', 3)).toBe(4)
    expect(columnOf('\tabc', 4)).toBe(3)
    expect(cellOf('こんにx', 3)).toBe(6)
    expect(columnOf('こんにx', 6)).toBe(3)
    // Past the end of the line is the end of the line.
    expect(columnOf('ab', 40)).toBe(2)
  })

  it('slides the body left only once the caret is past its edge', () => {
    expect(leftOf(10, 40)).toBe(0)
    expect(leftOf(40, 40)).toBe(1)
    expect(leftOf(45, 40)).toBe(6)
  })
})

describe('saving what was typed', () => {
  it('keeps the line ending and the last newline the file had', () => {
    const dir = tmp('tade-save-')
    writeFileSync(join(dir, 'crlf.txt'), 'one\r\ntwo\r\n')
    const file = readForView(join(dir, 'crlf.txt'))
    const edit = typeIn(editFrom(textLines(file), 0, 3), '!')
    expect(editedText(edit, file)).toBe('one!\r\ntwo\r\n')
    writeFileSync(join(dir, 'bare.txt'), 'one\ntwo')
    const bare = readForView(join(dir, 'bare.txt'))
    expect(editedText(editFrom(textLines(bare)), bare)).toBe('one\ntwo')
  })

  it('writes it, and reads back what is now on disk', () => {
    const dir = tmp('tade-save-')
    const path = join(dir, 'app.ts')
    writeFileSync(path, 'const a = 1\n')
    const file = readForView(path)
    const edit = typeIn(editFrom(textLines(file), 0, 11), ' + 1')
    const saved = saveEdited(file, editedText(edit, file))
    expect(readFileSync(path, 'utf8')).toBe('const a = 1 + 1\n')
    expect(saved.text).toBe('const a = 1 + 1\n')
    expect(saved.mtimeMs).not.toBe(0)
  })

  it('refuses to write over a file that changed underneath', () => {
    const dir = tmp('tade-save-')
    const path = join(dir, 'app.ts')
    writeFileSync(path, 'const a = 1\n')
    const file = readForView(path)
    // An agent gets there first.
    writeFileSync(path, 'const a = 2\n')
    utimesSync(path, new Date(), new Date(file.mtimeMs + 5_000))
    expect(() => saveEdited(file, 'const a = 3\n')).toThrow(/changed on disk/)
    expect(readFileSync(path, 'utf8')).toBe('const a = 2\n')
  })

  it('says so when the file has gone', () => {
    const dir = tmp('tade-save-')
    const path = join(dir, 'app.ts')
    writeFileSync(path, 'x\n')
    const file = readForView(path)
    writeFileSync(path, 'x\n')
    expect(() => saveEdited({ ...file, path: join(dir, 'gone.ts') }, 'x\n')).toThrow(
      /not there any more/,
    )
  })
})

import { describe, expect, it } from 'vitest'
import { parseDiff } from '../src/diff.ts'
import { drawnRow, inlineRows, lineAtRow } from '../src/panels/file/inline.ts'
import { editFrom, typeIn } from '../src/viewer.ts'

// What git says about the open file, laid into the file's own lines.
//
// The thing this has to get right is that a diff is keyed by the line numbers
// git gave the file when it looked, and the panel is keyed by the lines it has
// now — so every case below is about the two drifting apart: a line typed since,
// a line deleted since, a removal with no line of its own to sit on.

const FILE = ['one', 'two', 'three', 'four', 'five']

/** A diff that replaced line 3 with two lines: `-three` and `+third`, `+and a half`. */
const replaced = parseDiff(
  ['@@ -1,5 +1,6 @@', ' one', ' two', '-three', '+third', '+and a half', ' four', ' five'].join(
    '\n',
  ),
)

/** The lines, as `kind` plus either the file line it is or the text it carries. */
const shape = (rows: ReturnType<typeof inlineRows>) =>
  (rows ?? []).map((row) => [row.kind, row.line === null ? row.text : row.line] as const)

describe('what git says, laid into the file', () => {
  it('marks the added lines and puts the removed one where it was', () => {
    const lines = ['one', 'two', 'third', 'and a half', 'four', 'five']
    expect(shape(inlineRows(replaced, null, lines.length))).toEqual([
      ['context', 0],
      ['context', 1],
      ['remove', 'three'],
      ['add', 2],
      ['add', 3],
      ['context', 4],
      ['context', 5],
    ])
  })

  it('is nothing at all when nobody has asked git yet', () => {
    expect(inlineRows(null, null, 5)).toBeNull()
  })

  it('has nothing to lay into a binary file', () => {
    expect(inlineRows(parseDiff('Binary files a/x and b/x differ\n'), null, 0)).toBeNull()
  })

  it('draws every line as context when the file matches its base', () => {
    expect(shape(inlineRows(parseDiff(''), null, 2))).toEqual([
      ['context', 0],
      ['context', 1],
    ])
  })

  it('keeps a removal that ends the file at the end', () => {
    const gone = parseDiff(['@@ -1,3 +1,2 @@', ' one', ' two', '-three'].join('\n'))
    expect(shape(inlineRows(gone, null, 2))).toEqual([
      ['context', 0],
      ['context', 1],
      ['remove', 'three'],
    ])
  })

  it('keeps each hunk’s removals in its own hunk', () => {
    // Two separate changes to one file, the first ending in a removal: the
    // removal belongs where it happened, not before the next hunk's first line.
    const two = parseDiff(
      ['@@ -1,2 +1,1 @@', ' one', '-two', '@@ -8,2 +7,2 @@', '-eight', '+the eighth', ' nine'].join(
        '\n',
      ),
    )
    expect(shape(inlineRows(two, null, 8))).toEqual([
      ['context', 0],
      ['remove', 'two'],
      ['context', 1],
      ['context', 2],
      ['context', 3],
      ['context', 4],
      ['context', 5],
      ['remove', 'eight'],
      ['add', 6],
      ['context', 7],
    ])
  })

  it('counts a line typed since git looked as an addition of its own', () => {
    // The file as read, with a word typed onto the second line and enter
    // pressed on the first: git has never seen either, and both are additions.
    const typed = typeIn(editFrom(FILE, 1, 3), '!\nsix')
    expect(shape(inlineRows(parseDiff(''), typed.from, typed.lines.length))).toEqual([
      ['context', 0],
      ['add', 1],
      ['add', 2],
      ['context', 3],
      ['context', 4],
      ['context', 5],
    ])
  })

  it('keeps a gone line above the line being typed on', () => {
    // `three` became `third`, and typing into `third` loses where it came from.
    // The removal must still be drawn above it: one that slid below the line you
    // were editing, on every keystroke, is a row that will not sit still.
    const typed = typeIn(editFrom(['one', 'two', 'third', 'and a half', 'four', 'five'], 2, 5), '!')
    expect(shape(inlineRows(replaced, typed.from, typed.lines.length))).toEqual([
      ['context', 0],
      ['context', 1],
      ['remove', 'three'],
      ['add', 2],
      ['add', 3],
      ['context', 4],
      ['context', 5],
    ])
  })

  it('keeps a removal whose own line has since been deleted', () => {
    // `third` is gone from the buffer, so the row the removal was anchored
    // before is gone too. It must still be drawn: what git said happened did.
    const lines = ['one', 'two', 'and a half', 'four', 'five']
    const edit = { from: [0, 1, 3, 4, 5], length: lines.length }
    expect(shape(inlineRows(replaced, edit.from, edit.length))).toEqual([
      ['context', 0],
      ['context', 1],
      ['remove', 'three'],
      ['add', 2],
      ['context', 3],
      ['context', 4],
    ])
  })
})

describe('where a line is drawn, and what is drawn there', () => {
  const rows = inlineRows(replaced, null, 6)

  it('moves a line down by the removals above it', () => {
    expect(drawnRow(rows, 1)).toBe(1)
    expect(drawnRow(rows, 2)).toBe(3)
    expect(drawnRow(rows, 5)).toBe(6)
  })

  it('leaves a line where it is when there is no diff drawn', () => {
    expect(drawnRow(null, 4)).toBe(4)
    expect(lineAtRow(null, 4)).toBe(4)
  })

  it('answers with the line under a row that is a removal', () => {
    // Row 2 is `-three`, which is no line of the file: the top of the view
    // turning the diff off is the line that follows it.
    expect(lineAtRow(rows, 2)).toBe(2)
    expect(lineAtRow(rows, 3)).toBe(2)
    expect(lineAtRow(rows, 6)).toBe(5)
  })

  it('answers past the end with one past the last line there is', () => {
    expect(lineAtRow(rows, 99)).toBe(6)
  })
})

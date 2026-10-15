import { describe, expect, it } from 'vitest'
import type { LineComment } from '../src/comments.ts'
import { parseDiff } from '../src/diff.ts'
import { type CommentChoice, composeKey, composeOn, nextTo } from '../src/panels/comment.ts'
import { type DiffPanel, diffPanel } from '../src/panels/diff/state.ts'
import { inlineRows } from '../src/panels/file/inline.ts'
import { type FilePanel, filePanel } from '../src/panels/file/state.ts'
import { type PanelInputs, panelClick, panelKey } from '../src/panels.ts'
import { editFrom } from '../src/viewer.ts'

// Writing a comment on a line of a diff, in both panels that draw one: the
// patch reader and the file viewer with its changes on. What a comment becomes
// once kept is `comments.test.ts`'s and the window's (`wire/comments.test.ts`).

const patch = parseDiff(
  [
    '@@ -1,3 +1,4 @@',
    ' one',
    '-two',
    '+TWO',
    '+two and a half',
    ' three',
    '@@ -9,1 +10,1 @@',
    '-nine',
    '+NINE',
  ].join('\n'),
)

const CHOICES: CommentChoice[] = [
  { to: 'tade', label: 'Tade' },
  { to: { agent: 'shop/pay' }, label: 'pay' },
  { to: { agent: 'shop/cart' }, label: 'cart' },
]

const inputs: PanelInputs = { patch, commentTo: CHOICES }

const reader = (over: Partial<DiffPanel> = {}): DiffPanel => ({
  ...diffPanel('shop/pay', ['a.ts', 'b.ts']),
  ...over,
})

const press = (panel: DiffPanel, keys: string[], given: PanelInputs = inputs) => {
  let now: DiffPanel = panel
  for (const key of keys) {
    const out = panelKey(now, key, key.length === 1 ? key : '', given)
    if (out.submit) return out
    now = out.panel as DiffPanel
  }
  return { panel: now, submit: false as const }
}

describe('the box a comment is written in', () => {
  const box = composeOn({ line: 3, side: 'new', git: 3, text: 'TWO' }, null)

  it('opens empty and to Tade, which is the person’s default', () => {
    expect(box).toMatchObject({ words: '', to: 'tade' })
  })

  it('takes what is typed as typed, tab says who, enter keeps and escape does not', () => {
    let now = box
    for (const key of ['w', 'h', 'y', 'space', '?']) {
      const answer = composeKey(
        now,
        key === 'space' ? 'space' : undefined,
        key === 'space' ? ' ' : key,
        CHOICES,
      )
      if (!('composing' in answer)) throw new Error('closed')
      now = answer.composing
    }
    expect(now.words).toBe('why ?')
    const told = composeKey(now, 'tab', '\t', CHOICES)
    expect('composing' in told && told.composing.to).toEqual({ agent: 'shop/pay' })
    expect(composeKey(now, 'enter', '\r', CHOICES)).toEqual({ done: 'keep' })
    expect(composeKey(now, 'escape', '\x1b', CHOICES)).toEqual({ done: 'cancel' })
  })

  it('goes round who could be told and back to Tade', () => {
    expect(nextTo('tade', CHOICES, 1)).toEqual({ agent: 'shop/pay' })
    expect(nextTo({ agent: 'shop/cart' }, CHOICES, 1)).toBe('tade')
    expect(nextTo('tade', CHOICES, -1)).toEqual({ agent: 'shop/cart' })
  })

  it('holds what is already kept on the line, so writing again is changing it', () => {
    const kept = composeOn(
      { line: 3, side: 'new', git: 3, text: 'TWO' },
      { words: 'why caps?', to: { agent: 'shop/pay' } },
    )
    expect(kept).toMatchObject({ words: 'why caps?', to: { agent: 'shop/pay' } })
  })
})

describe('the patch reader', () => {
  it('starts the keyboard on the first change, and ↑↓ step over a hunk’s own line', () => {
    // The first press lands on the first change, `-two`; the next goes on from it.
    expect((press(reader(), ['down']).panel as DiffPanel).at).toBe(2)
    expect((press(reader(), ['down', 'down']).panel as DiffPanel).at).toBe(3)
    const moved = press(reader({ at: 5 }), ['down']).panel as DiffPanel
    expect(patch.lines[6]?.kind).toBe('hunk')
    expect(moved.at).toBe(7)
    expect((press(reader({ at: 7 }), ['up']).panel as DiffPanel).at).toBe(5)
  })

  it('opens the box with c on the line the keyboard is on, by git’s number and side', () => {
    const open = press(reader({ at: 2 }), ['c']).panel as DiffPanel
    expect(open.composing).toMatchObject({ line: 2, side: 'old', git: 2, text: 'two', to: 'tade' })
    const added = press(reader({ at: 4 }), ['c']).panel as DiffPanel
    expect(added.composing).toMatchObject({ line: 3, side: 'new', git: 3, text: 'two and a half' })
  })

  it('writes, says who, and keeps it with enter — the panel is handed over with the box in it', () => {
    const out = press(reader({ at: 3 }), ['c', 'n', 'o', 'tab', 'enter'])
    expect(out.submit).toBe(true)
    expect(out).toMatchObject({ choice: 'comment' })
    const kept = (out.panel as DiffPanel).composing
    expect(kept).toMatchObject({ words: 'no', to: { agent: 'shop/pay' }, line: 2, side: 'new' })
  })

  it('closes the box on escape and keeps nothing; the next escape closes the panel', () => {
    const open = press(reader({ at: 3 }), ['c', 'x']).panel as DiffPanel
    const shut = panelKey(open, 'escape', '\x1b', inputs)
    expect((shut.panel as DiffPanel).composing).toBeNull()
    expect(panelKey(shut.panel as DiffPanel, 'escape', '\x1b', inputs).panel).toBeNull()
  })

  it('opens the box on a line that is pressed, holding the comment kept there', () => {
    const kept: LineComment = {
      task: 'shop/pay',
      path: 'a.ts',
      line: 10,
      side: 'new',
      hunk: [],
      words: 'louder',
      to: { agent: 'shop/pay' },
    }
    const out = panelClick(reader(), 'line:8', { ...inputs, comments: [kept] })
    expect((out.panel as DiffPanel).at).toBe(8)
    expect((out.panel as DiffPanel).composing).toMatchObject({ words: 'louder', line: 10 })
    // A hunk's own line is nowhere to write.
    expect((panelClick(reader(), 'line:0', inputs).panel as DiffPanel).composing).toBeNull()
  })

  it('sends with s only where something is kept, and the chip says somebody else', () => {
    expect(press(reader(), ['s']).submit).toBe(false)
    expect(press(reader(), ['s'], { ...inputs, drafted: 2 })).toMatchObject({
      submit: true,
      choice: 'send',
    })
    const open = press(reader({ at: 3 }), ['c']).panel as DiffPanel
    const chip = panelClick(open, 'comment-to', inputs).panel as DiffPanel
    expect(chip.composing?.to).toEqual({ agent: 'shop/pay' })
  })

  it('lets go of the line and the box on another file', () => {
    const open = press(reader({ at: 3 }), ['c']).panel as DiffPanel
    const next = panelKey({ ...open, composing: null }, 'right', '', inputs).panel as DiffPanel
    expect(next).toMatchObject({ file: 1, at: null, composing: null })
  })
})

describe('the file viewer', () => {
  const text = ['one', 'TWO', 'two and a half', 'three']
  const changed = filePanel('/repo/a.ts', null, false, true)
  const rows = inlineRows(patch, null, text.length)
  const given: PanelInputs = { text, diffRows: rows, commentTo: CHOICES, body: 10 }

  it('opens the box with c on the first line added in view, in the one bar it has', () => {
    const out = panelKey(changed, 'c', 'c', given).panel as FilePanel
    expect(out.asking).toMatchObject({
      kind: 'comment',
      box: { line: 2, side: 'new', git: 2, text: 'TWO', to: 'tade' },
    })
    expect(out.line).toBe(2)
  })

  it('opens it on a line whose number is pressed, and keeps it with enter', () => {
    const open = panelClick(changed, 'comment:3', given).panel as FilePanel
    expect(open.asking).toMatchObject({ kind: 'comment', box: { line: 4, text: 'three' } })
    let now: FilePanel = open
    for (const key of ['o', 'k']) now = panelKey(now, undefined, key, given).panel as FilePanel
    const out = panelKey(now, 'enter', '\r', given)
    expect(out).toMatchObject({ submit: true, choice: 'comment' })
  })

  it('writes on the caret’s line with ctrl+r while typing, and a line typed since has no number of git’s', () => {
    const edit = editFrom(['added', ...text], 0, 2)
    const typing: FilePanel = { ...changed, edit: { ...edit, from: [-1, 0, 1, 2, 3] } }
    const out = panelKey(typing, 'ctrl+r', '\x12', given).panel as FilePanel
    expect(out.asking).toMatchObject({
      kind: 'comment',
      box: { line: 1, git: null, text: 'added' },
    })
    // The caret stays where it was in the line.
    expect(out.edit?.column).toBe(2)
  })

  it('types into the box and not into the file while it is open', () => {
    const edit = editFrom(text, 0, 0)
    const open = panelKey({ ...changed, edit }, 'ctrl+r', '\x12', given).panel as FilePanel
    const typed = panelKey(open, undefined, 'z', given).panel as FilePanel
    expect(typed.edit?.lines).toEqual(text)
    expect(typed.asking).toMatchObject({ kind: 'comment', box: { words: 'z' } })
  })

  it('sends with s only where something is kept', () => {
    expect(panelKey(changed, 's', 's', given).submit).toBe(false)
    expect(panelKey(changed, 's', 's', { ...given, drafted: 1 })).toMatchObject({
      submit: true,
      choice: 'send',
    })
  })
})

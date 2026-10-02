import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// Clicking a changed file, and what you can do once you are in it.
//
// It used to open a read-only patch, which is half an answer: a diff read in the
// window is a diff you then leave the window to fix. It now opens the very panel
// a file opens in from FILES or from search — the one you click into, type in and
// save with ctrl+s — with what git says drawn into it.
//
// Against a real repository and real git: the rows are a fold of `git diff` over
// the lines the panel is holding, and a test that handed the fold a diff it wrote
// itself would be a test of the fold. That one is `inline-diff.test.ts`; this one
// is about the window actually getting there.

/** The file as its base has it, which is what the removals in the diff are. */
const BEFORE = ['export const rate = 1', 'export const other = 2', ''].join('\n')
/** And as the task left it: the first line changed, a third added. */
const AFTER = ['export const rate = 2', 'export const other = 2', 'export const vat = 0', ''].join(
  '\n',
)

describe('the window, and a changed file you clicked', () => {
  let terminal: FakeTerminal
  let repo: Repo
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
  })

  /**
   * A task whose base has `ledger.ts` in it, and whose worktree has changed it,
   * with the CHANGES row for it on screen and where it is.
   *
   * The task is made here rather than in the harness because the diff is the
   * point: a task whose base predates the file would have every line of it as an
   * addition, and nothing in it would ever draw a removal. It is the one in front
   * of you — first of the three by name — which is what CHANGES is about, and the
   * row never appearing is what this says if that stops being true.
   */
  async function changedFile(): Promise<{ path: string; row: { col: number; row: number } }> {
    repo.commit('a ledger', { 'ledger.ts': BEFORE })
    const worktree = repo.addTask('ledger', { project: 'app', intent: 'the rate is wrong' })
    writeFileSync(join(worktree, 'ledger.ts'), AFTER)
    terminal.rows = 44
    // Wide enough for the heading to keep the chip pinned to its right: a `Row`
    // drops a pinned group it has no room for, and 80 columns is no room.
    terminal.columns = 120
    await start()
    await until('its changed file in CHANGES', () =>
      screenOf(terminal.written).some((row) => row.includes('ledger.ts') && row.includes('+2 −1')),
    )
    // The row in CHANGES and not the one in FILES, which says the same name: the
    // counts beside it are only ever on the change.
    return { path: join(worktree, 'ledger.ts'), row: find('+2 −1') }
  }

  /** The lines of the open file panel: the mark, the number, and what it says. */
  function body(): { mark: string; number: string; text: string }[] {
    return screenOf(terminal.written)
      .filter((row) => row.includes('│') && row.includes('export const'))
      .map((row) => {
        const parts = row.split('│')
        const gutter = parts[1] ?? ''
        return {
          mark: gutter.replace(/\d+/g, '').trim(),
          number: /\d+/.exec(gutter)?.[0] ?? '',
          // Without the block the caret is drawn as, which is a character of
          // the line in colour and a block of its own where there is no
          // character — and the row is padded out, so the block is only at the
          // end once the padding is off.
          text: (parts[2] ?? '').replace(/▕.*$/, '').trimEnd().replace(/█$/, '').trim(),
        }
      })
  }

  it('opens it in the editor, with git’s answer drawn into it', async () => {
    const { row } = await changedFile()
    terminal.written = ''
    click(row.col, row.row)
    // The file panel, and not the patch reader: it has the editor's own footer.
    await until('the file panel', () => terminal.written.includes('Open in editor'))
    await until('the file itself', () => body().length === 4)

    // The diff, in the file: the line that was there marked `−` and no line of
    // the file any more, the two that are new marked `+`, the one nobody touched
    // marked neither — which is `git diff`, drawn in a panel you can type into.
    expect(body()).toEqual([
      { mark: '−', number: '', text: 'export const rate = 1' },
      { mark: '+', number: '1', text: 'export const rate = 2' },
      { mark: '', number: '2', text: 'export const other = 2' },
      { mark: '+', number: '3', text: 'export const vat = 0' },
    ])
    // And what git counted, beside the file's own facts in the heading.
    expect(terminal.written).toContain('Changes')
    await until(
      'the counts',
      () => terminal.written.includes('+2') && terminal.written.includes('−1'),
    )
  })

  it('types into it with the diff drawn, and ctrl+s saves to the file', async () => {
    const { path, row } = await changedFile()
    click(row.col, row.row)
    await until('the file panel', () => body().length === 4)

    // A click at the end of the first line puts the caret there, as it does in
    // any file opened in this panel: the gone line under it is no line of the
    // file, so nothing about it moves where a caret lands.
    const line = find('export const rate = 2')
    click(line.col + 'export const rate = 2'.length, line.row)
    terminal.press('0')
    await until('what was typed', () => body().some((one) => one.text === 'export const rate = 20'))
    // Not yet on disk: what is typed in the panel is typed in the panel.
    expect(readFileSync(path, 'utf8')).toBe(AFTER)

    terminal.press('\x13')
    await until(
      'the file on disk',
      () => readFileSync(path, 'utf8') === AFTER.replace('rate = 2', 'rate = 20'),
    )
    await until('it to say so', () => terminal.written.includes('Saved ledger.ts'))
    // And git asked again about the file as it now is, so the diff is the diff of
    // what was saved: the line that was typed is still the addition it was.
    await until('the diff to catch up', () =>
      body().some((one) => one.mark === '+' && one.text === 'export const rate = 20'),
    )
  })

  it('turns the inline diff off with ctrl+d, and on again', async () => {
    const { row } = await changedFile()
    click(row.col, row.row)
    await until('the diff drawn', () => body().some((one) => one.mark === '−'))

    terminal.press('\x04')
    // Off: the file and nothing else, so the line git says is gone is not in it
    // and every line is numbered again.
    await until('the diff gone', () => body().length === 3)
    expect(body()).toEqual([
      { mark: '', number: '1', text: 'export const rate = 2' },
      { mark: '', number: '2', text: 'export const other = 2' },
      { mark: '', number: '3', text: 'export const vat = 0' },
    ])

    terminal.press('\x04')
    await until('the diff back', () => body().some((one) => one.mark === '−'))
  })

  it('says so in words on a file that matches its base, rather than drawing nought', async () => {
    // The chip is offered on any file, because a file nobody changed is a
    // question worth being able to ask. `+0 −0` would be a figure drawn for an
    // answer that is not a figure, so the answer is the words.
    await changedFile()
    const unchanged = find('README.md')
    click(unchanged.col, unchanged.row)
    await until('the file panel', () => terminal.written.includes('Open in editor'))
    terminal.written = ''
    terminal.press('\x04')
    await until('what git said about it', () => terminal.written.includes('no changes'))
  })

  it('turns it on again from the chip, which is drawn whether it is on or off', async () => {
    const { row } = await changedFile()
    click(row.col, row.row)
    await until('the diff drawn', () => body().some((one) => one.mark === '−'))

    const chip = find('Changes')
    click(chip.col + 2, chip.row)
    await until('the diff gone', () => body().length === 3)
    // The chip is still there with it off, which is what makes it findable.
    const again = find('Changes')
    click(again.col + 2, again.row)
    await until('the diff back', () => body().some((one) => one.mark === '−'))
  })
})

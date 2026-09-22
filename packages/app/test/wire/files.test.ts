import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// Finding in a file, editing it, saving it, and its own menu.

describe('the window, and the file you have open', () => {
  let terminal: FakeTerminal
  let repo: Repo
  const { start, click, find, opened } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
  })

  it('finds in an open file, types a short edit into it, and saves it with ctrl+s', async () => {
    const path = join(repo.root, 'ledger.ts')
    writeFileSync(path, 'export const rate = 1\nexport const other = 2\n')
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    for (const char of 'ledger') terminal.press(char)
    await until('the file', () => terminal.written.includes('□ ledger.ts'))
    terminal.press('\r')
    await until('the viewer', () => terminal.written.includes('Open in editor'))
    await until('what the file says', () =>
      screenOf(terminal.written).some((row) => row.includes('export const rate = 1')),
    )

    // ctrl+f: the bar, and how many it found.
    terminal.written = ''
    terminal.press('\x06')
    await until('the find bar', () => terminal.written.includes('Find'))
    for (const char of 'const') terminal.press(char)
    await until('what it found', () =>
      screenOf(terminal.written).some((row) => row.includes('1 of 2')),
    )
    terminal.press('\x1b')

    // A click at the end of the first line puts the caret there; then it types.
    const line = find('export const rate = 1')
    click(line.col + 'export const rate = 1'.length, line.row)
    terminal.press('0')
    await until('what was typed where it was clicked', () =>
      screenOf(terminal.written).some((row) => row.includes('export const rate = 10')),
    )
    expect(readFileSync(path, 'utf8')).toBe('export const rate = 1\nexport const other = 2\n')

    // ctrl+s, and the file on disk is what is on screen.
    terminal.press('\x13')
    await until(
      'the file saved',
      () => readFileSync(path, 'utf8') === 'export const rate = 10\nexport const other = 2\n',
    )
    await until('it to say so', () => terminal.written.includes('Saved ledger.ts'))
  }, 30_000)

  it('says what it would open rather than opening it on the machine', async () => {
    // The bug this is about: `Reveal in Finder` really spawned `open`, so a
    // fixture worktree kept appearing on the screen of whoever ran the checks.
    // The window is handed an opener that records instead, and what it would
    // have run is the assertion — which says more than a spawn offscreen did.
    terminal.rows = 60
    await start()
    await until('the files', () =>
      screenOf(terminal.written).some((row) => row.includes('README.md')),
    )
    const file = find('README.md')
    terminal.press(`\x1b[<2;${file.col + 2};${file.row + 1}M`)
    terminal.press(`\x1b[<2;${file.col + 2};${file.row + 1}m`)
    // Waited for by something every machine draws: the item this test is
    // about is named for what will open it, so it says `Reveal in Finder`
    // only where there is a Finder. Waiting for that wording waited for ever
    // on Linux — where the menu was already up, saying `Show in its folder` —
    // and a wait that times out says nothing about why.
    await until('the menu', () => terminal.written.includes('Copy relative path'))

    const item = find(process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in its folder')
    click(item.col + 2, item.row)
    await until('the opener it would have run', () => opened.length > 0)
    // FILES resolves against the agent's worktree, so this is the very path
    // that kept opening: `app-refunds`, the fixture worktree of the task the
    // window is focused on.
    const worktree = join(repo.root, '..', 'worktrees', 'app-refunds')
    // Only Finder picks the file out; elsewhere the folder is what opens.
    expect(opened).toEqual([
      process.platform === 'darwin'
        ? { command: 'open', args: ['-R', join(worktree, 'README.md')] }
        : { command: 'xdg-open', args: [worktree] },
    ])
  }, 30_000)

  it("opens a file's menu with a right-click in FILES", async () => {
    terminal.rows = 60
    await start()
    await until('the files', () =>
      screenOf(terminal.written).some((row) => row.includes('README.md')),
    )
    const file = find('README.md')
    terminal.written = ''
    terminal.press(`\x1b[<2;${file.col + 2};${file.row + 1}M`)
    terminal.press(`\x1b[<2;${file.col + 2};${file.row + 1}m`)
    await until('the menu', () => terminal.written.includes('Copy relative path'))
  })
})

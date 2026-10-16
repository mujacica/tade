import { describe, expect, it } from 'vitest'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// The landing desk, through the whole window: a piece of finished work arrives
// on it from what status and the ACTIONS look already say, the AGENTS heading
// says how much waits to land here, and the desk opens on the change itself.
//
// Against a real repository and a real workbench, so what the row says it
// changed is what git counted on the task's own commits.

describe('the window, and the landing desk', () => {
  let terminal: FakeTerminal
  let repo: Repo
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
  })

  it('lists finished work, opens from the AGENTS heading, and reads the change as a patch', async () => {
    const worktree = repo.addTask('ledger', { project: 'app', intent: 'the rate is wrong' })
    repo.commit(
      'a ledger\n\nTade-Task: app/ledger',
      { 'ledger.ts': 'export const rate = 2\n' },
      worktree,
    )
    terminal.rows = 44
    terminal.columns = 140
    await start()

    // Stopped with work committed and nothing running: on the desk, from status alone.
    await until('the heading saying it waits to land', () =>
      screenOf(terminal.written).some((row) => row.includes('land 1')),
    )
    const chip = find('land 1')
    click(chip.col + 1, chip.row)
    await until('the desk', () => terminal.written.includes('Landing desk'))

    // An open desk looks at its rows: the checks, and what its own commits changed.
    await until('what its commits changed, counted by git', () =>
      screenOf(terminal.written).some((row) => row.includes('ledger') && row.includes('+1 −0')),
    )
    expect(screenOf(terminal.written).some((row) => row.includes('WAITING ON YOU'))).toBe(true)

    // Enter reads the change; until the files are looked at it says so and stays.
    terminal.press('\r')
    let pressed = Date.now()
    await until('the patch reader on its change', () => {
      const screen = screenOf(terminal.written)
      if (screen.some((row) => row.includes('+ export const rate = 2'))) return true
      if (
        screen.some((row) => row.includes('not been looked at yet')) &&
        Date.now() - pressed > 300
      ) {
        terminal.press('\r')
        pressed = Date.now()
      }
      return false
    })
  })
})

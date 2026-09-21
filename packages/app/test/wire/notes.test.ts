import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// A note taken, kept word for word, read by the headline written beside it,
// and forgotten.

describe('the window, and what it was told', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })

  it('keeps a note added with the + beside NOTES, word for word, about the project', async () => {
    terminal.rows = 60
    await start()
    await until('the notes heading', () =>
      screenOf(terminal.written).some((row) => row.includes('NOTES')),
    )
    const heading = find('NOTES')
    const plus = (screenOf(terminal.written)[heading.row] ?? '').indexOf('+', heading.col)
    terminal.written = ''
    click(plus, heading.row)
    await until('the note panel', () => terminal.written.includes('New note'))
    for (const char of 'Staging key rotates on the 1st') terminal.press(char)
    terminal.press('\r')
    await until('the note kept', () => client.recallAll().length === 1)
    expect(client.recallAll()[0]).toMatchObject({
      text: 'Staging key rotates on the 1st',
      scope: 'app',
    })
  })

  it('writes the headline a note is read by, for one that was taken without one', async () => {
    terminal.rows = 60
    client.remember('the staging key rotates on the 1st', 'app', 'window')
    await start()
    await until('the notes heading', () =>
      screenOf(terminal.written).some((row) => row.includes('NOTES')),
    )
    const heading = find('NOTES')
    click(heading.col, heading.row)
    await until('the note', () => screenOf(terminal.written).some((row) => row.includes('staging')))
    const note = find('staging')
    click(note.col, note.row)
    await until('its page', () => terminal.written.includes('Add a headline…'))
    const button = find('Add a headline…')
    click(button.col + 2, button.row)
    await until('the headline asked for', () =>
      terminal.written.includes('WHAT IT IS ABOUT AND WHAT IT DOES'),
    )
    for (const char of 'Staging key rotates monthly') terminal.press(char)
    terminal.press('\r')
    await until('the headline kept', () => client.recallAll()[0]?.summary !== undefined)
    // Said again with its headline: the words themselves are handed over untouched.
    expect(client.recallAll()[0]).toMatchObject({
      text: 'the staging key rotates on the 1st',
      summary: 'Staging key rotates monthly',
      scope: 'app',
    })
    expect(client.recallAll()).toHaveLength(1)
  })

  it('opens a note on its own page when it is clicked, and forgets it from there', async () => {
    terminal.rows = 60
    client.remember('the staging key rotates on the 1st', 'app', 'window')
    await start()
    await until('the notes heading', () =>
      screenOf(terminal.written).some((row) => row.includes('NOTES')),
    )
    const heading = find('NOTES')
    click(heading.col, heading.row)
    await until('the note', () => screenOf(terminal.written).some((row) => row.includes('staging')))
    const note = find('staging')
    click(note.col, note.row)
    // The page it opens on, not the menu the ≡ beside it asks for.
    await until('its page', () => terminal.written.includes('Said by'))
    const page = screenOf(terminal.written).join('\n')
    expect(page).toContain('About app')
    expect(page).toContain('the staging key rotates on the 1st')
    expect(page).not.toContain('Edit…')
    // Forgetting it is on the page, where it is read.
    const forget = find('Forget')
    click(forget.col + 2, forget.row)
    await until('the note forgotten', () => client.recallAll().length === 0)
  })

  it('forgets a note from the × that pointing at it shows', async () => {
    terminal.rows = 60
    client.remember('the staging key rotates on the 1st', 'app', 'test')
    await start()
    await until('the notes heading', () =>
      screenOf(terminal.written).some((row) => row.includes('NOTES')),
    )
    // Notes start folded: opened the way a person would.
    const heading = find('NOTES')
    click(heading.col, heading.row)
    // Found by a word on its first line: a note that runs on breaks onto a second.
    await until('the note', () => screenOf(terminal.written).some((row) => row.includes('staging')))
    const note = find('staging')
    // The pointer moving over it, with no button held.
    terminal.press(`\x1b[<35;${note.col + 1};${note.row + 1}M`)
    await until('its buttons', () => (screenOf(terminal.written)[note.row] ?? '').includes('×'))
    click((screenOf(terminal.written)[note.row] ?? '').indexOf('×'), note.row)
    await until('the note forgotten', () => client.recallAll().length === 0)
  })
})

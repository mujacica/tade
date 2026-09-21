import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExtensionHost } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, type Repo, until, windowUnderTest } from './harness.ts'

// Letters matched against what Tade already has, what is looked for inside
// files, and what happens when the letters match nothing.

describe('the window, finding things', () => {
  let terminal: FakeTerminal
  let repo: Repo
  let home: string
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
    home = wired.home
  })

  it('searches with ctrl+k, finding agents and files, and opens a file to read', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    for (const char of 'sear') terminal.press(char)
    await until('the search agent', () => terminal.written.includes('in app'))

    // A file in the repository, by part of its name, opened where it is read.
    terminal.press('\x15')
    for (const char of 'readme') terminal.press(char)
    // Its mark as well as its name: the sidebar lists README.md too.
    await until('the file', () => terminal.written.includes('□ README.md'))
    terminal.written = ''
    terminal.press('\r')
    await until('the viewer', () => terminal.written.includes('Open in editor'))
    await until('what the file says', () => terminal.written.includes('fixture'))
  })

  it('asks what a sentence means when the letters find nothing, and shows what comes back', async () => {
    const asked: { said: string; choices: string[] }[] = []
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'reader',
          title: 'Reader',
          description: 'Reads a sentence.',
          meant: async (_ctx, request) => {
            asked.push({ said: request.said, choices: request.choices.map((one) => one.id) })
            // Only ever something already in front of them.
            return request.choices
              .filter((one) => one.label.toLowerCase().includes('refunds'))
              .slice(0, 1)
              .map((one) => one.id)
          },
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    await start({ extensions })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    terminal.written = ''
    // A sentence, not the start of a name: almost none of its letters are in
    // anything the window has, so matching finds nothing.
    for (const char of 'stop whoever is on the refunds thing') terminal.press(char)
    await until('nothing matching', () => terminal.written.includes('Nothing matches'))

    await until('what it might mean', () => terminal.written.includes('MIGHT MEAN (1)'))
    // The same entry the window always had, under a heading of its own: its
    // own mark, where it is, and nothing lit — because nothing matched.
    await until('the thing it meant', () => terminal.written.includes('○ refunds  in app'))
    // It is asked about what they typed, and only about what is already there.
    expect(asked[0]?.said).toBe('stop whoever is on the refunds thing')
    expect(asked[0]?.choices.length).toBeGreaterThan(0)
    expect(asked[0]?.choices.every((id) => id.includes(':'))).toBe(true)
  })

  it('looks inside files for what you type', async () => {
    writeFileSync(join(repo.root, 'ledger.ts'), 'export const refundTwice = false\n')
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    for (const char of '#refundtwice') terminal.press(char)
    // Case does not matter, and the line is said with the file.
    await until('the line inside the file', () => terminal.written.includes('ledger.ts:1'))
  })
})

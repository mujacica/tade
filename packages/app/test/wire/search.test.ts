import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { ExtensionHost, type MeantRequest } from '@tade/extensions-core'
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

describe('the window, asking what is happening', () => {
  let terminal: FakeTerminal
  let repo: Repo
  let home: string
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
    home = wired.home
  })

  /** An extension that keeps what it was asked, and answers with whatever `say` picks. */
  async function reader(
    asked: MeantRequest[],
    say: (request: MeantRequest) => Promise<readonly string[]> | readonly string[],
  ) {
    return await ExtensionHost.load({
      builtin: [
        {
          name: 'reader',
          title: 'Reader',
          description: 'Reads a sentence.',
          meant: async (_ctx, request) => {
            asked.push(request)
            return await say(request)
          },
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
  }

  /** Open search and type a sentence into it. */
  async function type(said: string): Promise<void> {
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    terminal.written = ''
    for (const char of said) terminal.press(char)
  }

  it('finds an agent by what it was asked for, and asks anyway', async () => {
    const asked: MeantRequest[] = []
    const extensions = await reader(asked, (request) =>
      request.choices
        .filter((one) => one.label.startsWith('Show the changes'))
        .map((one) => one.id),
    )
    await start({ extensions })
    // `search` is asked for "search is slow above ten thousand rows", so the
    // letters do find it — through what is happening, which is the half that
    // did not exist. Weakly, though: they could have meant something else by
    // it, so the question is still worth putting.
    await type('search is slow')
    await until('the agent it is about', () => terminal.written.includes('AGENTS'))
    expect(terminal.written).not.toContain('Nothing matches')
    await until('what it might mean', () => terminal.written.includes('MIGHT MEAN'))

    const choices = asked[0]?.choices ?? []
    // What it was asked with is what is happening, not only a list of names:
    // what each agent was asked for, in the words it was asked in.
    expect(choices.find((one) => one.label === 'refunds')?.about).toContain(
      'refunds double-charge on retries',
    )
    // Everything offered is something the window already had.
    expect(choices.every((one) => one.id.includes(':'))).toBe(true)
  })

  it('offers only names where somebody has said what is happening may not leave', async () => {
    const asked: MeantRequest[] = []
    const extensions = await reader(asked, () => [])
    await start({
      extensions,
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        surfaces: { search: { context: false } },
      }),
    })
    await type('the agent on the double charge')
    await until('the question', () => asked.length > 0)
    expect(asked[0]?.choices.length).toBeGreaterThan(0)
    expect(asked[0]?.choices.some((one) => one.about !== undefined)).toBe(false)
    // And the letters still read all of it, because matching here sends nothing.
    terminal.written = ''
    terminal.press('\x15')
    for (const char of 'double-charge') terminal.press(char)
    await until('the agent it is about', () => terminal.written.includes('refunds'))
  })

  it('drops an answer that arrives after the box has changed', async () => {
    const asked: MeantRequest[] = []
    let release: () => void = () => {}
    // The first question waits to be let go and then answers with something;
    // every question after it answers with nothing. So a MIGHT MEAN row can
    // only ever be the first answer, arriving about a box that is gone.
    const extensions = await reader(asked, async (request) => {
      if (asked.length > 1) return []
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return request.choices.filter((one) => one.label === 'refunds').map((one) => one.id)
    })
    await start({ extensions })
    await type('the agent on the double charge')
    await until('the question', () => asked.length > 0)
    for (const char of ' please') terminal.press(char)
    await until('the question about what is there now', () => asked.length > 1)
    release()
    await new Promise((resolve) => setTimeout(resolve, 300))
    // The box still holds what they went on typing, and the answer to what
    // they had typed before is nowhere.
    expect(terminal.written).toContain('double charge please')
    expect(terminal.written).not.toContain('MIGHT MEAN')
  })

  it('shows nothing for an id nobody was offered', async () => {
    const asked: MeantRequest[] = []
    const extensions = await reader(asked, () => ['task:app/invented', 'run:nothing-like-this'])
    await start({ extensions })
    await type('the agent on the double charge')
    await until('the question', () => asked.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(terminal.written).not.toContain('MIGHT MEAN')
    expect(terminal.written).not.toContain('invented')
  })
})

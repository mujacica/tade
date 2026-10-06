import { accessSync, chmodSync, constants, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { ExtensionHost, type MeantRequest } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { asPaste } from '../../src/input.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

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

describe('the window, opening a path somebody pasted', () => {
  let terminal: FakeTerminal
  let repo: Repo
  let home: string
  const { start, opened } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
    home = wired.home
  })

  /**
   * A document an agent wrote in its own task folder under Tade's home — the
   * place a task's `produces` goes, which is in no project and in no worktree
   * and which search has therefore never heard of.
   */
  function outside(name = 'research.md', text = '# Remote cloud\n\nA control room.\n'): string {
    const dir = join(home, 'projects', 'app', 'tasks', 'refunds')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    writeFileSync(path, text)
    return path
  }

  /** Open search and paste a path into it, the way a terminal delivers one. */
  async function paste(text: string): Promise<void> {
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    terminal.written = ''
    terminal.press(asPaste(text))
  }

  /**
   * The row the path made, off the rebuilt screen — because the whole screen
   * holds the checkout's own path, which lives under `/var/folders`, and
   * "somewhere on screen it says folder" is a test that passes for the wrong
   * reason.
   *
   * From the bottom, as `Wired.find` reads one: the box you typed the path
   * into holds the end of it too, and it is the row *under* that one that
   * says anything about the file.
   */
  function row(what: string): string {
    const lines = screenOf(terminal.written)
    for (let at = lines.length - 1; at >= 0; at--) {
      const line = lines[at] ?? ''
      if (line.includes(what)) return line
    }
    return ''
  }

  it('reads a file no project indexes, in the viewer, at the line asked for', async () => {
    const path = outside()
    await start()
    await paste(`${path}:3`)
    await until('the path row', () => terminal.written.includes('THIS PATH'))
    await until('its name and where it is', () => terminal.written.includes('research.md'))
    await until('the line it goes to', () => terminal.written.includes('line 3'))
    terminal.written = ''
    terminal.press('\r')
    // The same viewer every other file opens in, with the same way out of it.
    await until('the viewer', () => terminal.written.includes('Open in editor'))
    await until('what the file says', () => terminal.written.includes('A control room'))
  })

  it('opens it in the editor from that same panel', async () => {
    const path = outside()
    await start()
    await paste(path)
    await until('the path row', () => terminal.written.includes('THIS PATH'))
    terminal.press('\r')
    await until('the viewer', () => terminal.written.includes('Open in editor'))
    opened.length = 0
    // The viewer's own way out, which is the one the button names.
    terminal.press('e')
    await until('the editor', () => opened.length > 0)
    expect(opened[0]?.args.some((arg) => arg.includes('research.md'))).toBe(true)
  })

  it("never calls it the project's: no diff, no base, nothing of git", async () => {
    const path = outside()
    await start()
    await paste(path)
    await until('the path row', () => terminal.written.includes('THIS PATH'))
    terminal.press('\r')
    await until('the viewer', () => terminal.written.includes('Open in editor'))
    terminal.written = ''
    // ctrl+d is what asks git about the file that is open. A file outside
    // every checkout is one no checkout can be asked about, so nothing is
    // claimed about it: never a count, and never `no changes`, which is the
    // answer "git looked and this matches its base".
    terminal.press('\x04')
    await until('the source, which the chip turns on', () =>
      terminal.written.includes('A control room.'),
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(terminal.written).not.toContain('no changes')
    expect(terminal.written).not.toContain('+0')
    expect(terminal.written).not.toContain('−0')
  })

  it('says a path that is not there, one that is a folder, and one it may not read', async () => {
    const dir = join(home, 'projects', 'app', 'tasks', 'refunds')
    mkdirSync(dir, { recursive: true })
    const secret = join(dir, 'secret.md')
    writeFileSync(secret, 'a key\n')
    chmodSync(secret, 0o000)
    // Root reads it whatever its mode says, and that is the machine's answer
    // rather than this feature's: the other two cases hold everywhere.
    let denied = true
    try {
      accessSync(secret, constants.R_OK)
      denied = false
    } catch {
      denied = true
    }
    await start()

    await paste(join(dir, 'nothing-here.md'))
    await until('it is not there', () => row('nothing-here.md').includes('not there'))

    terminal.press('\x15')
    terminal.written = ''
    terminal.press(asPaste(dir))
    // A folder wears the mark the FILES tree gives one, and says so in words.
    await until('a folder', () => row('▸ refunds').includes('folder'))

    if (denied) {
      terminal.press('\x15')
      terminal.written = ''
      terminal.press(asPaste(secret))
      await until('what it may not read', () => row('secret.md').includes('cannot read'))
      // And nothing was read to find that out: the row says what it is, and
      // what is in it is still only on disk.
      expect(terminal.written).not.toContain('a key')
    }
    chmodSync(secret, 0o600)
  })

  it('takes a pasted path with a space in it', async () => {
    const dir = join(home, 'projects', 'app', 'tasks', 'refunds', 'My Notes')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'a note.md')
    writeFileSync(path, 'written by hand\n')
    await start()
    await paste(`'${path}'`)
    await until('the path row', () => terminal.written.includes('a note.md'))
    terminal.press('\r')
    await until('what the file says', () => terminal.written.includes('written by hand'))
  })

  it('expands ~ against your own home, through the window', async () => {
    outside('plan.md', '# The plan\n\nwritten under home\n')
    const was = process.env.HOME
    // The one place the window reads where home is, so this is what `~` means
    // to it. Put back whatever it was, whether this passes or not.
    process.env.HOME = home
    try {
      await start()
      await paste(`~/projects/app/tasks/refunds/plan.md`)
      await until('the path row', () => terminal.written.includes('THIS PATH'))
      terminal.press('\r')
      await until('what the file says', () => terminal.written.includes('written under home'))
    } finally {
      if (was === undefined) delete process.env.HOME
      else process.env.HOME = was
    }
  })

  it('opens one with no project open at all', async () => {
    const path = outside('plan.md', '# The plan\n\nnothing is open\n')
    await start({ config: ConfigSchema.parse({ projects: {} }) })
    await until('the window', () => terminal.written.includes('T A D E'))
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    terminal.written = ''
    terminal.press(asPaste(path))
    await until('the path row', () => terminal.written.includes('THIS PATH'))
    terminal.press('\r')
    // Nothing here is a project's, so there is no checkout to resolve against
    // and none is wanted: the path is already where the file is.
    await until('what the file says', () => terminal.written.includes('nothing is open'))
  })

  it('leaves ordinary search alone, and never looks inside a project for a path', async () => {
    writeFileSync(join(repo.root, 'ledger.ts'), 'export const refundTwice = false\n')
    await start()
    await paste('/nowhere/at/all.md')
    await until('the path row', () => terminal.written.includes('THIS PATH'))
    // A path is not text to look for inside files: nothing is grepped for it.
    // Past `GREP_AFTER_MS`, so this is "it never started" and not "not yet".
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(terminal.written).not.toContain('looking in files')
    terminal.press('\x15')
    terminal.written = ''
    for (const char of '#refundtwice') terminal.press(char)
    await until('the line inside the file', () => terminal.written.includes('ledger.ts:1'))
    expect(terminal.written).not.toContain('THIS PATH')
  })
})

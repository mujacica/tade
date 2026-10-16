import { wonFrom } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// A race, through the whole window: two entrants that each committed, compared
// in `/race` from what status and the ACTIONS look already say, and picked with
// a press that is said yes to — the other stopped and marked finished, its
// branch kept. And the orchestrator's pick, which the window holds to a line of
// the person's: refused without one, carried out with one.

describe('the window, and a race', () => {
  let terminal: FakeTerminal
  let repo: Repo
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
    client = wired.client
  })

  /** An entrant that committed its work, as its task file and its own commit say. */
  const entrant = (name: string, harness: string | null, file: string) => {
    const worktree = repo.addTask(name, {
      project: 'app',
      rawTaskYaml: stringify({
        id: `app/${name}`,
        project: 'app',
        intent_spoken: 'add a dark mode',
        // A minute ago: the person's lines are read from shortly before a race began.
        created: new Date(Date.now() - 60_000).toISOString(),
        base: repo.head(),
        parked: false,
        race: 'dark',
        ...(harness ? { harness } : {}),
      }),
    })
    repo.commit(
      `dark mode\n\nTade-Task: app/${name}`,
      { [file]: 'export const dark = true\n' },
      worktree,
    )
  }

  const typed = async (text: string) => {
    const line = find('Ask Tade anything')
    click(line.col, line.row)
    await until('the line open', () =>
      screenOf(terminal.written).some((row) => row.includes('enter sends')),
    )
    for (const char of text) terminal.press(char)
    await until('what was typed', () =>
      screenOf(terminal.written).some((row) => row.includes(text)),
    )
    terminal.press('\r')
  }

  it('compares the entrants from /race and picks one with a press said yes to', async () => {
    entrant('dark-1', 'codex', 'dark.ts')
    entrant('dark-2', null, 'theme/dark.ts')
    terminal.rows = 44
    terminal.columns = 140
    await start()
    await typed('/race')
    await until('the race, its entrants and nobody picking', () => {
      const screen = screenOf(terminal.written)
      return (
        screen.some((row) => row.includes('dark') && row.includes('2 entrants')) &&
        screen.some((row) => row.includes('nobody has picked')) &&
        screen.some((row) => row.includes('codex'))
      )
    })
    // An open race looks at its entrants: what each one's commits changed, counted.
    await until('what each changed', () =>
      screenOf(terminal.written).some((row) => row.includes('dark-1') && row.includes('+1 −0')),
    )
    expect(screenOf(terminal.written).some((row) => row.includes('asked: add a dark mode'))).toBe(
      true,
    )

    // p asks, and nothing is picked until it is said yes to.
    terminal.press('p')
    await until('the question', () =>
      screenOf(terminal.written).some((row) => row.includes('every branch is kept')),
    )
    expect(wonFrom(await client.events({ types: ['race_won'] })).size).toBe(0)
    terminal.press('\r')
    await until('the pick written down', async () =>
      wonFrom(await client.events({ types: ['race_won'] })).has('app/dark'),
    )
    const won = wonFrom(await client.events({ types: ['race_won'] })).get('app/dark')
    expect(won?.by).toBe('you')
    const other = won?.task === 'app/dark-1' ? 'app/dark-2' : 'app/dark-1'
    await until('the other marked finished', async () =>
      (await client.events({ types: ['task_done'] })).some((one) => one.task === other),
    )
    await until('the other drawn closed, its branch kept', () =>
      screenOf(terminal.written).some((row) => row.includes('closed, branch kept')),
    )
    expect(repo.git('branch', '--list', 'tade/dark-*').split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('lets the orchestrator pick only on a line of the person’s asking for one', async () => {
    entrant('dark-1', 'codex', 'dark.ts')
    entrant('dark-2', null, 'theme/dark.ts')
    const app = await start()
    const pick = () =>
      app.queueTools().race.pick({
        race: 'dark',
        task: 'dark-2',
        why: 'the smaller change, and its checks are green',
        said: 'pick one',
      })
    await until('the race seen', async () =>
      (await app.queueTools().race.standing({})).includes('Race dark in app'),
    )
    await client.log.append({ type: 'said', detail: { text: 'how is the race going?' } })
    await expect(pick()).rejects.toThrow(/Nothing they have said since dark began asks me to pick/)
    expect(wonFrom(await client.events({ types: ['race_won'] })).size).toBe(0)

    await client.log.append({ type: 'said', detail: { text: 'pick the best one for me' } })
    expect(await pick()).toMatch(
      /^Picked app\/dark-2\. Stopped and marked finished, branches kept: app\/dark-1\./,
    )
    const won = wonFrom(await client.events({ types: ['race_won'] })).get('app/dark')
    expect(won).toMatchObject({ task: 'app/dark-2', by: 'orchestrator' })
    expect(await app.queueTools().race.standing({ race: 'dark' })).toMatch(
      /Picked app\/dark-2 \(by the orchestrator, on their word\)/,
    )
  })
})

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, taskDir } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import type { App } from '../../src/app.ts'
import {
  type FakeTerminal,
  type Repo,
  SPAWNING_MS,
  screenOf,
  until,
  windowUnderTest,
} from './harness.ts'

// Closing a project from the window, which is a `×` on its tab and an item in
// the menu beside it.
//
// Everything here goes through the click: the hit map, the action table, the
// one writer and the config read back off the disk. Calling `closeProject`
// straight would have passed every day the `×` was doing nothing at all —
// which is what it was doing, on every project with an agent in it, and so on
// every project anybody was working in.

describe('the window, closing a project', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  const { start, newTerminal, click } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
  })

  /**
   * A window over several projects, each a real repository of its own.
   *
   * Written to the home's `config.yaml` as well as handed to the window: the
   * close writes that file and reads it back, so a test whose window knows
   * about projects the file does not would watch them all vanish at once and
   * call it a pass.
   */
  async function over(names: readonly string[], width = 160): Promise<App> {
    const roots = new Map(
      names.map((name) => {
        if (name === 'app') return [name, repo.root] as const
        const made = mkrepo()
        made.commit('first')
        return [name, made.root] as const
      }),
    )
    const projects = Object.fromEntries([...roots].map(([name, root]) => [name, { root }]))
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n${[...roots].map(([name, root]) => `  ${name}:\n    root: ${root}`).join('\n')}\n`,
    )
    terminal.columns = width
    const config = ConfigSchema.parse({ projects })
    // What the window is started over, and what the workbench already thinks
    // it is: the close writes the file, reads it back and hands it to both, so
    // a baseline where only one of them knows about `other` is a test that
    // watches it vanish and calls that a pass.
    client.config = config
    const app = await start({ config })
    await until('the first frame', () => terminal.written.includes('Settings'))
    return app
  }

  /** The row of tabs, as a person reads it. */
  function tabs(): { row: number; text: string } {
    const lines = screenOf(terminal.written)
    const row = lines.findIndex((line) => line.includes('T A D E'))
    return { row, text: lines[row] ?? '' }
  }

  /** The `×` belonging to a project's tab: the first one after its name. */
  function closeOf(project: string): { col: number; row: number } {
    const bar = tabs()
    const at = bar.text.indexOf(project)
    if (at < 0) throw new Error(`no tab for ${project} in "${bar.text}"`)
    const col = bar.text.indexOf('×', at)
    if (col < 0) throw new Error(`no × after ${project} in "${bar.text}"`)
    return { col, row: bar.row }
  }

  /** An agent really working in a project, started the way the queue starts one. */
  async function agentIn(app: App, project: string, name: string): Promise<void> {
    await app.queueTools().plan({
      project,
      said: `${name} please`,
      agents: [{ name, said: name, prompt: '', after: [], touches: [`${name}.ts`] }],
    })
    await until(
      `${project}/${name} working`,
      () => client.runs().some((run) => run.task === `${project}/${name}`),
      SPAWNING_MS,
    )
  }

  /** What the config on disk says now, which is what survives the window. */
  const configured = (): string => readFileSync(join(home, 'config.yaml'), 'utf8')

  it('closes the project the × is on while an agent in it goes on working', async () => {
    const app = await over(['app', 'other'])
    await agentIn(app, 'app', 'charge-once')
    const at = closeOf('app')
    click(at.col, at.row)

    await until('the project closed', () => client.config.projects.app === undefined)
    // Out of the config on disk, so it is still closed tomorrow — and the
    // other project is untouched by it.
    expect(configured()).not.toContain('app:')
    expect(client.config.projects.other).toBeDefined()
    await until('its tab gone', () => !tabs().text.includes('app'))
    // The tab you were on went, so you are in what is left rather than in a
    // project that is not there.
    expect(tabs().text).toContain('[ other')

    // Nothing was stopped: the agent is still working, in the same lane, and
    // its task file is exactly where it was.
    expect(client.runs().map((run) => run.task)).toContain('app/charge-once')
    expect(client.lanes('app/charge-once').some((lane) => lane.alive)).toBe(true)
    expect(readFileSync(join(taskDir(home, 'app/charge-once'), 'task.yaml'), 'utf8')).toContain(
      'charge-once',
    )
    // And nothing of the project itself went.
    expect(repo.git('log', '--oneline')).toContain('first')
  })

  it('says what it closed and what kept working, where notices go', async () => {
    const app = await over(['app', 'other'])
    await agentIn(app, 'app', 'charge-once')
    const at = closeOf('app')
    terminal.written = ''
    click(at.col, at.row)
    await until('the project closed', () => client.config.projects.app === undefined)
    await until('what it did, said', () =>
      screenOf(terminal.written).some((row) =>
        /closed app · an agent is still working in it/.test(row),
      ),
    )
  })

  it('closes the tab the × was on and not the project you are standing in', async () => {
    await over(['app', 'other', 'third'])
    const at = closeOf('other')
    click(at.col, at.row)
    await until('the middle one closed', () => client.config.projects.other === undefined)
    expect(Object.keys(client.config.projects).sort()).toEqual(['app', 'third'])
    // And you are still standing where you were: closing a tab you are not on
    // is not a reason to go anywhere.
    await until('still in app', () => tabs().text.includes('[ app'))
  })

  it('closes it from the menu beside the tab, agent or no agent', async () => {
    const app = await over(['app', 'other'])
    await agentIn(app, 'app', 'charge-once')
    const bar = tabs()
    const menu = bar.text.indexOf('≡', bar.text.indexOf('app'))
    click(menu, bar.row)
    await until('the menu', () => terminal.written.includes('Close'))
    // What it costs rather than a reason it cannot: the item is pressable.
    const lines = screenOf(terminal.written)
    const item = lines.findIndex((line) => line.includes('Close'))
    expect(lines[item]).toContain('an agent keeps working')
    click(lines[item]?.indexOf('Close') ?? 0, item)
    await until('the project closed', () => client.config.projects.app === undefined)
    expect(client.runs().map((run) => run.task)).toContain('app/charge-once')
  })

  it('is still closable in a window too narrow to draw the × at all', async () => {
    // The buttons are the first thing the top row gives up for space
    // (`LADDER`), so in a narrow terminal there is no `×` and no `≡` — and the
    // menu they are a shortcut to is a right-click on the tab, which is how a
    // narrow window keeps the one act nothing else offers.
    await over(['app', 'other'], 80)
    const bar = tabs()
    // Up to the `+`, which is where the tabs end: the `×` beside the talk key
    // is the mute mark and belongs to the window rather than to a project.
    expect(bar.text.slice(0, bar.text.indexOf('+'))).not.toContain('×')
    const at = bar.text.indexOf('app')
    terminal.press(`\x1b[<2;${at + 1};${bar.row + 1}M`)
    terminal.press(`\x1b[<2;${at + 1};${bar.row + 1}m`)
    await until('the menu', () => terminal.written.includes('Close'))
    const lines = screenOf(terminal.written)
    const item = lines.findIndex((line) => line.includes('Close'))
    click(lines[item]?.indexOf('Close') ?? 0, item)
    await until('the project closed', () => client.config.projects.app === undefined)
  })

  it('tells whoever asked for it which agents it left working', async () => {
    const app = await over(['app', 'other'])
    await agentIn(app, 'app', 'charge-once')
    // The orchestrator's door, which is gated on the person having named the
    // project: the same close, and the whole sentence rather than the notice's
    // half of it.
    await client.log.append({
      type: 'said',
      task: null,
      detail: { text: 'close app, I am done with it' },
    })
    const said = await app
      .configTools()
      .closeProject({ project: 'app', said: 'close app, I am done with it' })
    expect(said).toContain('stopped nothing')
    expect(said).toContain('app/charge-once')
    expect(said).toContain('Nothing was deleted')
    expect(client.runs().map((run) => run.task)).toContain('app/charge-once')
  })

  it('closes the last project there is and goes on drawing', async () => {
    await over(['app'])
    const at = closeOf('app')
    click(at.col, at.row)
    await until('nothing left', () => Object.keys(client.config.projects).length === 0)
    // The window is still a window: it says there is nothing open rather than
    // drawing a project that is not there.
    await until('still drawing', () => tabs().text.includes('T A D E'))
    expect(configured()).not.toContain('app:')
  })

  it('is still closed when the window opens again', async () => {
    const app = await over(['app', 'other'])
    await agentIn(app, 'app', 'charge-once')
    const at = closeOf('app')
    click(at.col, at.row)
    await until('the project closed', () => client.config.projects.app === undefined)
    await app.stop()

    const second = newTerminal()
    await start({ config: ConfigSchema.parse({ projects: client.config.projects }) })
    await until('the second window', () => second.written.includes('Settings'))
    const bar = screenOf(second.written).find((line) => line.includes('T A D E')) ?? ''
    expect(bar).toContain('other')
    expect(bar).not.toContain('app')
  })
})

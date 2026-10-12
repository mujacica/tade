import { rememberUpdates, type UpdateLook } from '@tade/workbench/programs'
import { describe, expect, it } from 'vitest'
import { lookWith, program } from '../updates-fixture.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// Updating from the strip, through the whole window and a real shell: the
// chip the last window's answer draws, a click on it, the exact command typed
// into the `updates` terminal in front of you, and what it came to said in
// the conversation — and, where Tade itself moved, the reload offered.
//
// The window is handed a way to read what is current that answers from here,
// because a suite may never reach the network it runs on; the commands are
// `echo` and `false`, because it may not install anything either.

describe('updating from the strip', () => {
  let terminal: FakeTerminal
  let home: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    home = wired.home
  })

  const screen = () => screenOf(terminal.written).join('\n')

  /** The window over a home whose last check found `before`, reading `after` from then on. */
  async function opened(before: UpdateLook, after: UpdateLook, reloads: string[] = []) {
    await rememberUpdates(home, before)
    const reads: boolean[] = []
    terminal.rows = 40
    terminal.columns = 160
    const app = await start({
      updates: async (_config, _home, ask) => {
        reads.push(ask)
        return { ...after, asked: ask }
      },
      reloadWindow: async () => {
        reloads.push('reload')
      },
    })
    return { app, reads }
  }

  it('runs what the chip counts in a terminal in front, and says what it updated', async () => {
    const run = 'echo moving demo forward'
    const { app, reads } = await opened(
      lookWith({ programs: [program('demo', { behind: true, run })] }),
      lookWith({ programs: [program('demo', { run })] }),
    )
    await until('the chip', () => screen().includes('updates 1'))
    const chip = find('updates 1')
    click(chip.col + 1, chip.row)

    // What it printed, on a row of its own: never the line typed, which echoes it.
    await until('the command run in the updates terminal', () =>
      screenOf(terminal.written).some(
        (row) => row.includes('moving demo forward') && !row.includes('echo'),
      ),
    )
    await until('asked again after it', () => reads.includes(true), 60_000)
    await until('said what it updated', async () =>
      (await app.updateTools().read(false)).includes('Updated demo to 1.1.0.'),
    )
    // Nothing is behind now, so there is nothing to say in the strip.
    await until('the chip gone', () => !screenOf(terminal.written).at(-1)?.includes('updates 1'))
    // And in the conversation, where somebody reads what came of it.
    const tab = find('orchestrator')
    click(tab.col + 1, tab.row)
    await until('said in the conversation', () => screen().includes('Updated demo to 1.1.0.'))
    expect(screen()).not.toContain('failed')
  })

  it('says a failure in the conversation, with the command and where the rest is', async () => {
    const { app } = await opened(
      lookWith({ programs: [program('demo', { behind: true, run: 'false' })] }),
      lookWith({ programs: [program('demo', { behind: true, run: 'false' })] }),
    )
    await until('the chip', () => screen().includes('updates 1'))
    const chip = find('updates 1')
    click(chip.col + 1, chip.row)
    await until('said it failed', async () =>
      (await app.updateTools().read(false)).includes('demo (`false`) failed'),
    )
    const said = JSON.parse(await app.updateTools().read(false)) as { lastRun: { said: string } }
    expect(said.lastRun.said).toContain('The whole of what it printed is in the updates terminal.')
  })

  it('offers the reload when Tade itself moved, and reloads when it is pressed', async () => {
    const reloads: string[] = []
    await opened(
      lookWith({ tadeNewer: true, tadeRun: 'echo pulling tade' }),
      lookWith({ commit: '1a2b3c4', tadeRun: 'echo pulling tade' }),
      reloads,
    )
    await until('the chip', () => screen().includes('updates 1'))
    const chip = find('updates 1')
    click(chip.col + 1, chip.row)
    await until('the reload offered', () => screen().includes('Reload into the new Tade?'), 60_000)
    expect(screen()).toContain('Tade was updated to 1a2b3c4')
    // And the chip carries it for as long as it is not taken.
    expect(screenOf(terminal.written).at(-1)).toContain('reload Tade')
    // Nothing an agent runs would stop, so it is the plain press, not "anyway".
    expect(screen()).toContain('Terminals close under pty')
    const press = find('Reload ]')
    click(press.col + 1, press.row)
    await until('reloaded', () => reloads.length === 1)
  })
})

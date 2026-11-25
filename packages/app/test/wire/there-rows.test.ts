import { rm } from 'node:fs/promises'
import { type FarAgent, type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'
import { pressRow, standingThere } from './standing-there.ts'

// Another machine's rows answer every control a row here has, through the
// whole window: a right-click on an agent there opens the menu an agent here
// has, Stop agent in it is that machine's own stop, an item that cannot cross
// the link is there and off with why, and a schedule there is paused by the
// same `‖` a schedule here is — through that machine's own tool host. The far
// end is a real away view (`far.ts`) and the link the scripted one.

const LINK: FarAgent = {
  task: 'tade/remote-link',
  title: 'Linking',
  reason: 'running the suite',
  screen: '> running the suite\n  14 passed',
}

describe('another machine’s rows, answering as rows here do', () => {
  let terminal: FakeTerminal
  const fars: FarEnd[] = []
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
  })

  afterEach(async () => {
    await Promise.all(fars.map((far) => far.close()))
    await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
    fars.length = 0
  })

  const rows = () => screenOf(terminal.written)
  const shown = (text: string) => rows().some((row) => row.includes(text))
  const screen = (what: string) => () => `${what}, where the screen shows:\n${rows().join('\n')}`

  /** A right-click on the side's row that says `label`, as a terminal sends one. */
  function rightClick(label: string): void {
    const lines = rows()
    for (let at = 1; at < lines.length; at++) {
      const line = lines[at] ?? ''
      const col = line.indexOf(label)
      const edge = line.indexOf('│')
      if (col >= 0 && (edge < 0 || col < edge)) {
        terminal.press(`\x1b[<2;${col + 2};${at + 1}M`)
        terminal.press(`\x1b[<2;${col + 2};${at + 1}m`)
        return
      }
    }
    throw new Error(screen(`no row says ${label}`)())
  }

  async function linkedTo(far: FarEnd): Promise<void> {
    await standingThere(wired, far)
    await until(screen('its agent down the side'), () => shown('Linking'), 20_000)
  }

  it('opens the menu an agent here has, carries Stop there, and says why an item cannot cross', async () => {
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    far.show(['tade'], {}, [LINK])
    await linkedTo(far)
    rightClick('Linking')
    await until(screen('its menu'), () => shown('Stop agent'), 20_000)
    // Item for item the menu here: what cannot cross the link says so in words.
    for (const item of ['Show changes', 'Open in editor', 'Park', 'Remove agent']) {
      expect(shown(item), screen(item)()).toBe(true)
    }
    expect(shown('read on vps'), screen('why')()).toBe(true)
    const at = wired.find('Stop agent')
    wired.click(at.col + 1, at.row)
    await until(screen('the stop there'), () => far.acted.some((one) => one.verb === 'stop'))
    expect(far.acted.find((one) => one.verb === 'stop')?.call).toMatchObject({
      task: 'tade/remote-link',
      confirm: true,
    })
    // Named as this window last saw it, so a press against a stale row is that machine's to refuse.
    expect(typeof far.acted.find((one) => one.verb === 'stop')?.call.was).toBe('string')
    await until(screen('what came of it'), () => shown('vps: stop done there'), 20_000)
  })

  it('draws a schedule there as one here, and pauses it through that machine’s own gate', async () => {
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    far.show(['tade'], {}, [LINK])
    far.machine = {
      at: new Date().toISOString(),
      version: '0.0.0',
      newer: null,
      public: null,
      problems: [],
      schedules: [
        {
          id: 'nightly',
          name: 'Nightly sweep',
          project: 'tade',
          kind: 'agent',
          when: 'every day at 03:00',
          paused: false,
          next: new Date(Date.now() + 3_600_000).toISOString(),
          watch: null,
        },
      ],
      documents: [],
    } as never
    await linkedTo(far)
    await until(screen('its schedule down the side'), () => shown('Nightly'), 20_000)
    // Pressed, its card is drawn as a schedule's here is, with its own controls.
    pressRow(wired, 'Nightly')
    await until(screen('its card'), () => shown('Run now'), 20_000)
    const pause = wired.find('‖ Pause')
    wired.click(pause.col + 1, pause.row)
    await until(screen('the pause there'), () =>
      far.toolCalls.some((one) => one.method === 'queue/change'),
    )
    expect(far.toolCalls.find((one) => one.method === 'queue/change')?.params).toEqual({
      schedule: 'nightly',
      change: 'pause',
    })
    // A press here, not words: nothing of the person's is quoted with it.
    expect(far.toolCalls.find((one) => one.method === 'queue/change')?.quoted).toEqual([])
  })
})

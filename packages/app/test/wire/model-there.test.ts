import { rm } from 'node:fs/promises'
import { type FarAgent, type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { afterEach, describe, expect, it } from 'vitest'
import { modelsOfMenu } from '../../src/wire/remote-agent.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'
import { standingThere } from './standing-there.ts'

// Change model… on an agent on another machine is a picker, as it is on an
// agent here: the models that machine's own menu for it lists (the list its
// phone gets), the one it is on marked, and the one chosen carried there as
// its `model` verb — with a name typed where that machine lists none. The far
// end is a real away view (`far.ts`) and the link the scripted one.

const LINK: FarAgent = {
  task: 'tade/remote-link',
  title: 'Linking',
  reason: 'running the suite',
  screen: '> running the suite\n  14 passed',
}

describe('Change model… on an agent on another machine', () => {
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

  async function press(label: string): Promise<void> {
    await until(screen(`"${label}" on screen`), () => shown(label), 20_000)
    const at = wired.find(label)
    wired.click(at.col + 1, at.row)
  }

  async function pickerOn(agent: FarAgent): Promise<FarEnd> {
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    far.show(['tade'], {}, [agent])
    await standingThere(wired, far)
    await until(screen('its agent down the side'), () => shown('Linking'), 20_000)
    rightClick('Linking')
    await press('Change model…')
    return far
  }

  it('lists the models that machine runs it on, marks the one in use, and carries the one chosen', async () => {
    const far = await pickerOn({
      ...LINK,
      models: [{ id: 'anthropic/claude-opus-5', current: true }, { id: 'openai/gpt-6' }],
    })
    await until(screen('its models'), () => shown('gpt-6'), 20_000)
    expect(shown('● claude-opus-5'), screen('the one in use')()).toBe(true)
    expect(shown('Type a name…'), screen('a name typed')()).toBe(true)
    await press('gpt-6')
    await until(screen('the model there'), () => far.acted.some((one) => one.verb === 'model'))
    expect(far.acted.find((one) => one.verb === 'model')?.call).toMatchObject({
      task: 'tade/remote-link',
      model: 'openai/gpt-6',
    })
    await until(screen('what came of it'), () => shown('vps: model done there'), 20_000)
  })

  it('says why where that machine lists none, and carries a name typed instead', async () => {
    const far = await pickerOn(LINK)
    await until(screen('why there is no list'), () => shown('offers no model list'), 20_000)
    await press('Type a name…')
    await until(screen('the line to type it on'), () => shown('Model for Linking'), 20_000)
    terminal.press('openai/gpt-6')
    terminal.press('\r')
    await until(screen('the model there'), () => far.acted.some((one) => one.verb === 'model'))
    expect(far.acted.find((one) => one.verb === 'model')?.call).toMatchObject({
      model: 'openai/gpt-6',
    })
  })
})

describe('modelsOfMenu', () => {
  it('reads the choices under Change model…, marking the one in use', () => {
    const read = modelsOfMenu(
      {
        items: [
          {
            id: 'model',
            off: null,
            act: {
              kind: 'choose',
              verb: 'model',
              choices: [
                { id: 'a/one', label: 'one', current: true, off: null, note: null },
                { id: 'a/two', label: 'two', current: false, off: 'not signed in', note: null },
              ],
              why: null,
            },
          },
        ],
      },
      'vps',
    )
    expect(read).toEqual({
      items: [
        { id: 'model:a/one', label: '● one', note: 'now' },
        { id: 'model:a/two', label: '  two', off: 'not signed in' },
      ],
      why: null,
    })
  })

  it('says why, in that machine’s words, where the item is off or the answer is not a menu', () => {
    expect(modelsOfMenu({ items: [{ id: 'model', off: 'not running' }] }, 'vps')).toEqual({
      items: [],
      why: 'not running',
    })
    expect(modelsOfMenu({ items: [], why: 'the machine took too long' }, 'vps').why).toBe(
      'the machine took too long',
    )
    expect(modelsOfMenu('nonsense', 'vps').why).toBe('vps offers no model list for it here')
    expect(modelsOfMenu({ items: [{ id: 'model', act: { kind: 'here' } }] }, 'vps').why).toBe(
      'vps offers no model list for it here',
    )
  })

  it('keeps what is drawn printable, whatever that machine sent', () => {
    const read = modelsOfMenu(
      {
        items: [
          {
            id: 'model',
            act: { kind: 'choose', choices: [{ id: 'x', label: 'evil\u001b[2Jname' }, { id: '' }] },
          },
        ],
      },
      'vps',
    )
    expect(read.items).toHaveLength(1)
    expect(read.items[0]?.label).not.toContain('\u001b')
  })
})

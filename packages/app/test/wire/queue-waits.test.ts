import { readTaskFile, type Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, SPAWNING_MS, screenOf, until, windowUnderTest } from './harness.ts'

// What queued work waits on, changed from its menu: a list of every task it
// could wait on to pick from, saved through the queue's own `after`. It was a
// line of names to type, which offered nothing to pick and said nothing about
// a name that was no task any more.

describe('picking what queued work waits on', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let home: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    home = wired.home
  })

  const onScreen = (text: string) => screenOf(terminal.written).some((row) => row.includes(text))

  /** Its row in the side, right-clicked, and Wait on… chosen from the menu. */
  async function openWaits(task: string) {
    await until(`${task} in the queue`, () => onScreen(task))
    const row = find(task)
    terminal.press(`\x1b[<2;${row.col + 2};${row.row + 1}M`)
    terminal.press(`\x1b[<2;${row.col + 2};${row.row + 1}m`)
    await until('its menu', () => onScreen('Wait on…'))
    const item = find('Wait on…')
    click(item.col + 1, item.row)
    await until('the list', () => onScreen(`What ${task} waits on`))
  }

  it('picks an agent at work and saves it as a wait, keeping the wait it had', async () => {
    terminal.columns = 140
    terminal.rows = 45
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await window.queueTools().plan({
      project: 'app',
      said: 'one at work, and two in a line',
      agents: [
        { name: 'busy-one', said: 'go', prompt: '', after: [], touches: [] },
        {
          name: 'gate',
          said: 'gate',
          prompt: '',
          after: [{ agent: 'busy-one', why: 'first' }],
          touches: [],
        },
        {
          name: 'later',
          said: 'later',
          prompt: '',
          after: [{ agent: 'gate', why: 'it needs the gate' }],
          touches: [],
        },
      ],
    })
    await until(
      'busy-one started',
      () => client.runs().some((run) => run.task === 'app/busy-one'),
      SPAWNING_MS,
    )
    await openWaits('later')
    expect(onScreen('WAITS ON NOW')).toBe(true)
    expect(onScreen('AGENTS AT WORK')).toBe(true)
    expect(onScreen('it needs the gate')).toBe(true)
    // Narrowed by typing, and the one left picked with space.
    terminal.press('busy')
    await until('narrowed', () => !onScreen('WAITS ON NOW') && onScreen('busy-one'))
    terminal.press(' ')
    await until('picked', () => onScreen('1 picked') === false && onScreen('2 picked'))
    const save = find('Save')
    click(save.col + 1, save.row)
    await until(
      'saved',
      async () => (await readTaskFile(home, 'app/later'))?.start?.after?.length === 2,
    )
    expect((await readTaskFile(home, 'app/later'))?.start?.after).toEqual([
      { task: 'app/gate', why: 'it needs the gate' },
      { task: 'app/busy-one', why: '' },
    ])
    await until('the panel gone', () => !onScreen('What later waits on'))
  })

  it('marks a wait on a task that was removed, and drops it', async () => {
    terminal.columns = 140
    terminal.rows = 45
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    await tools.plan({
      project: 'app',
      said: 'a parked gate, and work behind it',
      agents: [
        { name: 'busy-one', said: 'go', prompt: '', after: [], touches: [] },
        {
          name: 'gate',
          said: 'gate',
          prompt: '',
          after: [{ agent: 'busy-one', why: 'first' }],
          touches: [],
        },
        {
          name: 'behind',
          said: 'behind',
          prompt: '',
          after: [{ agent: 'gate', why: 'old reason' }],
          touches: [],
        },
      ],
    })
    await tools.change({ task: 'app/gate', change: 'remove' })
    await openWaits('behind')
    await until('said to be removed', () => onScreen('removed — drop it'))
    // Saved as it stands, the queue refuses it in words, in the panel.
    const save = find('Save')
    click(save.col + 1, save.row)
    await until('refused', () => onScreen('not a task Tade has'))
    const drop = find('Drop 1 gone')
    click(drop.col + 1, drop.row)
    await until('dropped', () => onScreen('0 picked'))
    const again = find('Save')
    click(again.col + 1, again.row)
    await until(
      'saved',
      async () => (await readTaskFile(home, 'app/behind'))?.start?.after?.length === 0,
    )
    await until('the panel gone', () => !onScreen('What behind waits on'))
  })
})

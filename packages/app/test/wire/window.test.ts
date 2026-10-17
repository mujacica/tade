import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { acknowledge, FLASH_MS } from '../../src/flash.ts'
import { type AppState, initialState, ORCHESTRATOR_TAB, withTranscript } from '../../src/model.ts'
import { fromThinker, type ThinkerEvent } from '../../src/transcript.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Window } from '../../src/wire/window.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// What the window keeps of itself across a close — the pane you were
// watching, the sections you folded, where the edge is — the name it gives
// the terminal, and the project you open into it.

describe('the window, remembering itself', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let home: string
  let repo: { root: string }
  const { start, newTerminal, click, find, sidebar, headingRow } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    home = wired.home
    repo = wired.repo
  })

  it('names its own window after what is happening', async () => {
    await start()
    await until('the window to name itself', () => terminal.titles.length > 0)
    // Tade owns the title: nothing it starts is left in the terminal's
    // foreground process group to name the window after itself instead.
    const title = terminal.titles.at(-1) ?? ''
    expect(title).toContain('tade')
    expect(title).toMatch(/idle|working|waiting|nothing running/)
  })

  it('comes back to the pane you were watching', async () => {
    const first = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Focus starts on refunds; move it to search.
    terminal.press('\t')
    await until('the marker to move', () => /▌ \S search/.test(terminal.written))
    await first.stop()
    // Where you were is written down per project as well as on its own, so
    // that coming back to a project tomorrow and coming back to it a second
    // after leaving are the same arrival.
    const kept = JSON.parse(readFileSync(join(home, 'window.json'), 'utf8'))
    expect(kept.focused).toBe('app/search')
    expect(kept.spots.app).toEqual({ focused: 'app/search' })

    // A new window, same home: it should not dump you back on the first task.
    terminal = newTerminal()
    await start()
    // The agent's row, not the word: the header says `search` too wherever
    // there is room for its ctrl+k hint.
    await until('the window to come back', () =>
      screenOf(terminal.written).some((row) => row.includes('○ search')),
    )
    expect(terminal.written).toMatch(/▌ \S search/)
  })

  it('opens on the first task when it has never been opened before', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    expect(terminal.written).toMatch(/▌ \S refunds/)
  })

  it('opens a project from the + beside the tabs, looking in your home folder', async () => {
    const folders = tmp('tade-app-home-')
    writeFileSync(join(folders, 'notes.txt'), 'not a folder')
    mkdirSync(join(folders, 'payments'))
    const was = process.env.HOME
    process.env.HOME = folders
    try {
      await start()
      // The wordmark is spelt with the letters apart, so look for it that way.
      await until('the first frame', () => terminal.written.includes('T A D E'))
      const tabs = screenOf(terminal.written)[0] ?? ''
      terminal.written = ''
      click(tabs.indexOf('+'), 0)
      await until('the panel', () => terminal.written.includes('Open a project'))
      await until('the folders in home', () => terminal.written.includes('payments/'))
      expect(terminal.written).toContain('RECENT')

      // Once to choose it, and again to go in, the way folders work everywhere.
      const folder = find('payments/')
      click(folder.col, folder.row)
      await until('it to be chosen', () => terminal.written.includes('Open ~/payments'))
      terminal.written = ''
      click(folder.col, folder.row)
      await until('the folder to be opened', () => terminal.written.includes('no folders here'))

      // Somewhere to work that is not there yet: typed as a path, offered as a
      // row, and named from its own last segment. What pressing it does to the
      // disk is `a folder that is not there yet` in projects.test.ts — here it
      // is that the offer reaches the screen at all, which is what somebody
      // who knows where they want to work could not do before.
      terminal.written = ''
      terminal.press(`${folders}/refunds-api`)
      await until('the offer to make it', () => terminal.written.includes('create · git init'))
      terminal.written = ''
      terminal.press('\x1b[B')
      await until('it to be chosen', () => terminal.written.includes('Create '))
      expect(terminal.written).toContain('refunds-api')
    } finally {
      process.env.HOME = was
    }
  })

  it('opens on the view you left: the finished agents hidden, the sections you folded', async () => {
    terminal.columns = 120
    terminal.rows = 40
    // One of the two has finished, so `H` beside AGENTS is there to press.
    await client.log.append({ type: 'task_done', task: 'app/search', detail: { by: 'you' } })
    const first = await start()
    await until('the finished agent', () => sidebar().includes('✓ search'))
    // `H` on the AGENTS heading. Found on the sidebar's own side of the
    // divider: the pane beside it has letters in that row too.
    const { row, text } = headingRow()
    const col = text.lastIndexOf('H')
    expect(col).toBeGreaterThan(0)
    click(col, row)
    await until('the finished agent gone from the list', () => !sidebar().includes('✓ search'))
    // Hidden is a view and nothing more: the agent it hid is still an agent.
    expect(sidebar()).toContain('refunds')
    expect(headingRow().text).toContain('<H>')
    // The same goes for the heading beside it: folding a section shut is a
    // view choice made on a heading too, and it survives or it does not.
    const changes = headingRow('CHANGES')
    click(changes.text.indexOf('CHANGES'), changes.row)
    await until('the section folded', () => headingRow('CHANGES').text.includes('▸ CHANGES'))
    await first.stop()
    const kept = JSON.parse(readFileSync(join(home, 'window.json'), 'utf8'))
    expect(kept.hidingDone).toBe(true)
    expect(kept.folded).toContain('changes')

    // Opened again, and it never draws them: the choice is read back before
    // the first frame, so the list does not flash the other way. Everything
    // written, not the screen as it ends up — a row painted and taken away is
    // exactly what this is about.
    terminal.written = ''
    await start()
    await until('the window again', () => sidebar().includes('refunds'))
    expect(headingRow().text).toContain('<H>')
    expect(headingRow('CHANGES').text).toContain('▸ CHANGES')
    expect(terminal.written).not.toContain('✓ search')
    expect(terminal.written).not.toContain('▾ CHANGES')
  })

  it('comes back to the queue this project was showing, and writes down nothing else', async () => {
    terminal.columns = 160
    terminal.rows = 40
    const first = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // A chain of three: the front of it starts, and the two behind it stay
    // queued — so the controls have something to filter for the whole test.
    await first.queueTools().plan({
      project: 'app',
      said: 'one after another',
      agents: [
        { name: 'first-one', said: 'one now', prompt: '', after: [], touches: [] },
        ...['second-one', 'third-one'].map((name, i) => ({
          name,
          said: `after the ${i === 0 ? 'first' : 'second'}`,
          prompt: '',
          after: [{ agent: i === 0 ? 'first-one' : 'second-one', why: 'one file, in order' }],
          touches: [],
        })),
      ],
    })
    // The scope is the whole of the row: one question, one pair.
    const rowOf = (label: string) => headingRow(label).row + 1
    await until('the queue on screen', () =>
      (screenOf(terminal.written)[rowOf('SMART QUEUE')] ?? '').includes('<all> [next]'),
    )
    const row = rowOf('SMART QUEUE')
    click((screenOf(terminal.written)[row] ?? '').indexOf('next'), row)
    await until('next showing', () =>
      (screenOf(terminal.written)[rowOf('SMART QUEUE')] ?? '').includes('<next>'),
    )
    await first.stop()
    // One project's choice, written under that project's name — and only
    // because it was narrowed: a project showing the whole of its queue never
    // said anything, and a default written down is a default frozen.
    const kept = JSON.parse(readFileSync(join(home, 'window.json'), 'utf8'))
    expect(kept.queueViews).toEqual({ app: { scope: 'next' } })

    // Opened again: it is showing what it was showing.
    await start()
    await until('the window again', () => sidebar().includes('refunds'))
    await until('next still showing', () => sidebar().includes('<next>'))
  })

  it('keeps the project tabs in the order you moved them into', async () => {
    terminal.columns = 200
    terminal.rows = 40
    // Two projects, so there is a row to arrange at all. The second is its own
    // repository: a project is somewhere agents work, and two names pointed at
    // one checkout is not a case Tade has.
    const second = mkrepo()
    const config = ConfigSchema.parse({
      projects: { app: { root: repo.root }, infra: { root: second.root } },
    })
    const first = await start({ config })
    await until('the tabs', () => screenOf(terminal.written)[0]?.includes('infra') === true)
    const tabs = () => screenOf(terminal.written)[0] ?? ''
    expect(tabs().indexOf('app')).toBeLessThan(tabs().indexOf('infra'))

    // Moved from the tab's own menu, opened from the `≡` beside it — the same
    // two buttons a terminal's tab has, in the same place.
    const row = tabs()
    const menu = row.indexOf('≡', row.indexOf('infra'))
    expect(row.indexOf('×', row.indexOf('infra'))).toBeGreaterThan(0)
    expect(menu).toBeGreaterThan(0)
    click(menu, 0)
    await until('the menu', () => terminal.written.includes('Move left'))
    const move = find('Move left')
    click(move.col, move.row)
    await until('the tab moved', () => tabs().indexOf('infra') < tabs().indexOf('app'))
    await first.stop()

    // Written down on the way out — and on the move itself, since a window
    // that is killed rather than closed would otherwise forget it every time.
    const kept = JSON.parse(readFileSync(join(home, 'window.json'), 'utf8'))
    expect(kept.projectOrder).toEqual(['infra', 'app'])

    // Opened again, same home: the row is as it was left, not as the config
    // lists it.
    terminal = newTerminal()
    terminal.columns = 200
    terminal.rows = 40
    await start({ config })
    await until('the window again', () => (screenOf(terminal.written)[0] ?? '').includes('infra'))
    const back = screenOf(terminal.written)[0] ?? ''
    expect(back.indexOf('infra')).toBeLessThan(back.indexOf('app'))

    // And the `×` beside it closes that project — out of the config, and not
    // a byte of the repository touched, which is what makes it the reversible
    // act and `rm -rf` somebody else's.
    click(back.indexOf('×', back.indexOf('infra')), 0)
    await until('the tab gone', () => !(screenOf(terminal.written)[0] ?? '').includes('infra'))
    expect(statSync(join(second.root, '.git')).isDirectory()).toBe(true)
  })

  it('keeps the SMART QUEUE open once you open it, with nothing in it to open it for', async () => {
    terminal.columns = 160
    terminal.rows = 40
    const first = await start()
    // There with nothing queued, folded by itself, and saying why rather than
    // saying only its own name.
    // Past *looking…*, which the heading says until the first look is drawn:
    // the title can say so a frame before the side does.
    await until(
      'the queue heading, looked',
      () =>
        sidebar().includes('SMART QUEUE') && !headingRow('SMART QUEUE').text.includes('looking…'),
    )
    expect(headingRow('SMART QUEUE').text).toContain('▸ SMART QUEUE')
    expect(headingRow('SMART QUEUE').text).toContain('nothing is queued')
    const { row, text } = headingRow('SMART QUEUE')
    click(text.indexOf('SMART QUEUE'), row)
    await until('it open', () => headingRow('SMART QUEUE').text.includes('▾ SMART QUEUE'))
    await first.stop()
    const kept = JSON.parse(readFileSync(join(home, 'window.json'), 'utf8'))
    expect(kept.opened).toContain('queue')

    // Opened again with nothing queued still: it stays the way you left it,
    // rather than folding itself away over your choice.
    await start()
    await until('the window again', () => sidebar().includes('refunds'))
    expect(headingRow('SMART QUEUE').text).toContain('▾ SMART QUEUE')
  })
})

// How the window says a moment, which every region showing a time reads off
// the frame. A region is kept over what it read (`view/last-frame.ts`), so a
// clock made again every frame was a queue or a schedule drawn again every
// frame for nothing; one made once would go on saying a time from yesterday
// as if it were today's. Built by hand: the whole of it is what `facts` hands
// over as the day goes by, which no screen could show without waiting a day.
describe('how the window says a moment', () => {
  function windowAt(now: { at: number }): Window {
    const wire = {
      opts: { config: ConfigSchema.parse({}), home: '/tmp/tade-home' },
      state: initialState(),
      now: () => now.at,
    } as unknown as Wiring
    return new Window(wire, { setTitle: () => {}, stop: async () => {}, news: () => {} })
  }

  it('hands the frame one clock all day, and another one the next', () => {
    const now = { at: new Date(2026, 8, 13, 9, 0).getTime() }
    const window = windowAt(now)
    const sunday = window.facts().clock
    now.at = new Date(2026, 8, 13, 23, 59, 59).getTime()
    expect(window.facts().clock).toBe(sunday)
    now.at = new Date(2026, 8, 14, 0, 0).getTime()
    const monday = window.facts().clock
    expect(monday).not.toBe(sunday)
    const lastThing = new Date(2026, 8, 13, 23, 30).getTime()
    expect(sunday?.(lastThing)).toBe('23:30')
    expect(monday?.(lastThing)).toBe('Sun 23:30')
    // And a clock put back across midnight is the day it is put back to.
    now.at = new Date(2026, 8, 13, 22, 0).getTime()
    expect(window.facts().clock?.(lastThing)).toBe('23:30')
  })

  it('hands it one way of dating a moment, which reads no clock at all', () => {
    const now = { at: new Date(2026, 8, 13, 9, 0).getTime() }
    const window = windowAt(now)
    const date = window.facts().date
    now.at += 3 * 86_400_000
    expect(window.facts().date).toBe(date)
  })
})

describe('answering where you are looking', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })
  const shown = (text: string) => screenOf(terminal.written).some((row) => row.includes(text))

  it('flashes a press that worked over the foot, never in the conversation, and lets it go', async () => {
    const clock = { at: Date.now() }
    await start({ now: () => clock.at })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // A fresh Tade starts muted, so the button it offers is the way back.
    const unmute = find('Unmute')
    click(unmute.col + 1, unmute.row)
    const said = 'sound back on'
    await until('the flash', () => shown(said))
    const rows = screenOf(terminal.written)
    // On the rule over the foot's own buttons, and nowhere else on screen.
    expect(rows.filter((row) => row.includes(said))).toHaveLength(1)
    expect(rows.findIndex((row) => row.includes(said))).toBe(find('Settings').row - 1)
    // Nothing else asks for a frame: the window owes one when the flash runs out.
    clock.at += FLASH_MS
    await until('the flash to go', () => !shown(said))
    // Kept for next time, and written down like a change from Settings.
    await until('the line', async () =>
      (await client.events({ types: ['config_changed'] })).some(
        ({ detail }) =>
          detail.path === 'surfaces.voice.muted' &&
          detail.was === '' &&
          detail.now === 'false' &&
          detail.by === 'window',
      ),
    )
  })

  it('marks the conversation’s tab when something lands in it behind a terminal', async () => {
    const listeners: Array<(event: ThinkerEvent) => void> = []
    const opened = await client.openTerminal({ project: 'app' })
    await client.write(opened.id, 'echo the-shell-is-here\r')
    await start({
      thinker: {
        onEvent: (listener) => {
          listeners.push(listener)
          return () => {}
        },
        ask: async () => '',
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tabs = () => screenOf(terminal.written).find((row) => row.includes('orchestrator')) ?? ''
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    await until('the terminal in front', () => shown('the-shell-is-here'), 20_000)
    expect(tabs()).not.toContain('•')

    for (const listener of listeners) listener({ type: 'message', text: 'The build is green.' })
    await until('the mark', () => tabs().includes('orchestrator •'))

    // Going to it is reading it.
    const orchestrator = find('orchestrator')
    click(orchestrator.col + 1, orchestrator.row)
    await until('the answer', () => shown('The build is green.'))
    expect(tabs()).not.toContain('•')
    // And leaving it again with nothing new is nothing to come back for.
    const again = find('terminal 1')
    click(again.col + 1, again.row)
    await until('the terminal in front again', () => shown('the-shell-is-here'))
    expect(tabs()).not.toContain('•')
  })
})

describe('the frame the window owes', () => {
  function windowOver(state: { now: AppState }, now: { at: number }): Window {
    const wire = {
      opts: { config: ConfigSchema.parse({}), home: '/tmp/tade-home' },
      get state() {
        return state.now
      },
      now: () => now.at,
    } as unknown as Wiring
    return new Window(wire, { setTitle: () => {}, stop: async () => {}, news: () => {} })
  }

  it('is one when a flash runs out, and none while it is still up', () => {
    const now = { at: 10_000 }
    const state = { now: acknowledge(initialState(), 'copied ~/README.md', 10_000) }
    const window = windowOver(state, now)
    expect(window.facts().flash).toBe('copied ~/README.md')
    expect(window.turned()).toBe(false)
    now.at += FLASH_MS
    expect(window.turned()).toBe(true)
    expect(window.facts().flash).toBeNull()
    expect(window.turned()).toBe(false)
  })

  it('reads the conversation as read only where a frame drew it in front', () => {
    const now = { at: 10_000 }
    const state = { now: { ...initialState(), bottom: 'app/terminals/1' } }
    const window = windowOver(state, now)
    const land = (text: string) => {
      state.now = withTranscript(
        state.now,
        fromThinker(state.now.transcript, { type: 'message', text }, now.at),
      )
    }
    land('The build is green.')
    expect(window.facts().unread).toBe(true)
    // Still unread on every frame until somebody goes to it.
    expect(window.facts().unread).toBe(true)
    state.now = { ...state.now, bottom: ORCHESTRATOR_TAB }
    expect(window.facts().unread).toBe(false)
    state.now = { ...state.now, bottom: 'app/terminals/1' }
    expect(window.facts().unread).toBe(false)
    land('And the deploy.')
    expect(window.facts().unread).toBe(true)
  })
})

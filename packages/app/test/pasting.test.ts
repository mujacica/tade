import { describe, expect, it } from 'vitest'
import {
  focusTask,
  initialState,
  openLine,
  showTerminal,
  type TaskSnapshot,
  withTasks,
  withTerminals,
} from '../src/model.ts'
import { searchPanel } from '../src/panels/search/state.ts'
import { settingsPanel } from '../src/panels/settings/state.ts'
import { pasteGoes, typingAt } from '../src/pasting.ts'

// What ctrl+v means wherever the keyboard is: on Tade's own lines the window
// reads the clipboard, and a lane is sent what a terminal with no kitty
// protocol sends, because the program in it reads its own.

describe('ctrl+v, by where the keyboard is', () => {
  const panes: TaskSnapshot[] = [
    { task: 'app/refunds', state: 'working', lane: 'app/refunds/agent' },
    { task: 'app/stopped', state: 'review', lane: null },
  ]
  const agent = focusTask(withTasks(initialState(), panes), 'app/refunds')
  const shell = showTerminal(
    withTerminals(agent, [{ id: 'app/terminals/1', project: 'app', name: 'terminal 1' }]),
    'app/terminals/1',
  )

  it('reads the clipboard on the orchestrator’s line, a picture first', () => {
    for (const asked of ['ctrl+v', 'cmd+v', 'nothing'] as const) {
      expect(pasteGoes(openLine(agent), asked)).toEqual({ to: 'tade', picture: true })
      // Nothing focused is the orchestrator's line, closed or not.
      expect(pasteGoes(initialState(), asked)).toEqual({ to: 'tade', picture: true })
    }
  })

  it('reads the clipboard’s text into a panel, and leaves ctrl+v to one choosing a key', () => {
    const search = { ...agent, panel: searchPanel() }
    expect(pasteGoes(search, 'ctrl+v')).toEqual({ to: 'tade', picture: false })
    expect(pasteGoes(search, 'nothing')).toEqual({ to: 'tade', picture: false })
    const settings = settingsPanel()
    expect(pasteGoes({ ...agent, panel: settings }, 'cmd+v')).toEqual({
      to: 'tade',
      picture: false,
    })
    const choosing = { ...settings, capture: { path: 'surfaces.voice.talk.key', key: null } }
    expect(pasteGoes({ ...agent, panel: choosing }, 'ctrl+v')).toBeUndefined()
  })

  it('leaves ctrl+v to an agent, which reads its own clipboard, and hands it one for a picture', () => {
    expect(pasteGoes(agent, 'ctrl+v')).toBeUndefined()
    // Cmd+V with only a picture on the clipboard: pi takes one on ctrl+v.
    expect(pasteGoes(agent, 'cmd+v')).toEqual({ to: 'lane', lane: 'app/refunds/agent' })
    expect(pasteGoes(agent, 'nothing')).toEqual({ to: 'lane', lane: 'app/refunds/agent' })
    // An agent with nothing running: the picture goes to the orchestrator.
    const stopped = focusTask(agent, 'app/stopped')
    expect(pasteGoes(stopped, 'cmd+v')).toEqual({ to: 'tade', picture: true })
  })

  it('leaves a shell its quoted-insert, and sends it nothing for a Cmd+V with nothing to paste', () => {
    expect(pasteGoes(shell, 'ctrl+v')).toBeUndefined()
    expect(pasteGoes(shell, 'nothing')).toBeUndefined()
    expect(pasteGoes(shell, 'cmd+v')).toEqual({ to: 'nowhere' })
  })

  it('is an ordinary key where nothing asked for the clipboard', () => {
    expect(pasteGoes(openLine(agent), null)).toBeUndefined()
  })

  it('says where typing lands, so a late answer is typed nowhere else', () => {
    expect(typingAt(agent)).toBe(typingAt({ ...agent, dictation: null }))
    expect(typingAt(openLine(agent))).not.toBe(typingAt(agent))
    expect(typingAt({ ...agent, panel: searchPanel() })).not.toBe(typingAt(agent))
    expect(typingAt(shell)).not.toBe(typingAt(agent))
    expect(typingAt(focusTask(agent, 'app/stopped'))).not.toBe(typingAt(agent))
  })
})

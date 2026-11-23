import { describe, expect, it } from 'vitest'
import { awayMenuOf, type MenuExtras } from '../src/away-menu.ts'
import {
  harnessMenuItems,
  menuItems,
  queueMenuItems,
  thinkingMenuItems,
} from '../src/panels/menu/state.ts'

// One agent's menu as a phone draws it: the window's own `menuItems`, each item
// told what a press does from away. The list is the window's — what is
// offered, in its order, which are off and why — and these hold that the phone
// carries every item of it, through the verb that does it, and that an item
// it cannot carry out is drawn off with why rather than dropped.

const EXTRAS: MenuExtras = {
  running: true,
  title: 'the migration',
  offers: null,
  models: {
    list: [
      { id: 'anthropic/claude-opus-5', label: 'claude-opus-5' },
      { id: 'anthropic/claude-sonnet-5', label: 'claude-sonnet-5' },
    ],
    current: 'claude-opus-5',
    why: null,
  },
  thinking: 'high',
  levels: thinkingMenuItems('high', ['low', 'medium', 'high']),
  accounts: [
    { id: '', label: '● its own sign-in', note: 'now' },
    { id: 'work', label: '  work' },
  ],
  harnesses: harnessMenuItems(
    [
      { id: 'pi', title: 'pi', about: '', ready: true },
      { id: 'codex', title: 'Codex', about: 'not ready', ready: false },
    ],
    'pi',
  ),
}

/** A running agent's window menu, with one machine it can be handed to. */
function running() {
  return menuItems({ lane: 'app/one/agent', state: 'working' }, 3, null, [
    { id: 'hand:vps', label: 'Hand to vps' },
  ])
}

describe('an agent’s menu, from away', () => {
  it('carries every item of the window’s menu, in its order, with the two header controls after the model', () => {
    const items = awayMenuOf(running(), EXTRAS)
    const window = running().map((one) => one.id)
    const model = window.indexOf('model')
    expect(items.map((one) => one.id)).toEqual([
      ...window.slice(0, model + 1),
      'thinking',
      'harness',
      ...window.slice(model + 1),
    ])
  })

  it('carries each through the verb that does it, and the page’s own on the page', () => {
    const acts = Object.fromEntries(awayMenuOf(running(), EXTRAS).map((one) => [one.id, one.act]))
    expect(acts.open).toEqual({ kind: 'page', does: 'open' })
    expect(acts['copy-branch']).toEqual({ kind: 'page', does: 'copy-branch' })
    expect(acts.start).toEqual({ kind: 'verb', verb: 'start' })
    expect(acts.stop).toEqual({ kind: 'verb', verb: 'stop' })
    expect(acts['mark-done']).toEqual({ kind: 'verb', verb: 'done' })
    expect(acts.park).toEqual({ kind: 'verb', verb: 'park' })
    expect(acts.remove).toEqual({ kind: 'verb', verb: 'remove' })
    expect(acts.rename).toEqual({ kind: 'type', verb: 'rename', value: 'the migration' })
    expect(acts['hand:vps']).toEqual({ kind: 'verb', verb: 'move', with: { machine: 'vps' } })
    expect(acts.model).toMatchObject({ kind: 'choose', verb: 'model' })
    expect(acts.thinking).toMatchObject({ kind: 'choose', verb: 'thinking' })
    expect(acts.account).toMatchObject({ kind: 'choose', verb: 'account' })
    expect(acts.harness).toMatchObject({ kind: 'choose', verb: 'harness' })
  })

  it('marks the one each list is on as a field, and keeps the window’s word for one it cannot take', () => {
    const items = awayMenuOf(running(), EXTRAS)
    const choices = (id: string) => {
      const act = items.find((one) => one.id === id)?.act
      return act?.kind === 'choose' ? act.choices : []
    }
    expect(choices('model').find((one) => one.current)?.id).toBe('anthropic/claude-opus-5')
    expect(choices('thinking').find((one) => one.current)?.id).toBe('high')
    expect(choices('account')).toEqual([
      { id: '', label: 'its own sign-in', current: true, off: null, note: null },
      { id: 'work', label: 'work', current: false, off: null, note: null },
    ])
    expect(choices('harness').find((one) => one.id === 'codex')?.off).toBe('not ready')
  })

  it('draws what stays at the machine off, with why, and never as a press', () => {
    const items = awayMenuOf(running(), EXTRAS)
    const editor = items.find((one) => one.id === 'editor')
    expect(editor?.act).toEqual({ kind: 'here' })
    expect(editor?.off).toContain('machine')
    const changes = items.find((one) => one.id === 'changes')
    expect(changes?.act).toEqual({ kind: 'here' })
    expect(changes?.off).not.toBeNull()
  })

  it('keeps the window’s own reasons on a stopped agent: no stop, no model, no thinking', () => {
    const stopped = menuItems({ lane: null, state: 'failed' }, 0, null, [])
    const items = awayMenuOf(stopped, { ...EXTRAS, running: false, models: null })
    const off = Object.fromEntries(items.map((one) => [one.id, one.off]))
    expect(off.start).toBeNull()
    expect(off.stop).toBe('not running')
    expect(off.model).toBe('not running')
    expect(off.thinking).toBe('not running')
  })

  it('carries queued work’s own menu through the queue’s choices', () => {
    const items = awayMenuOf(queueMenuItems({ state: { kind: 'paused' } }), EXTRAS)
    const acts = Object.fromEntries(items.map((one) => [one.id, one.act]))
    expect(acts['queue-start']).toEqual({ kind: 'verb', verb: 'queue', with: { change: 'start' } })
    expect(acts['queue-resume']).toEqual({
      kind: 'verb',
      verb: 'queue',
      with: { change: 'resume' },
    })
    expect(acts['queue-remove']).toEqual({ kind: 'verb', verb: 'remove' })
    expect(acts['queue-after']).toEqual({ kind: 'here' })
  })
})

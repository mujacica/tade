import { describe, expect, it } from 'vitest'
import { awayMenuOf, type MenuExtras } from '../src/away-menu.ts'
import { menuItems, queueMenuItems } from '../src/panels/menu/state.ts'

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
  accounts: [
    { id: '', label: '● its own sign-in', note: 'now' },
    { id: 'work', label: '  work' },
  ],
}

/** A running agent's window menu, with one machine it can be handed to. */
function running() {
  return menuItems({ lane: 'app/one/agent', state: 'working' }, 3, null, [
    { id: 'hand:vps', label: 'Hand to vps' },
  ])
}

describe('an agent’s menu, from away', () => {
  it('carries every item of the window’s menu, in its order', () => {
    const items = awayMenuOf(running(), EXTRAS)
    expect(items.map((one) => one.id)).toEqual(running().map((one) => one.id))
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
    expect(acts.model).toMatchObject({ kind: 'choose', verb: 'model' })
    expect(acts.account).toMatchObject({ kind: 'choose', verb: 'account' })
    // Handing work to another machine is the window's, at the machine.
    expect(acts['hand:vps']).toEqual({ kind: 'here' })
  })

  it('marks the one each list is on as a field, and keeps the window’s word for one it cannot take', () => {
    const items = awayMenuOf(running(), EXTRAS)
    const choices = (id: string) => {
      const act = items.find((one) => one.id === id)?.act
      return act?.kind === 'choose' ? act.choices : []
    }
    expect(choices('model').find((one) => one.current)?.id).toBe('anthropic/claude-opus-5')
    expect(choices('account')).toEqual([
      { id: '', label: 'its own sign-in', current: true, off: null, note: null },
      { id: 'work', label: 'work', current: false, off: null, note: null },
    ])
  })

  it('draws what stays at the machine off, with why, and never as a press', () => {
    const items = awayMenuOf(running(), EXTRAS)
    const editor = items.find((one) => one.id === 'editor')
    expect(editor?.act).toEqual({ kind: 'here' })
    expect(editor?.off).toContain('machine')
  })

  it('opens an agent’s changes as its own screen, off with the window’s word while it has none', () => {
    const changes = awayMenuOf(running(), EXTRAS).find((one) => one.id === 'changes')
    expect(changes?.act).toEqual({ kind: 'page', does: 'changes' })
    const some = menuItems({ lane: 'demo/fix/agent', state: 'working' }, 3, null, [])
    const three = awayMenuOf(some, EXTRAS).find((one) => one.id === 'changes')
    expect(three?.off).toBeNull()
    expect(three?.note).toBe('3 files')
    const none = menuItems({ lane: 'demo/fix/agent', state: 'working' }, 0, null, [])
    expect(awayMenuOf(none, EXTRAS).find((one) => one.id === 'changes')?.off).toBe('none yet')
  })

  it('keeps the window’s own reasons on a stopped agent: no stop, no model', () => {
    const stopped = menuItems({ lane: null, state: 'failed' }, 0, null, [])
    const items = awayMenuOf(stopped, { ...EXTRAS, running: false, models: null })
    const off = Object.fromEntries(items.map((one) => [one.id, one.off]))
    expect(off.start).toBeNull()
    expect(off.stop).toBe('not running')
    expect(off.model).toBe('not running')
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

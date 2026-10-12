import { describe, expect, it } from 'vitest'
import { type AppState, initialState } from '../../src/model.ts'
import { menuPanel } from '../../src/panels/menu/state.ts'
import { Router } from '../../src/wire/actions.ts'
import type { Actions, Menus } from '../../src/wire/context.ts'

// A press is answered before what it asked for has: the control it pressed is
// held down until its action has, and let go by nothing else.

/** A router over one subject whose slow actions each wait until they are finished, in turn. */
function routed() {
  let state: AppState = initialState()
  let drawn = 0
  const running: { resolve: () => void; reject: (err: Error) => void }[] = []
  const slow = () =>
    new Promise<void>((resolve, reject) => {
      running.push({ resolve, reject })
    })
  const actions: Actions = { slow, quick: () => {}, other: slow }
  const menus: Menus = {
    'bottom-new': { title: () => 'Open below', items: () => [], choose: slow },
  }
  const wire = {
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    draw: () => {
      drawn++
    },
  }
  const router = new Router(
    wire as never,
    {
      subjects: () => [{ actions: () => actions, menus: () => menus }],
    } as never,
  )
  return {
    router,
    state: () => state,
    drawn: () => drawn,
    /** Let the `nth` slow action pressed finish: the first, unless told. */
    finish: (nth = 0) => running[nth]?.resolve(),
    fail: () => running[0]?.reject(new Error('the shell did not start')),
  }
}

describe('a control whose action has not answered', () => {
  it('is held down until it has, and let go after', async () => {
    const world = routed()
    const running = world.router.run('slow')
    expect(world.state().busy).toEqual({ kind: 'action', name: 'slow' })
    world.finish()
    await running
    expect(world.state().busy).toBeNull()
  })

  it('is let go when the action threw, too', async () => {
    const world = routed()
    const running = world.router.run('slow')
    world.fail()
    await expect(running).rejects.toThrow('the shell did not start')
    expect(world.state().busy).toBeNull()
  })

  it('is never held, nor drawn, for an action that finished as it was pressed', async () => {
    const world = routed()
    await world.router.run('quick')
    expect(world.state().busy).toBeNull()
    expect(world.drawn()).toBe(0)
  })

  it('leaves a later press held down when an earlier one answers', async () => {
    const world = routed()
    const first = world.router.run('slow')
    const second = world.router.run('other')
    expect(world.state().busy).toEqual({ kind: 'action', name: 'other' })
    world.finish(0)
    await first
    expect(world.state().busy).toEqual({ kind: 'action', name: 'other' })
    world.finish(1)
    await second
    expect(world.state().busy).toBeNull()
  })

  it('holds down the control that opened a menu while what was chosen from it runs', async () => {
    const world = routed()
    const running = world.router.submitPanel(menuPanel({ kind: 'bottom-new' }, 'Open below', null))
    expect(world.state().busy).toEqual({ kind: 'menu', subject: { kind: 'bottom-new' } })
    world.finish()
    await running
    expect(world.state().busy).toBeNull()
  })
})

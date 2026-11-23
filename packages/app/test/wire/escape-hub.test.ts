import type { Held } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { type Machine, NO_DETAIL, type RemoteTalk } from '../../src/machines.ts'
import { escapeMeans, initialState, withTranscript } from '../../src/model.ts'
import { thinking } from '../../src/transcript.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { RemoteTalks } from '../../src/wire/remote-talk.ts'

// Escape on this machine's own line, while the turn of its one conversation
// runs on the hub: a turn runs where its input arrived, so the one in flight
// is the hub's, and escape stops it there through the hub's own door — said in
// the strip. Not where the hub keeps a conversation of its own, and not over a
// turn running here, which is this machine's orchestrator's to stop.

const NOW = Date.UTC(2026, 10, 23, 9, 0)

function talk(busy: boolean): RemoteTalk {
  return { lines: [], rev: busy ? 'b1' : 'b0', busy, whose: null, mine: false, more: 0 }
}

/** A window linked to vps, the hub, with `one` saying whether its own conversation is one with it. */
function hubWindow(one: string | null, stop: { status: number; body: unknown } = ok()) {
  let vps: Machine = {
    name: 'vps',
    link: 'live',
    rev: 3,
    said: null,
    asOf: NOW,
    heard: true,
    closed: false,
    seen: [],
    projects: [],
    spend: null,
    talk: talk(false),
    detail: NO_DETAIL,
  }
  let state = initialState()
  const wire = {
    get state() {
      return state
    },
    put: (next: typeof state) => {
      state = next
    },
    now: () => NOW,
    draw: () => {},
  } as unknown as Wiring
  const asked: Array<{ path: string; body: unknown }> = []
  const talks = new RemoteTalks(wire, {
    reach: () => ({
      link: {
        request: async (_name: string, path: string, body: unknown) => {
          asked.push({ path, body })
          // An older Tade there has no card to give: nothing is said about it.
          if (path === '/api/since') return { status: 404, body: {} }
          return stop
        },
      } as never,
      remote: { session: { device: 'a1' } } as never,
      live: true,
    }),
    machines: () => ({ here: 'this Mac', remotes: [vps] }),
    skew: () => 0,
    oneWith: () => one,
  })
  const held = { remote: 'vps', link: { kind: 'live', since: NOW }, heardAt: NOW } as Held
  /** vps's orchestrator on a turn, or not, as its link says. */
  const busy = (now: boolean) => {
    vps = { ...vps, talk: talk(now) }
    talks.moved('vps', held)
  }
  const stops = () => asked.filter((one) => one.path === '/api/ask/stop')
  return {
    talks,
    busy,
    stops,
    state: () => state,
    put: (next: typeof state) => {
      state = next
    },
  }
}

function ok() {
  return { status: 200, body: { did: true } }
}

/** Until the stop's answer is in: it is sent without anybody waiting on it. */
async function settled(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('escape on this machine’s own line, with the turn on the hub', () => {
  it('stops the hub’s turn there, and says so in the strip', async () => {
    const hub = hubWindow('vps')
    hub.busy(true)
    expect(hub.state().turnThere).toBe('vps')
    // On the orchestrator's own line, with what is typed kept: escape stops, never clears.
    const line = { ...hub.state(), dictation: 'half a thought' }
    expect(escapeMeans(line)).toBe('interrupt')
    expect(hub.talks.interrupt()).toBe(true)
    await settled()
    expect(hub.stops()).toHaveLength(1)
    expect(hub.stops()[0]?.body).toMatchObject({ was: 'b1', rev: 3 })
    expect(hub.state().notice).toBe("stopped the orchestrator's turn on vps")

    // Its turn over, there is nothing there for escape to stop.
    hub.busy(false)
    expect(hub.state().turnThere).toBeNull()
    expect(escapeMeans({ ...hub.state(), dictation: 'half a thought' })).toBe('nothing')
    expect(hub.talks.interrupt()).toBe(false)
  })

  it('says in the strip why the hub would not stop it', async () => {
    const hub = hubWindow('vps', { status: 409, body: { error: 'moved', said: 'it moved on' } })
    hub.busy(true)
    expect(hub.talks.interrupt()).toBe(true)
    await settled()
    expect(hub.stops()).toHaveLength(1)
    expect(hub.state().notice).toContain('it moved on')
  })

  it('leaves a hub that keeps a conversation of its own alone', () => {
    const hub = hubWindow(null)
    hub.busy(true)
    expect(hub.state().talkBusy).toEqual(['vps'])
    expect(hub.state().turnThere).toBeNull()
    expect(escapeMeans({ ...hub.state(), dictation: 'half a thought' })).toBe('nothing')
    expect(hub.talks.interrupt()).toBe(false)
    expect(hub.stops()).toEqual([])
  })

  it('leaves a turn running here to this machine’s orchestrator', () => {
    const hub = hubWindow('vps')
    hub.busy(true)
    hub.put(withTranscript(hub.state(), thinking(hub.state().transcript, NOW)))
    expect(escapeMeans(hub.state())).toBe('interrupt')
    expect(hub.talks.interrupt()).toBe(false)
    expect(hub.stops()).toEqual([])
  })
})

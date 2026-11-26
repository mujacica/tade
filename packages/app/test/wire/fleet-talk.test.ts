import { describe, expect, it } from 'vitest'
import {
  type Machine,
  NO_DETAIL,
  type RemoteLine,
  type RemoteTalk,
  talkIn,
} from '../../src/machines.ts'
import { initialState } from '../../src/model.ts'
import { talkTab } from '../../src/talk-tab.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { FleetTalk, type TalkThere } from '../../src/wire/fleet-talk.ts'
import { RemoteTalks } from '../../src/wire/remote-talk.ts'

// One orchestrator strip on every machine: the hub's turns folded into this
// window's own conversation as they run there (`fleet-talk.ts`), and the hub's
// own tab gone, because its turns are this strip's (`RemoteTalks.facts`). A
// machine that keeps a conversation of its own keeps its tab.

const NOW = Date.UTC(2026, 10, 26, 9, 0)

function wiring() {
  let state = initialState()
  let puts = 0
  let draws = 0
  const wire = {
    get state() {
      return state
    },
    put: (next: typeof state) => {
      puts += 1
      state = next
    },
    now: () => NOW,
    openedAt: NOW - 60_000,
    draw: () => {
      draws += 1
    },
  } as unknown as Wiring
  return { wire, state: () => state, puts: () => puts, draws: () => draws }
}

function line(id: string, kind: RemoteLine['kind'], text: string, at: number): RemoteLine {
  return {
    id,
    at,
    kind,
    from: kind === 'asked' ? 'you' : null,
    text,
    tool: null,
    outcome: null,
    streaming: false,
    there: null,
    read: false,
    call: null,
  }
}

function vps(lines: readonly RemoteLine[] = []): Machine {
  const talk: RemoteTalk = { lines, rev: 'b0', busy: false, whose: null, mine: true, more: 0 }
  return {
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
    talk,
    detail: NO_DETAIL,
  }
}

describe('the hub’s turns, in this window’s one strip', () => {
  it('folds them in as they arrive, draws once for what moved, and nothing for a beat that moved nothing', () => {
    const w = wiring()
    let sources: TalkThere[] = []
    const fleet = new FleetTalk(w.wire, { sources: () => sources })
    fleet.fold()
    expect(w.puts()).toBe(0)
    const lines = [
      line('a', 'asked', 'what is green on vps?', NOW - 2_000),
      line('b', 'reply', 'All of it.', NOW - 1_000),
    ]
    sources = [{ machine: 'vps', lines, own: null }]
    fleet.fold()
    expect(w.puts()).toBe(1)
    expect(w.draws()).toBe(1)
    expect(w.state().transcript.entries.map((entry) => entry.there?.machine)).toEqual([
      'vps',
      'vps',
    ])
    // The same lines: nothing to do.
    fleet.fold()
    expect(w.puts()).toBe(1)
    // What was said there before this window opened is this machine's record to draw.
    sources = [{ machine: 'vps', lines: [line('c', 'reply', 'old', NOW - 120_000)], own: null }]
    fleet.fold()
    expect(w.state().transcript.entries).toHaveLength(2)
  })
})

describe('the hub’s tab', () => {
  function talks(shared: string | null) {
    const w = wiring()
    const talks = new RemoteTalks(w.wire, {
      reach: () => null,
      machines: () => ({ here: 'this Mac', remotes: [vps()] }),
      skew: () => 0,
      sharesWith: () => shared,
    })
    return { w, talks }
  }

  it('folds into the one strip where the conversation is one with it, and the line goes back to this orchestrator', () => {
    const { w, talks: one } = talks('vps')
    w.wire.put({ ...w.state(), bottom: talkTab('vps') })
    const facts = one.facts()
    expect(facts.talkTabs ?? []).toEqual([])
    expect(w.state().bottom).not.toBe(talkTab('vps'))
  })

  it('stays where that machine keeps a conversation of its own', () => {
    const { talks: apart } = talks(null)
    expect(apart.facts().talkTabs?.map((tab) => tab.tab)).toEqual([talkTab('vps')])
  })
})

describe('another machine’s conversation, as its projection carries it', () => {
  it('reads where each line came from there, and a call’s id in the record', () => {
    const talk = talkIn(
      {
        you: { talk: { rev: 'b0', busy: false } },
        chat: [
          {
            id: 'a',
            at: new Date(NOW).toISOString(),
            kind: 'asked',
            from: 'you',
            text: { words: 'folded there from the Mac' },
            there: 'mac',
          },
          {
            id: 'b',
            at: new Date(NOW + 1).toISOString(),
            kind: 'tool',
            tool: 'tade_status',
            outcome: 'unknown',
            call: { id: 'toolu_1' },
            read: true,
          },
          {
            id: 'c',
            at: new Date(NOW + 2).toISOString(),
            kind: 'own',
            text: { words: 'started it' },
          },
        ],
      },
      0,
    )
    expect(
      talk?.lines.map((one) => [one.kind, one.there, one.read, one.call, one.outcome]),
    ).toEqual([
      ['asked', 'mac', false, null, null],
      ['tool', null, true, 'toolu_1', 'unknown'],
      ['own', null, false, null, null],
    ])
  })
})

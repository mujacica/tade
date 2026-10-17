import { type Held, heldFor } from '@tade/remotes-core'
import type { Snapshot } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { machinesSaid } from '../src/inbox.ts'
import { type Machine, type Machines, machineOf, missedOf } from '../src/machines.ts'
import { escapeMeans, initialState, ORCHESTRATOR_TAB, withTerminals } from '../src/model.ts'
import {
  isTalkTab,
  missedLines,
  showTalk,
  talkingTo,
  talkSays,
  talkTab,
  talkTabsOf,
  talkTranscript,
} from '../src/talk-tab.ts'
import { NOW } from './screens/scenarios/fixtures.ts'

// Another machine's orchestrator, as this window reads and draws it
// (`talk-tab.ts`, `machines.ts`): its conversation out of its projection —
// text and nothing else, whatever it wrote — a tab per machine wearing what it
// is doing, a line saying where a message typed there stands, the card its
// link brings back, and the one line the orchestrator here is told about
// every machine with every message.

const ESCAPES = '\x1b]0;pwned\x07\x1b[2J\x1b[31mfix the build\x1b[0m‮\x07'
const OWN = 'device a1b2c3d4e5f60718'

/** A projection with a conversation, as a remote might send one: anything in it. */
function projection(over: Record<string, unknown> = {}): Snapshot {
  return {
    v: 1,
    fresh: { at: new Date(NOW).toISOString(), epoch: 'e1', rev: 9 },
    pages: { chat: { total: 4, omitted: 2 } },
    projects: [],
    tasks: [],
    you: {
      device: 'a1b2c3d4e5f60718',
      reads: [],
      talk: { rev: 'b0', busy: false, whose: null, mine: true },
    },
    chat: [
      {
        id: 'l0002',
        at: new Date(NOW - 60_000).toISOString(),
        kind: 'reply',
        from: null,
        text: { words: `first line ${ESCAPES}\nsecond line`, more: false },
        tool: null,
        outcome: null,
        streaming: false,
      },
      {
        id: 'l0001',
        at: new Date(NOW - 120_000).toISOString(),
        kind: 'asked',
        from: OWN,
        text: { words: 'what is running?', more: false },
        tool: null,
        outcome: null,
        streaming: false,
      },
      { id: 'l0003', at: 'never', kind: 'shell', text: { words: 'not a line' } },
      {
        id: 'l0004',
        at: new Date(NOW - 30_000).toISOString(),
        kind: 'tool',
        from: null,
        text: null,
        tool: `tade_status${ESCAPES}`,
        outcome: 'failed',
        streaming: false,
      },
    ],
    ...over,
  } as unknown as Snapshot
}

function held(over: Partial<Held> = {}, snapshot: Snapshot | null = projection()): Held {
  return {
    ...heldFor('vps'),
    link: { kind: 'live', since: NOW - 60_000 },
    projection: snapshot,
    heardAt: NOW,
    ...over,
  }
}

const vps = (over: Partial<Machine> = {}): Machine => ({ ...machineOf(held(), 0), ...over })

describe('its conversation, read out of its projection', () => {
  it('is text a line at a time, its paragraphs kept, oldest first, and a line of no known kind left out', () => {
    const talk = machineOf(held(), 0).talk
    expect(talk?.lines.map((line) => [line.id, line.kind])).toEqual([
      ['l0001', 'asked'],
      ['l0002', 'reply'],
      ['l0004', 'tool'],
    ])
    const reply = talk?.lines[1]?.text ?? ''
    expect(reply).toBe('first line ␛fix the build␛\nsecond line')
    expect(talk?.lines[2]?.tool).toBe('tade_status␛fix the build␛')
    expect(talk).toMatchObject({ rev: 'b0', busy: false, whose: null, mine: true, more: 2 })
  })

  it('is nothing where talking from another screen is off there, which is not an empty one', () => {
    const off = projection({ you: { device: 'x', reads: [], talk: null } })
    expect(machineOf(held({}, off), 0).talk).toBeNull()
    expect(machineOf(held({}, null), 0).talk).toBeNull()
  })

  it('is drawn as a conversation: this machine’s words as the person’s, anybody else’s as theirs', () => {
    const talk = machineOf(held(), 0).talk
    const busy = talk === null ? null : { ...talk, busy: true }
    const transcript = talkTranscript(busy, OWN, [
      { kind: 'problem', text: 'vps refused it', at: NOW - 90_000 },
    ])
    expect(transcript.entries.map((entry) => entry.kind)).toEqual([
      'you',
      'problem',
      'said',
      'tool',
    ])
    expect(transcript.entries[0]).toMatchObject({ kind: 'you', from: 'you' })
    // A turn in flight there is a turn on its tab.
    expect(transcript.thinking).toBe(NOW - 120_000)
    const phone = talkTranscript(
      talk === null
        ? null
        : { ...talk, lines: talk.lines.map((one) => ({ ...one, from: 'device ffff' })) },
      OWN,
      [],
    )
    expect(phone.entries[0]).toMatchObject({ kind: 'you', from: 'device ffff' })
  })
})

describe('its tab', () => {
  it('is the machine’s name, wearing what it is doing', () => {
    const machines = (machine: Machine): Machines => ({ here: 'this Mac', remotes: [machine] })
    expect(talkTabsOf(machines(vps()), [], NOW)).toEqual([{ tab: 'talk:vps', label: 'vps' }])
    expect(talkTabsOf(machines(vps()), ['vps'], NOW)[0]?.label).toBe('vps •')
    const busy = vps({
      talk: {
        ...(vps().talk ?? { lines: [], rev: null, whose: null, mine: true, more: 0 }),
        busy: true,
      },
    })
    expect(talkTabsOf(machines(busy), ['vps'], NOW)[0]?.label).toMatch(/^vps [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/)
    expect(talkTabsOf(machines(vps({ link: 'down' })), [], NOW)[0]?.label).toBe('○ vps')
    expect(talkTabsOf(undefined, [], NOW)).toEqual([])
  })

  it('is in front with the line open, and survives the terminals moving under it', () => {
    const state = showTalk(initialState(), talkTab('vps'))
    expect(talkingTo(state)).toBe('vps')
    expect(state.dictation).toBe('')
    expect(isTalkTab(ORCHESTRATOR_TAB)).toBe(false)
    expect(withTerminals(state, []).bottom).toBe('talk:vps')
  })

  it('stops what is thinking on it, and never this machine’s turn from there', () => {
    const state = showTalk(initialState(), talkTab('vps'))
    expect(escapeMeans({ ...state, dictation: 'half a thought', talkBusy: ['vps'] })).toBe(
      'interrupt',
    )
    expect(escapeMeans({ ...state, dictation: 'half a thought', talkBusy: ['lab'] })).toBe(
      'nothing',
    )
    expect(escapeMeans({ ...state, dictation: '', talkBusy: [] })).toBe('leave')
  })

  it('says where a message typed on it stands, every way it can', () => {
    const said = (machine: Machine, sending = false) => talkSays(machine, OWN, sending).said
    expect(said(vps())).toBe('what you type here goes to the orchestrator on vps')
    expect(said(vps(), true)).toBe('sending to vps…')
    expect(said(vps({ link: 'down' }))).toContain('vps is not linked')
    expect(said(vps({ talk: null }))).toContain('surfaces.web.orchestrator')
    expect(said(vps({ talk: null, heard: false }))).toBe('nothing heard from vps yet')
    const talk = vps().talk
    if (talk === null) throw new Error('no conversation')
    expect(said(vps({ talk: { ...talk, mine: false } }))).toContain('(ask)')
    expect(said(vps({ talk: { ...talk, busy: true, whose: OWN } }))).toBe(
      "vps's orchestrator is answering you · esc stops it",
    )
    expect(said(vps({ talk: { ...talk, busy: true, whose: 'device ffff' } }))).toContain(
      'answering device ffff',
    )
  })
})

describe('what was missed there', () => {
  const answer = {
    since: new Date(NOW - 3 * 3_600_000).toISOString(),
    finished: {
      rows: [
        {
          task: 'tade/fix-login',
          at: new Date(NOW - 3_600_000).toISOString(),
          said: `its agent said so${ESCAPES}`,
        },
      ],
      more: 2,
    },
    waiting: {
      rows: [
        {
          task: 'tade/deploy',
          at: new Date(NOW).toISOString(),
          said: 'wants an answer about Bash',
        },
      ],
      more: 0,
    },
    documents: { rows: [], more: 0 },
    held: { rows: [], more: 0 },
    proposed: { rows: [{ task: `tade/red${ESCAPES}`, at: 'never', said: 'main is red' }], more: 0 },
    spend: { usd: 3.2, tokens: 1_200_000, hasCost: true },
  }

  it('is read as text, its moments moved into this clock', () => {
    const missed = missedOf('vps', answer, 5_000)
    expect(missed?.since).toBe(NOW - 3 * 3_600_000 + 5_000)
    expect(missed?.finished.rows[0]).toEqual({
      task: 'tade/fix-login',
      at: NOW - 3_600_000 + 5_000,
      said: 'its agent said so␛fix the build␛',
    })
    expect(missed?.proposed.rows[0]).toMatchObject({ task: 'tade/red␛fix the build␛', at: null })
  })

  it('is nothing where there is nothing to catch up on, or no answer at all', () => {
    expect(missedOf('vps', { ...answer, since: null }, 0)).toBeNull()
    const none = { rows: [], more: 0 }
    const empty = { ...answer, finished: none, waiting: none, proposed: none, spend: null }
    expect(missedOf('vps', empty, 0)).toBeNull()
    expect(missedOf('vps', 'not a card', 0)).toBeNull()
  })

  it('is drawn a list a line, what waits on the person first, and only what has something in it', () => {
    const missed = missedOf('vps', answer, 0)
    if (missed === null) throw new Error('no card')
    expect(missedLines(missed, () => '14:02')).toEqual([
      'Since you were here at 14:02 — on vps:',
      '  waiting on you: tade/deploy wants an answer about Bash',
      '  finished: tade/fix-login — its agent said so␛fix the build␛ · 2 more',
      '  put to its orchestrator: tade/red␛fix the build␛ — main is red',
      '  spent: $3.20 over 1.2M tok',
    ])
  })
})

describe('what the orchestrator here is told of every machine, with every message', () => {
  const agent = (mark: string, queued = false) => ({
    id: `tade/${mark}`,
    name: mark,
    title: null,
    mark,
    counts: mark,
    queued,
    reason: '',
    movedAt: null,
    rev: null,
    approval: null,
    parked: false,
    lane: 'running',
    can: [],
  })
  const busy = (over: Partial<Machine> = {}): Machine =>
    vps({
      projects: [
        {
          name: 'tade',
          title: null,
          more: 0,
          agents: [agent('working'), agent('working'), agent('working'), agent('needs-you')],
        },
      ] as unknown as Machine['projects'],
      ...over,
    })

  it('is one line, as each machine last said', () => {
    const lab = vps({ name: 'lab', projects: [] })
    expect(machinesSaid({ here: 'this Mac', remotes: [busy(), lab] }, () => '14:02')).toBe(
      'Other machines, as each last said: vps: 3 working, 1 wants you; lab: nothing running.',
    )
  })

  it('says a machine that is down as down, as of when, and never as nothing running', () => {
    expect(
      machinesSaid(
        { here: 'this Mac', remotes: [busy({ link: 'down', asOf: NOW })] },
        () => '13:52',
      ),
    ).toBe(
      'Other machines, as each last said: vps: not linked since 13:52 — then, 3 working, 1 wants you.',
    )
    expect(machinesSaid({ here: 'this Mac', remotes: [busy({ link: 'ended' })] }, () => '')).toBe(
      'Other machines, as each last said: vps: signed this machine out.',
    )
    expect(machinesSaid({ here: 'this Mac', remotes: [busy({ heard: false })] }, () => '')).toBe(
      'Other machines, as each last said: vps: not heard from yet.',
    )
    expect(machinesSaid({ here: 'this Mac', remotes: [] }, () => '')).toBeNull()
    expect(machinesSaid(undefined, () => '')).toBeNull()
  })
})

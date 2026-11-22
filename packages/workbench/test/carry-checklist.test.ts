import { CARRY_SCHEMA, type CarryLeaf, stampText } from '@tade/core'
import type { CarryAnswer } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import {
  carryBodies,
  checklistLines,
  checklistOf,
  leftToDo,
  type Setup,
  takeBack,
  WINDOW_TAKES,
} from '../src/carry.ts'

// What a remote said it reads only when its Tade next starts, and whether its
// tab here takes a message, in the checklist `tade remote add` ends with and
// Settings › Remotes draws (`checklistOf`) — and what comes back newer there,
// settled here the way that machine settled what it was sent (`takeBack`).

/** A setup of these preferences, none of them with a line about when. */
function setupOf(kept: CarryLeaf[], more: Partial<Setup> = {}): Setup {
  return {
    kept,
    registers: new Map(
      kept.map((one) => [one.path, { value: one.value, stamp: null, over: null, by: null }]),
    ),
    changes: [],
    pinned: [],
    pressed: [
      { path: 'telemetry.dsn', value: 'https://a@o1.example/2', carry: 'pressed', because: '' },
    ],
    here: [],
    files: [],
    secrets: new Set(),
    ...more,
  }
}

const setup = setupOf([
  { path: 'notes.keep_days', value: 9, carry: 'kept', because: '' },
  { path: 'agents.commit', value: 'as-you-go', carry: 'kept', because: '' },
  { path: 'queue.holds', value: 'ask', carry: 'kept', because: '' },
])

const listOf = (settings: CarryAnswer['settings'], talk?: CarryAnswer['talk']) =>
  checklistOf({
    remote: 'vps',
    setup,
    answer: {
      schema: CARRY_SCHEMA,
      machine: 'box-1',
      settings,
      files: [],
      signIns: [],
      ...(talk === undefined ? {} : { talk }),
    },
    unreached: null,
    inUse: new Set(),
    now: 0,
  })

const how = { address: 'me@vps', tade: 'tade' }

describe('what applies only when Tade next starts there', () => {
  it('is said of what is there, a key a press sent included, with the remote named', () => {
    const list = listOf([
      { path: 'notes.keep_days', outcome: 'same', nextStart: true },
      { path: 'agents.commit', outcome: 'written' },
      { path: 'telemetry.dsn', outcome: 'written', nextStart: true },
      // Newer there, so never said to apply there, whatever came back.
      { path: 'queue.holds', outcome: 'newer', value: 'orchestrator', nextStart: true },
    ])
    expect(list.nextStart).toEqual(['notes.keep_days', 'telemetry.dsn'])
    expect(list.carried).toEqual(['notes.keep_days', 'agents.commit'])
    expect(list.sent).toEqual(['telemetry.dsn'])
    expect(checklistLines(list, how)).toContain(
      'applies when Tade next starts on vps: notes.keep_days, telemetry.dsn',
    )
  })

  it('says nothing of it where the remote did not, as an older Tade does not', () => {
    const list = listOf([{ path: 'notes.keep_days', outcome: 'written' }])
    expect(list.nextStart).toEqual([])
    expect(checklistLines(list, how).join('\n')).not.toContain('next starts')
  })
})

describe('talking to Tade from here, on that machine', () => {
  it('is listed while it is off there, with the press that turns it on, until it is on', () => {
    const off = listOf([], 'off')
    expect(off.talk).toBe('off')
    expect(leftToDo(off)).toBe(true)
    expect(checklistLines(off, how)).toEqual(
      expect.arrayContaining([
        'talking to Tade from here is off on vps, so its tab here takes no message',
        '  `tade remote carry vps --talk`, or Settings › Remotes — it says what that means first',
      ]),
    )
    const turning = listOf([], 'turning on')
    expect(leftToDo(turning)).toBe(false)
    expect(checklistLines(turning, how).join('\n')).toContain('is turned on on vps, on your press')
    for (const list of [listOf([], 'on'), listOf([])]) {
      expect(leftToDo(list)).toBe(false)
      expect(checklistLines(list, how).join('\n')).not.toContain('talking to Tade')
    }
    // Where it could not be reached, nothing is said about it either way.
    expect(
      checklistOf({
        remote: 'vps',
        setup,
        answer: null,
        unreached: 'down',
        inUse: new Set(),
        now: 0,
      }).talk,
    ).toBeNull()
  })

  it('is pressed in the last body, after which that machine builds its listener again', () => {
    const files = Array.from({ length: 3 }, (_, at) => ({
      kind: 'persona' as const,
      name: `p${at}`,
      text: 'x'.repeat(30_000),
    }))
    const bodies = carryBodies({ ...setup, files }, { from: 'mac', keys: false, talk: true })
    expect(bodies.length).toBeGreaterThan(2)
    expect(bodies.map((one) => one.talk === true)).toEqual(
      bodies.map((_, at) => at === bodies.length - 1),
    )
    expect(carryBodies(setup, { from: 'mac', keys: false }).some((one) => one.talk)).toBe(false)
  })
})

describe('what comes back newer', () => {
  const at = (wall: number, machine: string) => ({ wall, count: 0, machine })
  const answer = (settings: CarryAnswer['settings']): CarryAnswer => ({
    schema: CARRY_SCHEMA,
    machine: 'vps',
    settings,
    files: [],
    signIns: [],
  })
  const mine = setupOf([{ path: 'queue.holds', value: 'ask', carry: 'kept', because: '' }], {
    registers: new Map([
      ['queue.holds', { value: 'ask', stamp: at(2_000, 'mac'), over: null, by: 'window' }],
    ]),
    pinned: ['checks'],
  })

  it('is taken where it is later, or where this machine has nothing, with the stamp it came with', () => {
    const back = takeBack(
      mine,
      answer([
        {
          path: 'queue.holds',
          outcome: 'newer',
          value: 'orchestrator',
          hlc: stampText(at(5_000, 'vps')),
          by: 'window',
        },
        { path: 'notes.keep_days', outcome: 'newer', value: 9, hlc: stampText(at(1_000, 'vps')) },
        // Earlier than this machine's, offered back all the same: this one stands.
        { path: 'agents.commit', outcome: 'newer', value: 'never', hlc: stampText(at(1, 'vps')) },
      ]),
      'mac',
    )
    expect(back.writes).toEqual([
      {
        path: 'queue.holds',
        value: 'orchestrator',
        stamp: { hlc: stampText(at(5_000, 'vps')), origin: 'window' },
      },
      { path: 'notes.keep_days', value: 9, stamp: { hlc: stampText(at(1_000, 'vps')) } },
      { path: 'agents.commit', value: 'never', stamp: { hlc: stampText(at(1, 'vps')) } },
    ])
    // Made over nothing this machine wrote: both changed it apart.
    expect(back.conflicts).toEqual([
      {
        path: 'queue.holds',
        kept: { value: 'orchestrator', machine: 'vps', at: at(5_000, 'vps') },
        lost: { value: 'ask', machine: 'mac', at: at(2_000, 'mac') },
      },
    ])
  })

  it('never takes a key, this machine’s own, a pinned one, or what widens agents unless the person did', () => {
    const back = takeBack(
      mine,
      answer([
        {
          path: 'extensions.jev.key',
          outcome: 'newer',
          value: 'jev_x',
          hlc: stampText(at(9, 'v')),
        },
        { path: 'workspace.driver', outcome: 'newer', value: 'tmux', hlc: stampText(at(9, 'v')) },
        { path: 'checks.before', outcome: 'newer', value: 'push', hlc: stampText(at(9, 'v')) },
        {
          path: 'approvals.mode',
          outcome: 'newer',
          value: 'auto',
          hlc: stampText(at(9, 'v')),
          by: 'orchestrator',
        },
        {
          path: 'extensions.sentry.enabled',
          outcome: 'newer',
          value: true,
          hlc: stampText(at(9, 'v')),
          by: 'device 7f3a',
        },
      ]),
      'mac',
    )
    expect(back.writes.map((one) => one.path)).toEqual(['extensions.sentry.enabled'])
    expect(back.landed).toEqual([
      { path: 'extensions.sentry.enabled', now: 'true', by: 'device 7f3a' },
    ])
    expect(back.refused).toEqual([
      { what: 'approvals.mode', why: expect.stringMatching(/on vps its orchestrator changed it/) },
    ])
  })

  it('is listed as waiting for the window where a shell carried, and as taken where the window did', () => {
    const came = answer([
      { path: 'notes.keep_days', outcome: 'newer', value: 9, hlc: stampText(at(1_000, 'vps')) },
    ])
    const base = {
      remote: 'vps',
      setup: mine,
      answer: came,
      unreached: null,
      inUse: new Set<string>(),
      now: 0,
    }
    const shell = checklistOf(base)
    expect(shell.newer).toEqual([{ what: 'notes.keep_days', why: WINDOW_TAKES }])
    expect(leftToDo(shell)).toBe(false)
    expect(checklistLines(shell, how)).toContain(`  notes.keep_days: ${WINDOW_TAKES}`)
    const window = checklistOf({ ...base, took: { taken: ['notes.keep_days'], failed: [] } })
    expect(window.taken).toEqual(['notes.keep_days'])
    expect(window.newer).toEqual([])
    expect(window.pinned).toEqual([{ what: 'checks', where: 'here' }])
    expect(checklistLines(window, how)).toEqual(
      expect.arrayContaining([
        '  newer there, taken here: notes.keep_days',
        '  kept to this machine, neither sent nor taken: checks',
      ]),
    )
  })

  it('sends every kept setting with its stamp and the schema, and what it pinned never', () => {
    const [body] = carryBodies(mine, { from: 'mac', keys: false })
    expect(body?.schema).toBe(CARRY_SCHEMA)
    expect(body?.settings).toEqual([
      { path: 'queue.holds', value: 'ask', hlc: stampText(at(2_000, 'mac')), by: 'window' },
      { path: 'telemetry.dsn', digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ])
  })
})

import type { CarryAnswer } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { carryBodies, checklistLines, checklistOf, leftToDo, type Setup } from '../src/carry.ts'

// What a remote said it reads only when its Tade next starts, and whether its
// tab here takes a message, in the checklist `tade remote add` ends with and
// Settings › Remotes draws (`checklistOf`).

const setup: Setup = {
  kept: [
    { path: 'notes.keep_days', value: 9, carry: 'kept', because: '' },
    { path: 'agents.commit', value: 'as-you-go', carry: 'kept', because: '' },
    { path: 'queue.holds', value: 'ask', carry: 'kept', because: '' },
  ],
  pressed: [
    { path: 'telemetry.dsn', value: 'https://a@o1.example/2', carry: 'pressed', because: '' },
  ],
  here: [],
  files: [],
}

const listOf = (settings: CarryAnswer['settings'], talk?: CarryAnswer['talk']) =>
  checklistOf({
    remote: 'vps',
    setup,
    answer: {
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
      // Left as that machine has it, so never said to apply there, whatever came back.
      { path: 'queue.holds', outcome: 'theirs', theirs: 'orchestrator', nextStart: true },
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

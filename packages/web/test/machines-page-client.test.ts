import { ITEM_KINDS } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  cellSaid,
  columnSaid,
  diffTone,
  groupsOf,
  KIND_TITLE,
  leadOf,
  leftSaid,
  MARK_SAID,
  markTone,
  pressesOf,
  refusedSaid,
  underWay,
} from '../src/assets/pages/machines-shape.js'
import type { MachinesAnswer } from '../src/machines.ts'

// What the Machines page draws (`pages/machines-shape.js`), against the answer
// the person's own phone is sent (`machines.ts`): every kind headed, every mark
// said in words, the four figures with an unknown that is never nought, and
// the presses the window's own page offers — the move only once a plan is shown.

const ANSWER: MachinesAnswer = {
  columns: [
    { machine: 'mac', asOf: null, here: true, said: null },
    { machine: 'vps', asOf: '2026-11-22T10:00:00.000Z', here: false, said: null },
    { machine: 'pi', asOf: null, here: false, said: 'an older Tade, which does not say' },
  ],
  rows: [
    {
      id: 'sign-in:claude',
      kind: 'sign-in',
      label: 'Claude Code',
      cells: [
        { mark: '✓', days: 1, where: [], said: null },
        { mark: '✓', days: 30, where: [], said: null },
        { mark: '?', days: null, where: [], said: null },
      ],
    },
    {
      id: 'secret:openai',
      kind: 'secret',
      label: 'OpenAI key',
      cells: [
        { mark: '✗', days: null, where: [], said: null },
        { mark: '✓', days: null, where: [], said: null },
        { mark: '?', days: null, where: [], said: null },
      ],
    },
    {
      id: 'secret:linear',
      kind: 'secret',
      label: 'Linear key',
      cells: [
        { mark: '✓', days: null, where: ['~/.zshenv:14'], said: 'only a shell sets it' },
        { mark: '≠', days: null, where: [], said: null },
        { mark: '—', days: null, where: [], said: null },
      ],
    },
  ],
  looking: false,
  plan: null,
  busy: false,
  said: null,
  file: '~/.config/tade/env',
  agents: 'any agent can read it',
}

describe('the Machines page’s words', () => {
  it('heads every kind of item the inventory has, and says every mark in words', () => {
    expect(Object.keys(KIND_TITLE).sort()).toEqual([...ITEM_KINDS].sort())
    for (const mark of ['✓', '✗', '≠', '—', '?']) expect(MARK_SAID[mark]).toBeTruthy()
    expect(cellSaid({ mark: '✓', days: 1, where: [], said: null })).toBe('set · 1 day left')
    expect(cellSaid({ mark: '✓', days: 30, where: [], said: null })).toBe('set · 30 days left')
    expect(cellSaid({ mark: '✗', days: null, where: [], said: null })).toBe('missing')
    expect(markTone('✓')).toBe('done')
    expect(markTone('✗')).toBe('failed')
    expect(markTone('≠')).toBe('working')
    expect(markTone('—')).toBe('quiet')
  })

  it('says under each machine why it has nothing, when it last said, or that it is this one', () => {
    const clock = (at: string) => at.slice(11, 16)
    const [mac, vps, pi] = ANSWER.columns ?? []
    expect(columnSaid(mac, clock)).toBe('this machine, now')
    expect(columnSaid(vps, clock)).toBe('as of 10:00')
    expect(columnSaid(pi, clock)).toBe('an older Tade, which does not say')
  })

  it('groups the rows by kind, in the grid’s order', () => {
    expect(groupsOf(ANSWER).map((one) => [one.head, one.rows.map((row) => row.id)])).toEqual([
      ['Sign-ins', ['sign-in:claude']],
      ['Keys', ['secret:openai', 'secret:linear']],
    ])
    expect(groupsOf(null)).toEqual([])
  })

  it('leads with the machines, the items, what is missing here and what differs — unknown before a look', () => {
    expect(leadOf(ANSWER).map((one) => [one.key, one.value])).toEqual([
      ['machines', '3'],
      ['items', '3'],
      ['missing', '1'],
      ['differ', '1'],
    ])
    expect(leadOf(ANSWER).find((one) => one.key === 'missing')?.tone).toBe('failed')
    for (const one of leadOf({ ...ANSWER, columns: null })) expect(one.value).toBeNull()
  })

  it('offers looking and working out the move, then the move and leaving them once a plan is shown', () => {
    expect(pressesOf(ANSWER).map((one) => one.id)).toEqual(['look', 'plan'])
    expect(pressesOf(ANSWER)[1]?.word).toBe('Move keys into ~/.config/tade/env…')
    const plan = { diff: ['~/.zshenv - export A=•••'], moved: ['A'], left: [] }
    const shown = pressesOf({ ...ANSWER, plan })
    expect(shown.map((one) => one.id)).toEqual(['look', 'move', 'leave'])
    expect(shown[1]?.again).toBe('Press again to move them')
    // Nothing to move is nothing offered to move.
    expect(pressesOf({ ...ANSWER, plan: { ...plan, moved: [] } }).map((one) => one.id)).toEqual([
      'look',
      'leave',
    ])
    expect(pressesOf(null)).toEqual([])
  })

  it('asks again soon only while something is under way', () => {
    expect(underWay(ANSWER)).toBe(false)
    expect(underWay({ ...ANSWER, looking: true })).toBe(true)
    expect(underWay({ ...ANSWER, busy: true })).toBe(true)
    expect(underWay({ ...ANSWER, columns: null })).toBe(true)
  })

  it('tones a diff, says what was left, and words a device that is not the person’s own', () => {
    expect(diffTone('~/.zshenv:3 - export A=•••')).toBe('failed')
    expect(diffTone('~/.config/tade/env + A=•••')).toBe('done')
    expect(diffTone('~/.zshenv')).toBe('quiet')
    expect(leftSaid({ name: 'A', where: '~/.zshrc:3', why: 'set by a command' })).toBe(
      'left: A at ~/.zshrc:3 — set by a command',
    )
    expect(refusedSaid({ status: 403, body: { error: 'out_of_scope' } })?.title).toBe(
      'Only your own device',
    )
    expect(refusedSaid({ status: 404, body: { error: 'no_such' } })).not.toBeNull()
    expect(refusedSaid({ status: 0, body: null })).toBeNull()
  })
})

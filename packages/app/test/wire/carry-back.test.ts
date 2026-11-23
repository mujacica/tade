import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CARRY_SCHEMA, ConfigSchema, type SettingConflict, stampText } from '@tade/core'
import type { CarryAnswer } from '@tade/remotes-core'
import type { TakenWrite } from '@tade/workbench/carry'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { Carries } from '../../src/wire/carry.ts'

// What the window does with what another machine's carry answer says is
// newer there (`Carries`, `takeBack`): written here through its own door with
// the stamp it came with, a conflict written down and said once, and a
// change to what widens agents said and taken only on a press here, whoever
// that machine says made it (`takenOnAPress`).

const at = (wall: number, machine: string) => stampText({ wall, count: 0, machine })

/** A window's carrying, over a home and a link that answers every carry with `answer`. */
function carrying(answer: CarryAnswer, conflicted: (c: SettingConflict) => Promise<void>) {
  const home = tmp('tade-carry-back-')
  const configPath = join(home, 'config.yaml')
  writeFileSync(configPath, 'queue:\n  holds: ask\n')
  const taken: TakenWrite[] = []
  const said: string[] = []
  const pressed: { text: string | null; error: string | null }[] = []
  const conflicts: SettingConflict[] = []
  const link = { call: async () => ({ status: 200, body: answer }) }
  const carries = new Carries({
    home,
    configPath,
    config: () => ConfigSchema.parse({}),
    reach: () => ({
      link: link as never,
      remote: { name: 'vps' } as never,
      live: true,
    }),
    secrets: () => new Set(),
    from: () => 'mac',
    log: async () => {},
    fold: async () => {},
    lines: async () => [
      {
        type: 'config_changed',
        detail: { path: 'queue.holds', was: '', now: 'ask', by: 'window', hlc: at(2_000, 'mac') },
      },
    ],
    found: async () => {},
    take: async (write) => {
      taken.push(write)
    },
    conflicted: async (one) => {
      conflicts.push(one)
      await conflicted(one)
    },
    onScreenWith: async () => {},
    said: (text, error) => {
      pressed.push({ text, error })
    },
    say: (text) => {
      said.push(text)
    },
    draw: () => {},
    now: () => 0,
  })
  return { carries, taken, said, pressed, conflicts }
}

const answer: CarryAnswer = {
  schema: CARRY_SCHEMA,
  machine: 'vps',
  settings: [
    // Later there, made over nothing this machine wrote: taken, and a conflict.
    { path: 'queue.holds', outcome: 'newer', value: 'orchestrator', hlc: at(5_000, 'vps') },
    // Only there: taken.
    { path: 'notes.keep_days', outcome: 'newer', value: 9, hlc: at(1_000, 'vps') },
    // What widens agents, which that machine says you changed: not taken, and said why.
    {
      path: 'approvals.mode',
      outcome: 'newer',
      value: 'auto',
      hlc: at(6_000, 'vps'),
      by: 'window',
    },
  ],
  files: [],
  signIns: [],
}

describe('what comes back newer from another machine', () => {
  it('is written here with the stamp it came with, and the checklist says it was taken', async () => {
    const { carries, taken } = carrying(answer, async () => {})
    const list = await carries.carry('vps', { keys: false })
    expect(taken).toEqual([
      { path: 'queue.holds', value: 'orchestrator', stamp: { hlc: at(5_000, 'vps') } },
      { path: 'notes.keep_days', value: 9, stamp: { hlc: at(1_000, 'vps') } },
    ])
    expect(list?.taken).toEqual(['queue.holds', 'notes.keep_days'])
    expect(list?.newer).toEqual([
      {
        what: 'approvals.mode',
        why: expect.stringMatching(/only on your press here.*\(it says window\)/),
        press: true,
      },
    ])
  })

  it('takes what widens agents on the Remotes page’s press, written as the press’s here', async () => {
    const { carries, taken, said, pressed } = carrying(answer, async () => {})
    await carries.carry('vps', { keys: false })
    expect(taken.map((one) => one.path)).not.toContain('approvals.mode')
    await carries.action('remote:take:vps:approvals.mode')
    expect(taken.find((one) => one.path === 'approvals.mode')).toEqual({
      path: 'approvals.mode',
      value: 'auto',
      stamp: { hlc: at(6_000, 'vps'), origin: 'window' },
    })
    expect(said).toContain('Taken from vps on your press: approvals.mode is auto here now.')
    expect(pressed.at(-1)).toEqual({ text: 'Took vps’s approvals.mode here.', error: null })
    // A press for what is not newer there takes nothing, and says so.
    await carries.action('remote:take:vps:extensions.sentry.enabled')
    expect(pressed.at(-1)).toEqual({
      text: null,
      error: 'vps no longer has a newer extensions.sentry.enabled, so nothing was taken.',
    })
  })

  it('writes a conflict down and says it once, and says what it would not take once', async () => {
    const { carries, said, conflicts } = carrying(answer, async () => {})
    await carries.carry('vps', { keys: false })
    await carries.carry('vps', { keys: false })
    expect(conflicts.map((one) => one.path)).toEqual(['queue.holds'])
    expect(said.filter((one) => one.startsWith('Changed on both vps and here'))).toHaveLength(1)
    expect(said.filter((one) => one.startsWith('Not taken from vps: approvals.mode'))).toHaveLength(
      1,
    )
  })

  it('says a conflict whose line would not be written, rather than losing it', async () => {
    const { carries, said } = carrying(answer, async () => {
      throw new Error('ENOSPC: no space left on device')
    })
    await carries.carry('vps', { keys: false })
    expect(said.find((one) => one.startsWith('Changed on both'))).toMatch(
      /not written down here: ENOSPC/,
    )
  })
})

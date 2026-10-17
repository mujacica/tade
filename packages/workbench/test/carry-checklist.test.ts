import type { CarryAnswer } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { checklistLines, checklistOf, type Setup } from '../src/carry.ts'

// What a remote said it reads only when its Tade next starts, in the checklist
// `tade remote add` ends with and Settings › Remotes draws (`checklistOf`).

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

const listOf = (settings: CarryAnswer['settings']) =>
  checklistOf({
    remote: 'vps',
    setup,
    answer: { machine: 'box-1', settings, files: [], signIns: [] },
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

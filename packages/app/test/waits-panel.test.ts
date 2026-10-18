import { describe, expect, it } from 'vitest'
import type { TaskSnapshot } from '../src/model.ts'
import {
  type WaitRow,
  type WaitsPanel,
  waitRowsOf,
  waitsClick,
  waitsKey,
  waitsPanel,
} from '../src/panels/waits/state.ts'

// What queued work waits on, picked from a list: what the keys and the mouse
// do to the picking, and what the list is folded out of.

const row = (task: string, group: WaitRow['group'], standing: WaitRow['standing']): WaitRow => ({
  task,
  project: task.split('/')[0] ?? '',
  name: task.split('/')[1] ?? task,
  standing,
  group,
  about: '',
})

const rows: WaitRow[] = [
  row('app/gone-one', 'now', 'removed'),
  row('app/busy-one', 'working', 'working'),
  row('web/later', 'queued', 'queued'),
]

const opened = () => waitsPanel('app/behind', [{ task: 'app/gone-one', why: 'old reason' }])

/** Keys pressed one after another, as a terminal sends them. */
function pressed(panel: WaitsPanel, ...keys: [string | undefined, string][]): WaitsPanel {
  let now = panel
  for (const [key, data] of keys) {
    const next = waitsKey(now, key, data, rows).panel
    if (next?.kind !== 'waits') throw new Error('the panel went')
    now = next
  }
  return now
}

describe('the waits panel', () => {
  it('ticks with space, writes why on tab, and saves with enter', () => {
    const panel = pressed(
      opened(),
      ['down', ''],
      ['space', ' '],
      ['tab', '\t'],
      [undefined, 'its tests'],
      ['enter', '\r'],
    )
    expect(panel.picked).toEqual([
      { task: 'app/gone-one', why: 'old reason' },
      { task: 'app/busy-one', why: 'its tests' },
    ])
    expect(panel.editing).toBe(false)
    const saved = waitsKey(panel, 'enter', '\r', rows)
    expect(saved.submit).toBe(true)
    expect(saved.panel).toMatchObject({ busy: true })
  })

  it('narrows by typing, and space ticks what is left', () => {
    const panel = pressed(opened(), [undefined, 'web'], ['space', ' '])
    expect(panel.query).toBe('web')
    expect(panel.picked.map((one) => one.task)).toEqual(['app/gone-one', 'web/later'])
  })

  it('drops every wait on a task that has gone, and keeps the rest', () => {
    const picked = { ...opened(), picked: [...opened().picked, { task: 'app/busy-one', why: '' }] }
    const after = waitsClick(picked, 'drop-gone', rows).panel
    expect(after).toMatchObject({ picked: [{ task: 'app/busy-one', why: '' }] })
  })

  it('unticks with a click on the row, and keeps an approval wait an approval wait', () => {
    const approving = waitsPanel('app/behind', [
      { task: 'app/gone-one', why: '', approved: true },
      { task: 'app/busy-one', why: '' },
    ])
    expect(waitsClick(approving, 'row:1', rows).panel).toMatchObject({
      picked: [{ task: 'app/gone-one', why: '', approved: true }],
    })
  })

  it('escape stops writing why before it closes', () => {
    const writing = pressed(opened(), ['tab', '\t'])
    expect(writing.editing).toBe(true)
    expect(waitsKey(writing, 'escape', '\x1b', rows).panel).toMatchObject({ editing: false })
    expect(waitsKey(opened(), 'escape', '\x1b', rows).panel).toBeNull()
  })
})

describe('what it could wait on', () => {
  const snap = (task: string, state: TaskSnapshot['state'], title = ''): TaskSnapshot => ({
    task,
    state,
    title,
  })

  it('lists its waits first wherever they stand, then agents at work, then the queue, never itself', () => {
    const listed = waitRowsOf({
      task: 'app/behind',
      after: [
        { task: 'app/removed-one', why: '' },
        { task: 'app/done-one', why: '' },
      ],
      tasks: [
        snap('app/behind', 'queued'),
        snap('app/done-one', 'review'),
        snap('web/busy', 'working', 'Busy on the web'),
        snap('app/busy', 'blocked'),
        snap('app/failed', 'failed'),
        snap('app/parked-one', 'parked'),
      ],
      queued: [
        {
          task: 'app/behind',
          project: 'app',
          parked: false,
          start: { after: [], prompt: '', touches: [] },
        },
        {
          task: 'app/next',
          project: 'app',
          parked: false,
          start: { after: [], prompt: '', touches: [] },
        },
      ],
      finished: new Set(['app/done-one']),
    })
    expect(listed.map((one) => [one.task, one.group, one.standing])).toEqual([
      ['app/removed-one', 'now', 'removed'],
      ['app/done-one', 'now', 'finished'],
      ['app/busy', 'working', 'needs you'],
      ['web/busy', 'working', 'working'],
      ['app/next', 'queued', 'queued'],
      ['app/parked-one', 'queued', 'parked'],
    ])
    expect(listed.find((one) => one.task === 'web/busy')?.about).toBe('Busy on the web')
  })
})

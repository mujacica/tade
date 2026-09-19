import { describe, expect, it } from 'vitest'
import { drawPlan, layoutPlan, type PlanBox } from '../src/plan-graph.ts'

const box = (task: string, note = ''): PlanBox => ({
  task,
  mark: '◌',
  name: task,
  right: '',
  note,
  tone: 'hint',
})

const plain = (drawing: ReturnType<typeof drawPlan>) =>
  drawing.rows.map((runs) =>
    runs
      .map((run) => run.text)
      .join('')
      .trimEnd(),
  )

describe('a plan, laid out', () => {
  it('puts each task in the column after the last thing it waits on', () => {
    const { columns } = layoutPlan(
      ['fix', 'mailer', 'docs', 'refunds', 'emails'],
      [
        { from: 'fix', to: 'refunds' },
        { from: 'refunds', to: 'emails' },
        { from: 'mailer', to: 'emails' },
      ],
    )
    // What the stand-ins for longer waits leave out: the tasks themselves.
    expect(columns.map((column) => column.filter((id) => !id.startsWith('⋯')))).toEqual([
      ['fix', 'mailer', 'docs'],
      ['refunds'],
      ['emails'],
    ])
  })

  it('carries a wait across a column as a line of its own, never through a box', () => {
    const { columns, through } = layoutPlan(
      ['a', 'b', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'a', to: 'c' },
      ],
    )
    expect(columns).toHaveLength(3)
    expect(columns[1]).toContain('b')
    expect([...through.values()]).toEqual([{ from: 'a', to: 'c' }])
  })

  it('draws boxes joined by arrows, in columns under their headings', () => {
    const drawing = drawPlan(
      [box('fix', 'working'), box('mailer'), box('refunds', 'after fix')],
      [
        { from: 'fix', to: 'refunds' },
        { from: 'mailer', to: 'refunds' },
      ],
      60,
      (column) => (column === 0 ? 'FIRST' : 'THEN'),
    )
    const rows = plain(drawing)
    expect(drawing.tooWide).toBe(false)
    expect(rows[0]).toBe(`FIRST${' '.repeat(25)}THEN`)
    expect(rows[1]).toBe('╭──────────────────────╮      ╭──────────────────────╮')
    // The second wait joins the first on its way in.
    expect(rows[2]).toBe('│ ◌ fix                │─┬───▶│ ◌ refunds            │')
    expect(rows[3]).toBe('│   working            │ │    │   after fix          │')
    expect(rows[7]).toBe('│ ◌ mailer             │─╯')
    for (const row of rows) expect([...row].length).toBeLessThanOrEqual(60)
  })

  it('draws the one you are on heavier, and says which box every cell belongs to', () => {
    const drawing = drawPlan(
      [box('fix'), { ...box('refunds'), here: true }],
      [{ from: 'fix', to: 'refunds' }],
      60,
      () => '',
    )
    const rows = plain(drawing)
    // Heavier lines, so which one is the subject reads with the colour off.
    expect(rows[2]).toBe('│ ◌ fix                │─────▶┃ ◌ refunds            ┃')
    expect(drawing.rows[2]?.find((run) => run.text.includes('fix'))?.task).toBe('fix')
    expect(drawing.rows[2]?.find((run) => run.text.includes('refunds'))?.task).toBe('refunds')
    // The heavy box is painted as the one you are on, whatever its own tone.
    expect(drawing.rows[1]?.find((run) => run.task === 'refunds')?.tone).toBe('here')
    // The lines between boxes belong to nobody: clicking one goes nowhere.
    expect(drawing.rows[2]?.find((run) => run.text.includes('▶'))?.task).toBeUndefined()
  })

  it('draws narrower boxes rather than nothing when the roomy ones do not fit', () => {
    const chain = ['a', 'b', 'c'].map((task) => box(task))
    const waits = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]
    const drawing = drawPlan(chain, waits, 60, () => '')
    expect(drawing.tooWide).toBe(false)
    const rows = plain(drawing)
    expect(rows[1]).toBe('╭──────────────╮    ╭──────────────╮    ╭──────────────╮')
    for (const row of rows) expect([...row].length).toBeLessThanOrEqual(60)
  })

  it('says a plan is too wide for its columns rather than squeezing it', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e']
    const drawing = drawPlan(
      tasks.map((task) => box(task)),
      tasks.slice(1).map((task, i) => ({ from: tasks[i] ?? '', to: task })),
      60,
      () => '',
    )
    expect(drawing).toEqual({ rows: [], tooWide: true })
  })
})

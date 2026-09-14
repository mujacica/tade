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

  it('says a plan is too wide for its columns rather than squeezing it', () => {
    const chain = ['a', 'b', 'c'].map((task) => box(task))
    const drawing = drawPlan(
      chain,
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
      60,
      () => '',
    )
    expect(drawing).toEqual({ rows: [], tooWide: true })
  })
})

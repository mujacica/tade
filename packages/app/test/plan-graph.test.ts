import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import {
  drawPlan,
  drawWhy,
  layoutPlan,
  type PlanBox,
  type PlanRun,
  treeStems,
} from '../src/plan-graph.ts'

const box = (task: string, note = ''): PlanBox => ({
  task,
  mark: '◌',
  name: task,
  right: '',
  note,
  tone: 'hint',
})

const lines = (rows: readonly PlanRun[][]) =>
  rows.map((runs) =>
    runs
      .map((run) => run.text)
      .join('')
      .trimEnd(),
  )

const plain = (drawing: ReturnType<typeof drawPlan>) => lines(drawing.rows)

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

describe('the lines that make a list a tree', () => {
  it('hangs each row off the one it waits on, and carries the line past it', () => {
    // a ─ b ─ d
    //     └── c
    const stems = treeStems([-1, 0, 1, 1], 4)
    expect(stems.map((one) => one.stem)).toEqual(['', '╰─', '  ├─', '  ╰─'])
    // b's own line carries on down to c, and stops after it.
    expect(stems[1]?.bars).toBe('  │')
    expect(stems[3]?.bars).toBe('')
  })

  it('stops shifting right at the levels it was given room for', () => {
    const stems = treeStems([-1, 0, 1, 2, 3], 2)
    expect(stems.map((one) => visibleWidth(one.stem))).toEqual([0, 2, 4, 4, 4])
  })
})

describe('why each piece waits, drawn', () => {
  const chain = ['schema', 'api', 'client', 'docs']
  const boxes = chain.map((task) => box(task))
  const waits = [
    { from: 'schema', to: 'api', why: 'the endpoints follow the tables' },
    { from: 'api', to: 'client', why: 'it calls what the endpoints return' },
    { from: 'client', to: 'docs', why: 'it screenshots the dashboard' },
  ]

  it('reads down the chain in the order it runs, not by name', () => {
    const drawn = lines(drawWhy(boxes, waits, 80))
    expect(drawn).toEqual([
      '◌ schema',
      '╰─◌ api  after schema',
      '  │ the endpoints follow the tables',
      '  ╰─◌ client  after api',
      '    │ it calls what the endpoints return',
      '    ╰─◌ docs  after client',
      '        it screenshots the dashboard',
    ])
  })

  it('branches what waits on one thing under it, joined by a line', () => {
    const drawn = lines(
      drawWhy(
        [...boxes, box('keys')],
        [...waits, { from: 'api', to: 'keys', why: 'the sheet lists the endpoints' }],
        80,
      ),
    )
    // Both hang off api, and the line down to the second passes the first.
    expect(drawn).toContain('  ├─◌ client  after api')
    expect(drawn).toContain('  ╰─◌ keys  after api')
    expect(drawn).toContain('  │ │ it calls what the endpoints return')
  })

  it('says every wait, including the ones it does not hang from', () => {
    const drawn = lines(
      drawWhy(
        [box('fix'), box('mailer'), box('emails')],
        [
          { from: 'fix', to: 'emails', why: 'it emails what refund() returns' },
          { from: 'mailer', to: 'emails', why: 'the mailer’s send() changes in v4' },
        ],
        80,
      ),
    )
    expect(drawn).toContain('╰─◌ emails  after fix')
    expect(drawn).toContain('    also after mailer')
    expect(drawn).toContain('    the mailer’s send() changes in v4')
    // A piece at the front with nothing hanging off it says nothing twice.
    expect(drawn).not.toContain('◌ mailer')
  })

  it('wraps a reason rather than running it off the panel, however narrow', () => {
    const long = [
      { from: 'schema', to: 'api', why: 'the endpoints follow the tables, all of them' },
      ...waits.slice(1),
    ]
    for (const width of [72, 48, 30, 20, 12]) {
      const rows = drawWhy(boxes, long, width)
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(visibleWidth(row.map((run) => run.text).join(''))).toBeLessThanOrEqual(width)
      }
    }
  })

  it('keeps the gap before after, and ends a name it had to cut in …', () => {
    const drawn = lines(
      drawWhy(
        [box('one-that-is-rather-long'), box('another-that-is-long')],
        [{ from: 'one-that-is-rather-long', to: 'another-that-is-long', why: 'they share a file' }],
        40,
      ),
    )
    const row = drawn.find((one) => one.includes('after')) ?? ''
    // Two spaces at least between the name and the word: they never collide.
    expect(row).toMatch(/\S {2,}after \S/)
    // Both names had to give way at this width, and both say so.
    expect(row).toBe('╰─◌ another-that-is…  after one-that-is…')
  })

  it('draws nothing where nothing waits on anything', () => {
    expect(drawWhy([box('a'), box('b')], [], 80)).toEqual([])
  })

  it('says a ring of waits rather than walking it for ever', () => {
    const drawn = lines(
      drawWhy(
        [box('a'), box('b')],
        [
          { from: 'a', to: 'b', why: 'one' },
          { from: 'b', to: 'a', why: 'the other' },
        ],
        60,
      ),
    )
    expect(drawn.join('\n')).toContain('one')
    expect(drawn.join('\n')).toContain('the other')
  })

  it('names the piece in front of you even when nothing hangs off it', () => {
    const drawn = lines(
      drawWhy(
        [{ ...box('mailer'), here: true }, box('fix'), box('emails')],
        [
          { from: 'fix', to: 'emails', why: 'it emails what refund() returns' },
          { from: 'mailer', to: 'emails', why: 'the mailer’s send() changes in v4' },
        ],
        80,
      ),
    )
    expect(drawn).toContain('◌ mailer')
  })
})

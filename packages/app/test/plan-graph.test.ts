import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import {
  drawPlan,
  drawWhy,
  layoutPlan,
  type PlanBox,
  type PlanRun,
  planWidth,
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
    expect(drawing.width).toBe(60)
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
    expect(drawing.width).toBe(60)
    const rows = plain(drawing)
    expect(rows[1]).toBe('╭──────────────╮    ╭──────────────╮    ╭──────────────╮')
    for (const row of rows) expect([...row].length).toBeLessThanOrEqual(60)
  })

  it('draws a chain too long for the room anyway, and says how wide it came out', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e']
    const drawing = drawPlan(
      tasks.map((task) => box(task)),
      tasks.slice(1).map((task, i) => ({ from: tasks[i] ?? '', to: task })),
      60,
      () => '',
    )
    // Five tight boxes and the room between them, which is more than 60: the
    // boxes are still drawn, and the panel scrolls to the rest of them.
    expect(drawing.width).toBe(5 * 16 + 4 * 4)
    expect(planWidth(drawing.rows)).toBe(drawing.width)
    const rows = plain(drawing)
    // Every one of the five is there, and the last is past the room given.
    for (const task of tasks) expect(rows.join('\n')).toContain(`◌ ${task}`)
    expect(rows[2]?.indexOf('◌ e')).toBeGreaterThan(60)
  })
})

describe('the lines that make a list a tree', () => {
  it('hangs each row off the one it waits on, and carries the line past it', () => {
    // a ─ b ─ d
    //     └── c
    const stems = treeStems([-1, 0, 1, 1])
    expect(stems.map((one) => one.stem)).toEqual(['', '╰─', '  ├─', '  ╰─'])
    // b's own line carries on down to c, and stops after it.
    expect(stems[1]?.bars).toBe('  │')
    expect(stems[3]?.bars).toBe('')
  })

  it('goes on shifting right however long the chain is', () => {
    // Folding the indent back would put the fourth and the fifth in one
    // column, and a column is what says which work can run together.
    const stems = treeStems([-1, 0, 1, 2, 3])
    expect(stems.map((one) => visibleWidth(one.stem))).toEqual([0, 2, 4, 6, 8])
  })

  it('puts a row in the column its depth gives it, not the one the rows above give it', () => {
    // c waits on b, which is not shown: it still stands two columns in.
    const stems = treeStems([-1, -1], [0, 2])
    expect(stems.map((one) => visibleWidth(one.stem))).toEqual([0, 4])
    // Nothing shown to hang from, so nothing is drawn hanging.
    expect(stems[1]?.stem).toBe('    ')
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

  it('wraps a reason between words, never through them, however narrow', () => {
    const long = [
      { from: 'schema', to: 'api', why: 'the endpoints follow the tables, all of them' },
      ...waits.slice(1),
    ]
    const reason = 'the endpoints follow the tables, all of them'
    for (const width of [72, 48, 30, 20, 12]) {
      const rows = drawWhy(boxes, long, width)
      expect(rows.length).toBeGreaterThan(0)
      // Every word arrives whole: a reason broken a letter at a time to fit
      // an indent is a reason nobody can act on.
      const said = rows
        .flatMap((row) =>
          row
            .map((run) => run.text)
            .join('')
            .split(/\s+/),
        )
        .filter(Boolean)
      for (const word of reason.split(' ')) expect(said, `${word} at ${width}`).toContain(word)
    }
  })

  it('comes back wider than the room rather than squeezing a reason, and never by more', () => {
    // A chain shallow enough leaves the reasons plenty of room and fits.
    expect(planWidth(drawWhy(boxes, waits, 80))).toBeLessThanOrEqual(80)
    // Deep enough and it does not: the panel it is in scrolls to the rest.
    const deep = drawWhy(boxes, waits, 16)
    expect(planWidth(deep)).toBeGreaterThan(16)
    // And no wider than the deepest stem, its gap, and a reason's own room.
    expect(planWidth(deep)).toBe(6 + 2 + 12)
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

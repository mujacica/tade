import { describe, expect, it } from 'vitest'
import { initialState, withProjects, withTasks } from '../src/model.ts'
import { draw } from '../src/view.ts'

// What extensions keep in the strip at the foot, and the model chooser beside
// it. What is held here is that the two are shed one at a time: a status that
// grows a few columns — the machine's resources — goes on its own, and never
// takes the orchestrator's model, a control said nowhere else, with it.

/** The same row without its colour, so a label can be looked for in it. */
const plain = (row: string) =>
  row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

const state = () =>
  withTasks(withProjects(initialState(), ['checkout']), [
    { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
  ])

const RESOURCES = '91% · 783 MB · 412 GB free'

const foot = (width: number) => {
  const one = draw(state(), {
    width,
    height: 24,
    screen: '',
    orchestratorModel: 'claude-opus-5',
    orchestratorThinking: 'high',
    statuses: [{ extension: 'machine', text: RESOURCES, tone: 'quiet', viewable: true }],
  })
  return plain(one.rows[one.rows.length - 1] ?? '')
}

describe('statuses, in the strip', () => {
  it('give up their room before the model chooser does, and on their own', () => {
    const rows = Array.from({ length: 141 }, (_, at) => foot(40 + at))
    // Wherever the status is drawn, the chooser is too: it is the later to go.
    for (const row of rows) if (row.includes(RESOURCES)) expect(row).toContain('opus')
    // And there is a width where the status has gone and the chooser has not,
    // which one flag guarding both never had.
    expect(rows.some((row) => row.includes('opus') && !row.includes(RESOURCES))).toBe(true)
  })
})

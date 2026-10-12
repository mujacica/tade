import { noRuntime } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import type { Hit } from '../src/hits.ts'
import { initialState, withProjects, withTasks } from '../src/model.ts'
import { COLOUR } from '../src/skin.ts'
import { updatesChip } from '../src/view/foot.ts'
import { draw } from '../src/view.ts'

// Updates, in the strip at the foot.
//
// What is held here is that the chip is only there when it wants somebody —
// something could move, a run is going, or a Tade that moved is owed a reload
// — that each says what pressing it does, that it is drawn at its own width
// with nothing kept after it, and that it outlasts the figures for room.

/** The same row without its colour, so a label can be looked for in it. */
const plain = (row: string) =>
  row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

const state = () =>
  withTasks(withProjects(initialState(), ['checkout']), [
    { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
  ])

const spending = {
  tokens: 1_900_000,
  usd: 1.4,
  hasCost: true,
  byTask: {},
  runtime: { ...noRuntime(), ms: 125 * 60_000, runs: 2, running: false },
}

const JEV = { extension: 'jev', text: 'jev 173/315 $0.47', tone: 'quiet', viewable: true } as const

const drawn = (width: number, updates: Frame['updates'], skin = false) =>
  draw(state(), {
    width,
    height: 24,
    screen: '',
    orchestratorModel: 'claude-opus-5',
    orchestratorThinking: 'high',
    spend: spending,
    statuses: [JEV],
    ...(updates ? { updates } : {}),
    ...(skin ? { skin: COLOUR } : {}),
  })

const foot = (one: { rows: string[] }) => plain(one.rows[one.rows.length - 1] ?? '')

/** The columns of the strip's last row that press `name`. */
const pressing = (one: { rows: string[]; hits: Hit[] }, name: string) =>
  one.hits.filter(
    (hit) =>
      hit.row === one.rows.length - 1 && hit.target.kind === 'action' && hit.target.name === name,
  )

const BEHIND = { behind: 3, running: null, reload: false }
const GOING = { behind: 3, running: { done: 1, of: 3 }, reload: false }
const OWED = { behind: 0, running: null, reload: true }

describe('updates, in the strip', () => {
  it('counts what could move forward, and runs it when pressed', () => {
    const one = drawn(160, BEHIND)
    expect(foot(one)).toContain('updates 3')
    expect(pressing(one, 'updates-run').length).toBeGreaterThan(0)
  })

  it('says how far a run is, and puts its terminal in front when pressed', () => {
    const one = drawn(160, GOING)
    expect(foot(one)).toContain('updating 2/3')
    expect(foot(one)).not.toContain('updates 3')
    expect(pressing(one, 'updates-show').length).toBeGreaterThan(0)
    expect(pressing(one, 'updates-run')).toEqual([])
  })

  it('turns into the reload a Tade that moved is owed', () => {
    const one = drawn(160, OWED)
    expect(foot(one)).toContain('reload Tade')
    expect(pressing(one, 'updates-reload').length).toBeGreaterThan(0)
  })

  it('says one thing at a time, the most pressing first', () => {
    expect(updatesChip({ behind: 2, running: { done: 0, of: 2 }, reload: true })?.said).toBe(
      'updating 1/2',
    )
    expect(updatesChip({ behind: 2, running: null, reload: true })?.said).toBe('reload Tade')
    expect(updatesChip({ behind: 0, running: null, reload: false })).toBeNull()
  })

  it('is amber while it wants somebody and the colour of work while it runs', () => {
    const row = (one: { rows: string[] }) => one.rows[one.rows.length - 1] ?? ''
    expect(row(drawn(160, BEHIND, true))).toContain(COLOUR.waiting('updates 3'))
    expect(row(drawn(160, OWED, true))).toContain(COLOUR.waiting('reload Tade'))
    expect(row(drawn(160, GOING, true))).toContain(COLOUR.busy('updating 2/3'))
  })

  it('is drawn at its own width, with nothing kept after its word', () => {
    // Held to the columns a run going takes, `updates 3` had three blanks
    // before the rule after it, which read as something missing there.
    const said: Array<[Frame['updates'], string]> = [
      [BEHIND, 'updates 3'],
      [GOING, 'updating 2/3'],
      [OWED, 'reload Tade'],
    ]
    for (const [updates, words] of said) {
      expect(foot(drawn(160, updates))).toContain(`$0.47 │ ${words} │ `)
    }
  })

  it('draws no chip with nothing to say', () => {
    expect(foot(drawn(160, undefined))).not.toContain('update')
    expect(foot(drawn(160, { behind: 0, running: null, reload: false }))).not.toContain('update')
  })

  it('outlasts the figures for room, and never costs the strip its width', () => {
    const TOKENS = '1.9M tok'
    const widths = Array.from({ length: 101 }, (_, at) => 60 + at)
    const rows = widths.map((width) => foot(drawn(width, BEHIND)))
    for (const row of rows) if (row.includes(TOKENS)) expect(row).toContain('updates 3')
    expect(rows.some((row) => row.includes('updates 3') && !row.includes(TOKENS))).toBe(true)
  })
})

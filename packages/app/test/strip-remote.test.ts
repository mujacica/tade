import { noRuntime } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import type { Hit } from '../src/hits.ts'
import { initialState, withProjects, withTasks } from '../src/model.ts'
import { COLOUR } from '../src/skin.ts'
import { draw } from '../src/view.ts'

// The away view, in the strip at the foot.
//
// What is held here is that the chip says what is *listening* and not what the
// config wishes, that it never slides what is beside it when it changes word,
// and that it costs the strip nothing it would rather have kept: `remote off`
// is the default, so it is the first thing given up, while a device reading
// this machine outlasts the figures.

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

/** The jev line as the extension now says it: read over flagged, then the money. */
const JEV = { extension: 'jev', text: 'jev 173/315 $0.47', tone: 'quiet', viewable: true } as const

const drawn = (width: number, remote: Frame['remote'], skin = false) =>
  draw(state(), {
    width,
    height: 24,
    screen: '',
    orchestratorModel: 'claude-opus-5',
    orchestratorThinking: 'high',
    spend: spending,
    statuses: [JEV],
    ...(remote ? { remote } : {}),
    ...(skin ? { skin: COLOUR } : {}),
  })

const foot = (one: { rows: string[] }) => plain(one.rows[one.rows.length - 1] ?? '')

/** The columns of the strip's last row that press `name`. */
const pressing = (one: { rows: string[]; hits: Hit[] }, name: string) =>
  one.hits.filter(
    (hit) =>
      hit.row === one.rows.length - 1 && hit.target.kind === 'action' && hit.target.name === name,
  )

const OFF = { on: false, devices: 0 }

describe('the away view, in the strip', () => {
  it('says remote off while nothing listens, and opens the switch in Settings', () => {
    const one = drawn(160, OFF)
    expect(foot(one)).toContain('remote off')
    expect(pressing(one, 'away-settings').length).toBeGreaterThan(0)
    expect(pressing(one, '/away')).toEqual([])
  })

  it('counts the devices with a page open while it listens, and opens the pairing panel', () => {
    const one = drawn(160, { on: true, devices: 2 })
    expect(foot(one)).toContain('remote 2')
    expect(foot(one)).not.toContain('remote off')
    expect(pressing(one, '/away').length).toBeGreaterThan(0)
    expect(pressing(one, 'away-settings')).toEqual([])
    // Nobody reading is still listening, and nought devices is a count it made.
    expect(foot(drawn(160, { on: true, devices: 0 }))).toContain('remote 0')
  })

  it('is green while it listens and the grey of a quiet status while it does not', () => {
    const row = (one: { rows: string[] }) => one.rows[one.rows.length - 1] ?? ''
    expect(row(drawn(160, { on: true, devices: 2 }, true))).toContain(COLOUR.done('remote 2'))
    expect(row(drawn(160, OFF, true))).toContain(COLOUR.hint('remote off'))
  })

  it('holds its columns whichever word it says, so the jev line beside it stays put', () => {
    const rows = [OFF, { on: true, devices: 2 }, { on: true, devices: 12 }].map((remote) =>
      foot(drawn(160, remote)),
    )
    for (const fixed of ['jev 173/315 $0.47', 'claude-opus-5', '│ high']) {
      const at = rows.map((row) => row.indexOf(fixed))
      expect(at[0]).toBeGreaterThan(0)
      expect(new Set(at).size).toBe(1)
    }
  })

  it('draws no chip in a frame nothing looked for it in', () => {
    // Off is a claim about the listener, and a frame with no answer has not made one.
    expect(foot(drawn(160, undefined))).not.toContain('remote')
  })

  it('gives up remote off before any figure, and keeps a device reading past them', () => {
    const TOKENS = '1.9M tok'
    const widths = Array.from({ length: 101 }, (_, at) => 60 + at)
    const off = widths.map((width) => foot(drawn(width, OFF)))
    const on = widths.map((width) => foot(drawn(width, { on: true, devices: 1 })))
    // Off: wherever the chip is drawn, every figure is too.
    for (const row of off) if (row.includes('remote off')) expect(row).toContain(TOKENS)
    expect(off.some((row) => row.includes(TOKENS) && !row.includes('remote off'))).toBe(true)
    // On: wherever the tokens are drawn the chip is, and it holds on after them.
    for (const row of on) if (row.includes(TOKENS)) expect(row).toContain('remote 1')
    expect(on.some((row) => row.includes('remote 1') && !row.includes(TOKENS))).toBe(true)
  })
})

import { noRuntime } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import type { Hit } from '../src/hits.ts'
import { type Machine, NO_DETAIL } from '../src/machines.ts'
import { initialState, withProjects, withTasks } from '../src/model.ts'
import { COLOUR } from '../src/skin.ts'
import { draw } from '../src/view.ts'

// The away view, in the strip at the foot.
//
// What is held here is that the chip says what is *listening* and not what the
// config wishes — how many of the person's machines can be reached from their
// phone now, or this one's alone where no other is linked — that it is drawn
// at its own width with nothing kept after it, and that it costs the strip
// nothing it would rather have kept: `away off` is the default, so it is the
// first thing given up, while an away view that is up outlasts the figures.

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

const drawn = (
  width: number,
  remote: Frame['remote'],
  skin = false,
  remotes: readonly Machine[] = [],
) =>
  draw(state(), {
    ...(remotes.length > 0 ? { machines: { here: 'this Mac', remotes } } : {}),
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

/** Another machine, linked or not, whose away view said it is on or off. */
const machine = (name: string, link: Machine['link'], on: boolean | null): Machine => ({
  name,
  link,
  rev: 1,
  said: null,
  asOf: 0,
  heard: true,
  projects: [],
  spend: null,
  talk: null,
  closed: false,
  seen: [],
  detail: {
    ...NO_DETAIL,
    about:
      on === null
        ? null
        : {
            at: 0,
            roundTrip: null,
            version: '0.0.0',
            newer: null,
            commit: null,
            public: null,
            away: { on, paired: 1, connected: 0 },
            problems: [],
            schedules: [],
            documents: [],
          },
  },
})

describe('the away view, in the strip', () => {
  it('says away off while nothing listens, and opens the switch in Settings', () => {
    const one = drawn(160, OFF)
    expect(foot(one)).toContain('away off')
    expect(pressing(one, 'away-settings').length).toBeGreaterThan(0)
    expect(pressing(one, '/away')).toEqual([])
  })

  it('says away on while it listens, whoever is reading, and opens the pairing panel', () => {
    const one = drawn(160, { on: true, devices: 2 })
    expect(foot(one)).toContain('away on')
    expect(foot(one)).not.toContain('away off')
    expect(pressing(one, '/away').length).toBeGreaterThan(0)
    expect(pressing(one, 'away-settings')).toEqual([])
    // Nobody reading is still listening: a page open is the panel's to list.
    expect(foot(drawn(160, { on: true, devices: 0 }))).toContain('away on')
  })

  it('counts every machine whose away view is up, this one among them, once another is linked', () => {
    const ipax = machine('ipax', 'live', true)
    expect(foot(drawn(160, { on: true, devices: 0 }, false, [ipax]))).toContain('away 2/2 up')
    expect(foot(drawn(160, OFF, false, [ipax]))).toContain('away 1/2 up')
    // Down is never up, whatever it last said; a Tade that says nothing is not counted.
    const down = machine('vps', 'down', true)
    const quiet = machine('box', 'live', null)
    expect(foot(drawn(160, { on: true, devices: 0 }, false, [ipax, down, quiet]))).toContain(
      'away 2/4 up',
    )
    // Off here with another machine linked is still the panel, where its tab is.
    const none = drawn(160, OFF, false, [down])
    expect(foot(none)).toContain('away 0/2 up')
    expect(pressing(none, '/away').length).toBeGreaterThan(0)
  })

  it('is green while anything is up and the grey of a quiet status while nothing is', () => {
    const row = (one: { rows: string[] }) => one.rows[one.rows.length - 1] ?? ''
    expect(row(drawn(160, { on: true, devices: 2 }, true))).toContain(COLOUR.done('away on'))
    expect(row(drawn(160, OFF, true))).toContain(COLOUR.hint('away off'))
    const down = machine('vps', 'down', true)
    expect(row(drawn(160, OFF, true, [down]))).toContain(COLOUR.hint('away 0/2 up'))
  })

  it('is drawn at its own width, with nothing kept after its word', () => {
    const said: Array<[Frame['remote'], readonly Machine[], string]> = [
      [OFF, [], 'away off'],
      [{ on: true, devices: 0 }, [], 'away on'],
      [{ on: true, devices: 12 }, [machine('ipax', 'live', true)], 'away 2/2 up'],
    ]
    for (const [remote, remotes, words] of said) {
      expect(foot(drawn(160, remote, false, remotes))).toContain(`$0.47 │ ${words} │ `)
    }
  })

  it('draws no chip in a frame nothing looked for it in', () => {
    // Off is a claim about the listener, and a frame with no answer has not made one.
    expect(foot(drawn(160, undefined))).not.toContain('away')
  })

  it('gives up away off before any figure, and keeps an away view that is up past them', () => {
    const TOKENS = '1.9M tok'
    const widths = Array.from({ length: 101 }, (_, at) => 60 + at)
    const off = widths.map((width) => foot(drawn(width, OFF)))
    const on = widths.map((width) => foot(drawn(width, { on: true, devices: 1 })))
    // Off: wherever the chip is drawn, every figure is too.
    for (const row of off) if (row.includes('away off')) expect(row).toContain(TOKENS)
    expect(off.some((row) => row.includes(TOKENS) && !row.includes('away off'))).toBe(true)
    // On: wherever the tokens are drawn the chip is, and it holds on after them.
    for (const row of on) if (row.includes(TOKENS)) expect(row).toContain('away on')
    expect(on.some((row) => row.includes('away on') && !row.includes(TOKENS))).toBe(true)
  })
})

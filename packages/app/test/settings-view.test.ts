import { sliceByColumn, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { ConfigSchema, type SettingGroup, settingsOf } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { pressable, type Target } from '../src/hits.ts'
import { cap, drawPanel, formLayout, type PanelContext, sideWidth } from '../src/panel-view.ts'
import { type SettingsPanel, settingsPanel } from '../src/panels.ts'
import { COLOUR } from '../src/skin.ts'
import type { Drawn } from '../src/ui.ts'

// What the Settings panel has to be true at every width.
//
// The goldens say what it looks like on the two terminals they were drawn on;
// these say what holds on all the others — that nothing ever runs into
// anything, and that everything you can click says so under the pointer.

const config = ConfigSchema.parse({
  projects: {
    checkout: { root: '~/src/checkout', budget: { usd_per_day: 5 } },
    search: { root: '~/src/search' },
  },
  surfaces: {
    voice: {
      mic: { device: 'MacBook Pro Microphone' },
      attention: { budget: 6, quiet: '22:00-07:00' },
    },
  },
})

const GROUPS: SettingGroup[] = settingsOf(config)
const CATEGORIES = [...GROUPS.map((group) => group.id), 'accounts']

const context = (over: Partial<PanelContext> = {}): PanelContext =>
  ({
    width: 120,
    height: 34,
    skin: COLOUR,
    pointer: { hover: null, pressed: null },
    home: '~/.tade',
    route: null,
    spend: null,
    panes: [],
    project: 'checkout',
    items: [],
    changes: [],
    ahead: null,
    branch: null,
    base: null,
    diff: null,
    choices: [
      { value: 'whisper', label: 'whisper · base.en', group: 'On this machine', note: 'no key' },
      { value: 'openai', label: 'openai · whisper-1', group: 'In the cloud', note: 'needs a key' },
    ],
    settings: GROUPS,
    accounts: [
      {
        harness: 'claude-code',
        name: null,
        kind: 'subscription' as const,
        canAdd: true,
        why: null,
        status: { signedIn: true, who: 'you@example.com', plan: 'max', problem: null },
        limits: { fiveHour: { used: 34, resetsAt: 0 } },
        agents: 1,
        forNewAgents: true,
        canSignIn: true,
      },
    ],
    configPath: '~/.tade/config.yaml',
    releases: true,
    budgetWarnings: 1,
    levels: [],
    openRows: [],
    browsing: null,
    homeDir: '/Users/me',
    entries: [],
    searching: false,
    viewing: null,
    talkKey: 'ctrl+space',
    talkMode: 'hold',
    bindings: {},
    running: 0,
    branches: [],
    checkout: null,
    found: 0,
    terminalName: 'terminal',
    extensions: [],
    harnessExtensions: [],
    written: [],
    extensionView: null,
    setup: null,
    extensionsRoot: '~/.tade/extensions',
    models: [],
    modelTarget: 'the orchestrator',
    currentModel: null,
    ...over,
  }) as PanelContext

const panelFor = (category: string, over: Partial<SettingsPanel> = {}): SettingsPanel => ({
  ...settingsPanel(category),
  ...over,
})

const drawnAt = (category: string, over: Partial<PanelContext> = {}, panel = panelFor(category)) =>
  drawPanel(panel, context(over)).panel

const plainRows = (drawn: Drawn) => drawn.rows.map((row) => stripTerminalSequences(row))

/** The widths worth trying: from a terminal nobody should use to a wide one. */
const WIDTHS = [40, 48, 56, 64, 72, 80, 96, 104, 120, 160]

describe('the settings form at any width', () => {
  it('draws a box of one width, whatever the terminal is', () => {
    for (const width of WIDTHS) {
      const drawn = drawnAt('telemetry', { width, height: 26 })
      const widths = new Set(plainRows(drawn).map((row) => visibleWidth(row)))
      expect([...widths], `at ${width}`).toHaveLength(1)
      expect([...widths][0], `at ${width}`).toBeLessThanOrEqual(width)
    }
  })

  it('never puts a click where the panel is not', () => {
    for (const width of WIDTHS) {
      const drawn = drawnAt('telemetry', { width, height: 26 })
      const panelWidth = visibleWidth(plainRows(drawn)[0] ?? '')
      for (const hit of drawn.hits) {
        expect(hit.from, `at ${width}`).toBeGreaterThanOrEqual(0)
        expect(hit.to, `at ${width}`).toBeLessThan(panelWidth)
        expect(hit.row, `at ${width}`).toBeLessThan(drawn.rows.length)
      }
    }
  })

  it('keeps a gap between every name and its control, and cuts with an ellipsis', () => {
    for (const width of WIDTHS) {
      for (const group of GROUPS) {
        const drawn = drawnAt(group.id, { width, height: 30 })
        const rows = plainRows(drawn)
        const panelWidth = visibleWidth(rows[0] ?? '')
        const inner = panelWidth - 2
        const side = sideWidth(inner)
        const form = inner - side - 1
        const at = 1 + side + 1
        const layout = formLayout(form, group.settings)
        for (const setting of group.settings) {
          const name = cap(setting.title, layout.label)
          const line = rows.find(
            (row) => sliceByColumn(row, at + 1, layout.label).trimEnd() === name,
          )
          // Long groups do not all fit; what is drawn is what is checked.
          if (!line) continue
          // The name is whole, or it is cut and says so.
          expect(name === setting.title || name.endsWith('…'), `${setting.path} at ${width}`).toBe(
            true,
          )
          // And nothing is written in the columns that keep it apart from
          // whatever comes next — the control beside it, or the panel's own
          // edge where the control went under it instead.
          const gap = sliceByColumn(line, at + 1 + layout.label, layout.stacked ? 1 : 2)
          expect(gap.trim(), `${setting.path} at ${width}`).toBe('')
        }
      }
    }
  })

  it('leaves the control room to be drawn in, or puts it on its own line', () => {
    for (const width of WIDTHS) {
      for (const group of GROUPS) {
        const inner = Math.min(104, Math.max(32, width - 6)) - 2
        const form = inner - sideWidth(inner) - 1
        const layout = formLayout(form, group.settings)
        expect(layout.control, `${group.id} at ${width}`).toBeGreaterThanOrEqual(4)
        if (!layout.stacked) {
          const note = layout.restart ? visibleWidth(layout.restart) + 3 : 0
          expect(1 + layout.label + 2 + layout.control + note, `${group.id} at ${width}`).toBe(form)
        }
      }
    }
  })

  it('lines the switches up in one column, all the same size', () => {
    const drawn = drawnAt('telemetry')
    const switches = drawn.hits.filter(
      (hit) => hit.target.kind === 'control' && hit.target.id.startsWith('toggle:'),
    )
    expect(switches.length).toBeGreaterThan(3)
    expect(new Set(switches.map((hit) => hit.from)).size).toBe(1)
    expect(new Set(switches.map((hit) => hit.to - hit.from)).size).toBe(1)
  })

  it('keeps what a group is about inside the panel, however long it is', () => {
    const drawn = drawnAt('telemetry', { width: 80, height: 26 })
    const rows = plainRows(drawn)
    const said = rows
      .slice(2, 6)
      .map((row) => row.trim())
      .join(' ')
    expect(said).toContain('Tade reporting its own trouble')
    // Cut where it has to be, and never past the edge.
    for (const row of rows) expect(visibleWidth(row)).toBe(visibleWidth(rows[0] ?? ''))
  })

  it('follows the row you are on through a group longer than the panel', () => {
    const shortcuts = GROUPS.find((group) => group.id === 'shortcuts')
    if (!shortcuts) throw new Error('no shortcuts group')
    const last = shortcuts.settings.length - 1
    const drawn = drawnAt(
      'shortcuts',
      { height: 24 },
      panelFor('shortcuts', { row: last, focus: 'form' }),
    )
    const shown = plainRows(drawn).join('\n')
    expect(shown).toContain(cap(shortcuts.settings[last]?.title ?? '', 40))
  })
})

describe('what the pointer says in settings', () => {
  const litBy = (category: string, target: Target, panel = panelFor(category)) =>
    drawPanel(panel, context({ pointer: { hover: target, pressed: null } })).panel.rows.join('\n')

  it('lights everything that can be clicked, in every group', () => {
    for (const category of CATEGORIES) {
      // Nothing in the form is focused, so what lights is the pointer's doing.
      const panel = panelFor(category, { focus: 'categories' })
      const rest = drawPanel(panel, context()).panel
      const targets: Target[] = []
      for (const hit of rest.hits) {
        if (!pressable(hit.target) || hit.target.kind !== 'control') continue
        // The category you are in is already lit, by being the one you are in.
        if (hit.target.id === `category:${category}`) continue
        if (!targets.some((one) => JSON.stringify(one) === JSON.stringify(hit.target)))
          targets.push(hit.target)
      }
      expect(targets.length, category).toBeGreaterThan(2)
      for (const target of targets) {
        expect(litBy(category, target, panel), `${category} ${JSON.stringify(target)}`).not.toBe(
          rest.rows.join('\n'),
        )
      }
    }
  })

  it('lights the whole row a switch is on, and the switch with it', () => {
    const panel = panelFor('telemetry', { focus: 'categories' })
    const target: Target = { kind: 'control', id: 'toggle:telemetry.metrics' }
    const rest = drawPanel(panel, context()).panel
    const lit = drawPanel(panel, context({ pointer: { hover: target, pressed: null } })).panel
    const row = rest.rows.findIndex((line) => stripTerminalSequences(line).includes('Numbers'))
    expect(row).toBeGreaterThan(0)
    // The row is laid on the ground a row under the pointer is laid on.
    expect(lit.rows[row]).toContain('\u001b[48;5;236m')
    // And the switch takes the lighter amber every control takes when pointed at.
    expect(lit.rows[row]).toContain('\u001b[48;5;222m')
    expect(rest.rows[row]).not.toContain('\u001b[48;5;222m')
    // Nothing else moved.
    expect(stripTerminalSequences(lit.rows[row] ?? '')).toBe(
      stripTerminalSequences(rest.rows[row] ?? ''),
    )
  })

  it('makes the whole of a setting its row, so clicking beside it still lands on it', () => {
    const drawn = drawnAt('telemetry')
    const rows = plainRows(drawn)
    const row = rows.findIndex((line) => line.includes('Which Tade this is'))
    const width = visibleWidth(rows[0] ?? '')
    const wide = drawn.hits.filter(
      (hit) =>
        hit.row === row &&
        hit.target.kind === 'control' &&
        hit.target.id.startsWith('row:') &&
        hit.to - hit.from > width / 2,
    )
    expect(wide).toHaveLength(1)
    // Laid under the control, which still takes the click where it is drawn.
    const over = drawn.hits.filter(
      (hit) =>
        hit.row === row && hit.target.kind === 'control' && hit.target.id.startsWith('edit:'),
    )
    expect(over.length).toBeGreaterThan(0)
    expect(drawn.hits.indexOf(over[0] as never)).toBeGreaterThan(
      drawn.hits.indexOf(wide[0] as never),
    )
  })
})

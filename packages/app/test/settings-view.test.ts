import { sliceByColumn, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { ConfigSchema, type SettingGroup, settingsOf } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { pressable, type Target } from '../src/hits.ts'
import { cap, sideWidth } from '../src/panels/cells.ts'
import { drawPanel, type PanelContext } from '../src/panels/context.ts'
import { ITEM } from '../src/panels/frame.ts'
import { PROJECTS, projectHere, projectsIn } from '../src/panels/settings/projects.ts'
import { type SettingsPanel, settingsPanel, visibleSettings } from '../src/panels/settings/state.ts'
import { formLayout } from '../src/panels/settings/view.ts'
import { panelKey } from '../src/panels.ts'
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
const CATEGORIES = [...GROUPS.map((group) => group.id), 'accounts', 'updates']

/** What the Updates page would have read off this machine and the registries. */
const LOOK = {
  at: 0,
  asked: true,
  tade: {
    version: '0.1.0',
    from: 'checkout' as const,
    where: '/Users/me/tade',
    branch: 'main',
    commit: 'f8d73e1',
    install: null,
    newer: 'origin/main is at 1a2b3c4 and this checkout is on f8d73e1',
    cannotTell: null,
    update: { command: 'git -C /Users/me/tade pull --ff-only && pnpm install' },
  },
  programs: [
    {
      need: {
        command: 'git',
        title: 'git',
        versionArgs: ['--version'],
        optional: false,
        needed: [{ what: 'Tade', why: 'every reading of a project', inUse: true }],
        inUse: true,
      },
      install: {
        manager: 'system' as const,
        name: 'git',
        where: '/usr/bin/git',
        said: 'the system’s own',
      },
      version: '2.39.5',
      latest: null,
      cannotTell: 'cannot ask what is current for the system’s own',
      update: { cannot: 'it came with the system, so the system updates it' },
      behind: false,
    },
    {
      need: {
        command: 'tmux',
        title: 'tmux',
        versionArgs: ['-V'],
        optional: false,
        needed: [{ what: 'the tmux driver', why: 'holding every lane', inUse: false }],
        inUse: false,
      },
      install: null,
      version: null,
      latest: null,
      cannotTell: 'it is not on your PATH, so there is nothing here to read a version from',
      update: { cannot: 'nothing on your PATH answers to `tmux`' },
      behind: false,
    },
    {
      need: {
        command: 'pi',
        title: 'pi',
        versionArgs: ['--version'],
        optional: false,
        needed: [{ what: 'pi', why: 'being the agent', inUse: true }],
        inUse: true,
      },
      install: {
        manager: 'pnpm' as const,
        name: '@pi/cli',
        where: '/Users/me/Library/pnpm/global/5/node_modules/@pi/cli/bin/pi.js',
        said: 'a global pnpm package',
      },
      version: '0.9.1',
      latest: '0.9.2',
      cannotTell: null,
      update: { command: 'pnpm add --global @pi/cli@latest' },
      behind: true,
    },
  ],
}

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
    updates: null,
    updatesBusy: false,
    lanesSurvive: false,
    ...over,
  }) as PanelContext

const panelFor = (category: string, over: Partial<SettingsPanel> = {}): SettingsPanel => ({
  ...settingsPanel(category),
  ...over,
})

const drawnAt = (category: string, over: Partial<PanelContext> = {}, panel = panelFor(category)) =>
  drawPanel(panel, context(over)).panel

const plainRows = (drawn: Drawn) => drawn.rows.map((row) => stripTerminalSequences(row))

/**
 * What the drawing says of `value`, read across the rows it took: the longest
 * piece of what is left that each row holds, in order. A value wrapped under
 * its setting is in the picture in pieces, and this is how a test says the
 * whole of it arrived and in what order — the rows themselves hold the
 * sidebar and everything else beside the form.
 */
const readAcross = (rows: readonly string[], value: string): string => {
  let got = ''
  for (const row of rows) {
    for (let len = value.length - got.length; len > 0; len--) {
      // A piece of one or two characters is only believable as the last of
      // them: `05` could be anywhere on a row, but the `05` that finishes the
      // value is what is left of it. A wrap that happens to leave two
      // characters on the last line is a wrap, not a value cut short.
      if (len <= 2 && got.length + len !== value.length) break
      const piece = value.slice(got.length, got.length + len)
      if (row.includes(piece)) {
        got += piece
        break
      }
    }
  }
  return got
}

/** The widths worth trying: from a terminal nobody should use to a wide one. */
const WIDTHS = [40, 48, 56, 64, 72, 80, 96, 104, 120, 160]

describe('the Projects page, which is one project at a time', () => {
  const groups = settingsOf(config)

  it('shows one project’s own answers, and the selector says which', () => {
    // What Configure on a project's tab does, and what the page does on its
    // own: everything that project answers for itself, in one place, written
    // by the same writer. It was three pages — Projects, Checks per project
    // and Budgets — each listing every project.
    const shown = visibleSettings(settingsPanel(PROJECTS, '', 'checkout'), groups).map(
      (setting) => setting.path,
    )
    expect(shown).toEqual([
      'projects.checkout.root',
      'projects.checkout.title',
      'projects.checkout.brief',
      'projects.checkout.workspace',
      'projects.checkout.push',
      'projects.checkout.budget.usd_per_day',
      'projects.checkout.checks.before',
      'projects.checkout.checks.on_red',
      'projects.checkout.checks.parallel',
    ])
    // And only that project's: the row beside it is somebody else's budget.
    expect(shown).not.toContain('projects.search.budget.usd_per_day')
  })

  it('names a project nobody chose, and falls back to one that exists', () => {
    // A project closed while the page is open leaves the page on one there is,
    // rather than on an empty form.
    expect(projectsIn(groups)).toEqual(['checkout', 'search'])
    expect(projectHere('', groups)).toBe('checkout')
    expect(projectHere('gone', groups)).toBe('checkout')
    expect(projectHere('search', groups)).toBe('search')
  })

  it('offers every project to click, and the one you are on is the one drawn', () => {
    const drawn = drawnAt(PROJECTS, {}, panelFor(PROJECTS, { project: 'search' }))
    const ids = drawn.hits
      .map((hit) => (hit.target.kind === 'control' ? hit.target.id : ''))
      .filter((id) => id.startsWith('project:'))
    expect([...new Set(ids)]).toEqual(['project:checkout', 'project:search'])
    // The rows are that project's, and the heading above them is the page's.
    const said = plainRows(drawn).join('\n')
    expect(said).toContain('~/src/search')
    expect(said).not.toContain('~/src/checkout')
  })

  it('walks the projects with the keyboard, above the first row of the form', () => {
    // ↑ from the first setting reaches the selector, ←→ walks it, ↓ goes back
    // into that project's rows — the selector is a pane of the page, not a row
    // of the form, because a selector that scrolls away is one you cannot see
    // the answer of while you read what it chose.
    const inputs = { settings: groups }
    const up = panelKey(panelFor(PROJECTS, { focus: 'form', row: 0 }), 'up', '', inputs)
      .panel as SettingsPanel
    expect(up.focus).toBe('projects')
    const right = panelKey(up, 'right', '', inputs).panel as SettingsPanel
    expect(right.project).toBe('search')
    // Round the list rather than stopping at its end, the way the categories go.
    expect((panelKey(right, 'right', '', inputs).panel as SettingsPanel).project).toBe('checkout')
    const down = panelKey(right, 'down', '', inputs).panel as SettingsPanel
    expect(down).toMatchObject({ focus: 'form', row: 0, project: 'search' })
    // And nowhere else: no other page has a selector to walk into.
    const elsewhere = panelKey(panelFor('telemetry', { focus: 'form', row: 0 }), 'up', '', inputs)
      .panel as SettingsPanel
    expect(elsewhere.focus).toBe('search')
  })

  it('says which project a row is about only where the page cannot', () => {
    // On the page itself the selector says it once. A search crosses projects,
    // so three rows called Brief would be three rows nobody can tell apart.
    const here = plainRows(drawnAt(PROJECTS, {}, panelFor(PROJECTS, { project: 'checkout' })))
    expect(here.join('\n')).toContain('Brief')
    expect(here.join('\n')).not.toContain('checkout — Brief')
    const found = plainRows(drawnAt(PROJECTS, {}, panelFor(PROJECTS, { search: 'brief' })))
    expect(found.join('\n')).toContain('checkout — Brief')
    expect(found.join('\n')).toContain('search — Brief')
  })
})

describe('what the menu down the side is', () => {
  it('has no page of its own for approvals, and asks it where agents are', () => {
    // One setting about agents, on the page about agents: it had a top-level
    // item of its own holding one row.
    expect(GROUPS.map((group) => group.id)).not.toContain('approvals')
    const agents = GROUPS.find((group) => group.id === 'agents')
    expect(agents?.settings.map((one) => one.path)).toContain('approvals.mode')
    // And what search sends is a row of the Window page, which was its own
    // item over one switch.
    expect(GROUPS.map((group) => group.id)).not.toContain('search')
    expect(
      GROUPS.find((group) => group.id === 'window')?.settings.map((one) => one.path),
    ).toContain('surfaces.search.context')
    // Three of them were a list of every project each.
    expect(GROUPS.map((group) => group.id)).not.toContain('project-checks')
    expect(GROUPS.map((group) => group.id)).not.toContain('budgets')
  })

  it('draws every item as tall as it is clickable, the whole width of the list', () => {
    // What "the menu items are hard to click" was: a row of text, one row
    // tall. Every item is `ITEM` rows now, and all of them press the same
    // thing, so there is no half of one that does nothing.
    const drawn = drawnAt('telemetry')
    const width = visibleWidth(plainRows(drawn)[0] ?? '')
    const side = sideWidth(width - 2)
    for (const category of CATEGORIES) {
      const mine = drawn.hits.filter(
        (hit) => hit.target.kind === 'control' && hit.target.id === `category:${category}`,
      )
      if (mine.length === 0) continue
      const where = [...new Set(mine.map((hit) => hit.row))]
      expect(where.length, category).toBe(ITEM)
      // Each of those rows has the whole list under it, so there is no half of
      // an item that does nothing.
      for (const row of where) {
        const widest = mine
          .filter((hit) => hit.row === row)
          .reduce((most, hit) => Math.max(most, hit.to - hit.from + 1), 0)
        expect(widest, `${category} at ${row}`).toBe(side)
      }
    }
  })

  it('makes every setting at least two rows of its own, band and all', () => {
    const drawn = drawnAt('telemetry')
    const rows = new Map<string, number[]>()
    for (const hit of drawn.hits) {
      if (hit.target.kind !== 'control' || !hit.target.id.startsWith('row:')) continue
      rows.set(hit.target.id, [...(rows.get(hit.target.id) ?? []), hit.row])
    }
    expect(rows.size).toBeGreaterThan(3)
    for (const [id, where] of rows) {
      expect(new Set(where).size, id).toBeGreaterThanOrEqual(ITEM)
      // Each of them is a row of the form and nothing else: a run with no gap.
      const sorted = [...new Set(where)].sort((a, b) => a - b)
      expect(sorted.at(-1), id).toBe((sorted[0] ?? 0) + sorted.length - 1)
    }
  })
})

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

  it('puts the group heading over its settings, with no paragraph between', () => {
    const drawn = drawnAt('telemetry', { width: 80, height: 26 })
    const rows = plainRows(drawn)
    const said = rows
      .slice(1, 6)
      .map((row) => row.trim())
      .join(' ')
    // The heading, then the first setting. What the group is about is still
    // written down — it is half of what the search box matches on — and is
    // not three lines of prose over every page.
    expect(said).toContain('Telemetry')
    expect(said).not.toContain('Tade reporting its own trouble')
    expect(said).toContain('Send to')
    // Cut where it has to be, and never past the edge.
    for (const row of rows) expect(visibleWidth(row)).toBe(visibleWidth(rows[0] ?? ''))
  })

  it('keeps a pasted value inside its field, and writes the whole of it out under', () => {
    // A Sentry DSN is seventy characters and the field is forty at its widest,
    // so what is pasted is always wider than what draws it. The whole value is
    // what the panel holds; the field shows the end of it, which is where what
    // you are typing is — and the whole of it is written out under the setting
    // you are on, because a value you cannot read is a value you cannot check
    // for a typo, which is what pasting one into a masked field was.
    const dsn = `https://${'0123456789abcdef'.repeat(2)}@o447951.ingest.sentry.io/4505`
    for (const width of WIDTHS) {
      const drawn = drawnAt(
        'telemetry',
        { width, height: 30 },
        panelFor('telemetry', { editing: { path: 'telemetry.dsn', text: dsn } }),
      )
      const rows = plainRows(drawn)
      const widths = new Set(rows.map((row) => visibleWidth(row)))
      expect([...widths], `at ${width}`).toHaveLength(1)
      // Nothing of it is lost: every character, in order, across the lines it
      // took to write it down.
      expect(readAcross(rows, dsn), `at ${width}`).toBe(dsn)
    }
  })

  it('writes out a long value for the setting you are on, and no other', () => {
    const dsn = `https://${'0123456789abcdef'.repeat(2)}@o447951.ingest.sentry.io/4505`
    const settings = settingsOf(ConfigSchema.parse({ telemetry: { dsn } }))
    const at = (row: number) =>
      plainRows(
        drawnAt('telemetry', { width: 96, height: 30, settings }, panelFor('telemetry', { row })),
      )
    // The setting you are on writes its value out; the page is not a wall of
    // everybody's values, so standing elsewhere leaves the field saying what a
    // field forty columns wide can say — the end of it, behind an ellipsis.
    expect(readAcross(at(0), dsn)).toBe(dsn)
    expect(at(2).join('\n')).not.toContain(dsn.slice(0, 24))
    expect(at(2).join('\n')).toContain('sentry.io/4505')
  })

  it('draws what is pasted into a field that is not a credential', () => {
    const drawn = drawnAt(
      'telemetry',
      { width: 120, height: 30 },
      panelFor('telemetry', {
        editing: { path: 'telemetry.environment', text: 'a-very-long-environment-name' },
      }),
    )
    expect(plainRows(drawn).join('\n')).toContain('a-very-long-environment-name')
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

describe('the Updates page', () => {
  /**
   * The right-hand side, as one flowing string: a sentence that wrapped over
   * three lines is still the sentence somebody reads, and the categories down
   * the left are not part of it.
   */
  const flow = (drawn: Drawn): string => {
    const rows = plainRows(drawn)
    const panelWidth = visibleWidth(rows[0] ?? '')
    const inner = panelWidth - 2
    const side = sideWidth(inner)
    return rows
      .map((row) => sliceByColumn(row, 1 + side + 1, inner - side - 1))
      .join(' ')
      .replace(/\s+/g, ' ')
  }
  const shownAt = (over: Partial<PanelContext> = {}, panel = panelFor('updates')) =>
    flow(drawPanel(panel, context({ updates: LOOK, ...over })).panel)

  it('offers the check before it has asked anybody anything', () => {
    const shown = flow(drawPanel(panelFor('updates'), context()).panel)
    expect(shown).toContain('Check for updates')
    // Nothing has been read yet, and the page says that rather than an empty list.
    expect(shown).toContain('reading this machine')
  })

  it('says which Tade is running, what is newer, and the command that gets it', () => {
    const shown = shownAt()
    expect(shown).toContain('f8d73e1')
    expect(shown).toContain('origin/main is at 1a2b3c4')
    expect(shown).toContain('git -C /Users/me/tade pull --ff-only')
    expect(shown).toContain('Update Tade')
    expect(shown).toContain('Reload Tade')
  })

  it('offers Reload without explaining it: the panel that asks does that', () => {
    // What reloading costs is said at the moment of reloading, by the panel
    // that asks — and that panel opens exactly when reloading would stop
    // something. Said here too, under a button nobody has pressed, it was
    // four lines of prose for everybody who came to read a version number.
    const inside = shownAt({ lanesSurvive: false, running: 3 })
    expect(inside).toContain('Reload Tade')
    expect(inside).not.toContain('stop with it')
    expect(inside).not.toContain('queued work and schedules all survive')
  })

  it('says how a program got here, because that is what decides how it moves forward', () => {
    // The keyboard on pi's button, so the page has scrolled down to it.
    const shown = shownAt({}, panelFor('updates', { focus: 'form', row: 5 }))
    expect(shown).toContain('a global pnpm package')
    expect(shown).toContain('pnpm add --global @pi/cli@latest')
    expect(shown).toContain('0.9.2 is out')
  })

  it('says cannot tell rather than current, and offers no command it is unsure of', () => {
    const shown = shownAt()
    expect(shown).toContain('cannot tell')
    // git came with the system: nothing here pretends to know how to update it.
    expect(shown).not.toContain('brew upgrade git')
    expect(shown).toContain('the system’s own')
  })

  it('lists a program only unused things need, and says nothing in use needs it', () => {
    // tmux has nothing to press, and is still a row the keyboard stops on:
    // otherwise the programs after the last button could not be reached.
    const shown = shownAt({}, panelFor('updates', { focus: 'form', row: 4 }))
    expect(shown).toContain('tmux')
    expect(shown).toContain('nothing here needs it')
    expect(shown).toContain('not installed')
  })

  it('offers a button only where there is an exact command behind it', () => {
    const drawn = drawPanel(
      panelFor('updates', { focus: 'form', row: 5 }),
      context({ updates: LOOK }),
    ).panel
    const ids = drawn.hits
      .map((hit) => (hit.target.kind === 'control' ? hit.target.id : ''))
      .filter((id) => id.startsWith('updates:'))
    expect(ids).toContain('updates:update:pi')
    // Nothing to run for either of these, so nothing to press.
    expect(ids).not.toContain('updates:update:git')
    expect(ids).not.toContain('updates:update:tmux')
  })

  it('counts what could move forward beside the category, and nothing before it is asked', () => {
    const asked = plainRows(drawPanel(panelFor('agents'), context({ updates: LOOK })).panel).join(
      '\n',
    )
    expect(asked).toContain('● 2')
    const unasked = plainRows(drawPanel(panelFor('agents'), context()).panel).join('\n')
    expect(unasked).not.toContain('● 2')
  })
})

import { visibleWidth } from '@earendil-works/pi-tui'
import { ConfigSchema, settingsOf } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { PROJECTS, scopeHere, scopesOf } from '../src/panels/settings/scopes.ts'
import { type SettingsPanel, settingsPanel, visibleSettings } from '../src/panels/settings/state.ts'
import { panelClick, panelKey } from '../src/panels.ts'
import { config, drawnAt, panelFor, plainRows, WIDTHS } from './settings-panel.ts'

// The two Settings pages that are one of many — a project, an intake source —
// and the one selector they share (`panels/settings/scopes.ts`).

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
      'projects.checkout.prepare.command',
      'projects.checkout.prepare.deadline_minutes',
      'projects.checkout.max_parallel',
      'projects.checkout.user',
      'projects.checkout.watches',
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
    expect(scopesOf(PROJECTS, groups).map((one) => one.id)).toEqual(['checkout', 'search'])
    expect(scopeHere('', PROJECTS, groups)).toBe('checkout')
    expect(scopeHere('gone', PROJECTS, groups)).toBe('checkout')
    expect(scopeHere('search', PROJECTS, groups)).toBe('search')
  })

  it('says there are none where there are none, rather than that nothing matched', () => {
    // The words are the group's own (`scoped.none`), and a page with no scope
    // to be on has no rows to show: not an empty form under a selector.
    const empty = settingsOf(ConfigSchema.parse({}))
    expect(scopesOf(PROJECTS, empty)).toEqual([])
    expect(scopeHere('', PROJECTS, empty)).toBeNull()
    expect(visibleSettings(settingsPanel(PROJECTS), empty)).toEqual([])
    const said = plainRows(drawnAt(PROJECTS, { settings: empty })).join('\n')
    expect(said).toContain('No projects are open.')
    expect(said).not.toContain('Nothing here matches.')
  })

  it('offers every project to click, and the one you are on is the one drawn', () => {
    const drawn = drawnAt(PROJECTS, {}, panelFor(PROJECTS, { scope: 'search' }))
    const ids = drawn.hits
      .map((hit) => (hit.target.kind === 'control' ? hit.target.id : ''))
      .filter((id) => id.startsWith('scope:'))
    expect([...new Set(ids)]).toEqual(['scope:checkout', 'scope:search'])
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
    expect(up.focus).toBe('scopes')
    const right = panelKey(up, 'right', '', inputs).panel as SettingsPanel
    expect(right.scope).toBe('search')
    // Round the list rather than stopping at its end, the way the categories go.
    expect((panelKey(right, 'right', '', inputs).panel as SettingsPanel).scope).toBe('checkout')
    const down = panelKey(right, 'down', '', inputs).panel as SettingsPanel
    expect(down).toMatchObject({ focus: 'form', row: 0, scope: 'search' })
    // And nowhere else but Intake: no other page has a selector to walk into.
    const elsewhere = panelKey(panelFor('telemetry', { focus: 'form', row: 0 }), 'up', '', inputs)
      .panel as SettingsPanel
    expect(elsewhere.focus).toBe('search')
  })

  it('says which project a row is about only where the page cannot', () => {
    // On the page itself the selector says it once. A search crosses projects,
    // so three rows called Brief would be three rows nobody can tell apart.
    const here = plainRows(drawnAt(PROJECTS, {}, panelFor(PROJECTS, { scope: 'checkout' })))
    expect(here.join('\n')).toContain('Brief')
    expect(here.join('\n')).not.toContain('checkout — Brief')
    const found = plainRows(drawnAt(PROJECTS, {}, panelFor(PROJECTS, { search: 'brief' })))
    expect(found.join('\n')).toContain('checkout — Brief')
    expect(found.join('\n')).toContain('search — Brief')
  })
})

describe('the Intake page, which is one source at a time', () => {
  // It was thirty-three switches on one page, each with its source's name in
  // its title. The Projects page had already answered that shape, so Intake is
  // the same selector over the same rows: a source, then that source's own.
  const groups = settingsOf(config)
  const INTAKE = 'intake'
  const inputs = { settings: groups }

  it('offers every source as a tab, in the order the sources are declared', () => {
    expect(scopesOf(INTAKE, groups)).toEqual([
      { id: 'cli', title: 'Local door' },
      { id: 'github', title: 'GitHub' },
      { id: 'slack', title: 'Slack' },
      { id: 'linear', title: 'Linear' },
    ])
    const drawn = drawnAt(INTAKE, {}, panelFor(INTAKE, { scope: 'github' }))
    const ids = drawn.hits
      .map((hit) => (hit.target.kind === 'control' ? hit.target.id : ''))
      .filter((id) => id.startsWith('scope:'))
    expect([...new Set(ids)]).toEqual(['scope:cli', 'scope:github', 'scope:slack', 'scope:linear'])
    // Led by the word for where work comes from, and every tab its title.
    const said = plainRows(drawn).join('\n')
    expect(said).toMatch(/from +.*Local door.*GitHub.*Slack.*Linear/)
  })

  it('shows one source’s own rows, under the surface’s own switch', () => {
    const shown = visibleSettings(settingsPanel(INTAKE, '', 'slack'), groups).map(
      (setting) => setting.path,
    )
    expect(shown).toEqual([
      // On every source's page, because every source is behind it.
      'surfaces.intake.enabled',
      'surfaces.intake.sources.slack.accept',
      'surfaces.intake.sources.slack.projects',
      'surfaces.intake.sources.slack.from',
      'surfaces.intake.sources.slack.mode',
      'surfaces.intake.sources.slack.template',
      'surfaces.intake.sources.slack.document',
      'surfaces.intake.sources.slack.reply',
      'surfaces.intake.sources.slack.names',
    ])
    // Nobody chose, so the first; and one that is not a source is the first too.
    expect(visibleSettings(settingsPanel(INTAKE), groups)[1]?.path).toBe(
      'surfaces.intake.sources.cli.accept',
    )
    expect(scopeHere('jira', INTAKE, groups)).toBe('cli')
  })

  it('names each setting and never the source, which the selector says once', () => {
    const here = plainRows(drawnAt(INTAKE, {}, panelFor(INTAKE, { scope: 'github' }))).join('\n')
    expect(here).toContain('Accept requests')
    expect(here).toContain('Whose requests count')
    expect(here).not.toContain('Accept from github')
    expect(here).not.toContain('github — Accept requests')
    // A search crosses sources, so there each row says whose it is.
    const found = plainRows(drawnAt(INTAKE, {}, panelFor(INTAKE, { search: 'whose requests' })))
    expect(found.join('\n')).toContain('github — Whose requests count')
    expect(found.join('\n')).toContain('slack — Whose requests count')
  })

  it('walks the sources with the keyboard and the pointer, as Projects does', () => {
    const up = panelKey(panelFor(INTAKE, { focus: 'form', row: 0 }), 'up', '', inputs)
      .panel as SettingsPanel
    expect(up.focus).toBe('scopes')
    const right = panelKey(up, 'right', '', inputs).panel as SettingsPanel
    expect(right.scope).toBe('github')
    const left = panelKey(up, 'left', '', inputs).panel as SettingsPanel
    expect(left.scope).toBe('linear')
    const clicked = panelClick(panelFor(INTAKE, { row: 4 }), 'scope:slack', inputs)
      .panel as SettingsPanel
    expect(clicked).toMatchObject({ scope: 'slack', row: 0, focus: 'scopes' })
    // Another page is another list, so it opens on its own first.
    const away = panelClick(clicked, `category:${PROJECTS}`, inputs).panel as SettingsPanel
    expect(away.scope).toBe('')
    expect(visibleSettings(away, groups)[0]?.path).toBe('projects.checkout.root')
  })

  it('holds the geometry at every width, selector and all', () => {
    for (const width of WIDTHS) {
      const drawn = drawnAt(INTAKE, { width }, panelFor(INTAKE, { scope: 'linear' }))
      const widths = new Set(plainRows(drawn).map((row) => visibleWidth(row)))
      expect(widths.size, `width ${width}`).toBe(1)
    }
  })
})

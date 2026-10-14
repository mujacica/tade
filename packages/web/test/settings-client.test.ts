import { ConfigSchema, settingsOf } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { afterAnswer, settingStanding } from '../src/assets/acts.js'
import { ICONS } from '../src/assets/icons.js'
import {
  afterChange,
  CUT_FROM,
  capsOf,
  drawnOf,
  editorOf,
  emptyLabel,
  factsOf,
  finds,
  firstChosen,
  foundIn,
  GROUP_ICONS,
  groupSaid,
  HERE,
  hereOf,
  iconOf,
  KEYS_SAID,
  leftSaid,
  missedBox,
  PICK_MOST,
  pageState,
  partsOf,
  pressWord,
  queryOf,
  settingsWord,
  totalOf,
  typedSaid,
} from '../src/assets/pages/settings-shape.js'
import { TROUBLES } from '../src/assets/trouble.js'
import { type SettingOut, type SettingsOut, settingsFor } from '../src/configuring.ts'
import type { Reach } from '../src/reach.ts'

// What the settings page draws, against **what the machine actually sends**:
// the rows are `settingsOf`'s own over a parsed config, through `settingsFor`,
// the function `/api/settings` answers with — so a field either renames is a
// red test here rather than a blank row on a phone. And the page's two rules
// about what it may say: a key is never in it, and a device that may change
// nothing is told nothing about controls.

const KEY = 'jev_live_7fd1c0a9e2b84f6d93a51c2e8b7d4f00'
const DEVICE = 'a1b2c3d4e5f60718'

const ROWS = settingsOf(
  ConfigSchema.parse({
    projects: {
      app: { root: '/Users/kim/src/app', push: 'branch' },
      site: { root: '/Users/kim/src/site' },
      ledger: { root: '/Users/kim/src/ledger' },
    },
    surfaces: { window: { editor: 'zed' } },
    agents: { instructions: 'Run the checks before you say you are done.' },
  }),
  [
    { path: 'extensions.jev.key', title: 'Jev API key', means: '', value: KEY, from: null },
    { path: 'extensions.github.token', title: 'GitHub token', means: '', value: '', from: null },
  ],
)

function reach(over: Partial<Reach> = {}): Reach {
  return { device: DEVICE, projects: { kind: 'every' }, granted: ['settings'], ...over }
}

/** What `/api/settings` answers a device with this reach. */
function answer(over: Partial<Reach> = {}): SettingsOut {
  return settingsFor(ROWS, reach(over), [])
}

const ALL = answer()
const EVERY = ALL.groups.flatMap((group) => group.settings)
const OFFLINE = TROUBLES.offline as { title: string; fix: string }
const MAY = { configure: true }
const MAY_NOT = { configure: false }

function row(path: string): SettingOut {
  const found = EVERY.find((one) => one.path === path)
  if (found === undefined) throw new Error(`no row for ${path}`)
  return found
}

function group(id: string) {
  const found = ALL.groups.find((one) => one.id === id)
  if (found === undefined) throw new Error(`no group ${id}`)
  return found
}

describe('a row’s value, as its line draws it', () => {
  it('says a key as whether one is held, and nothing of it, anywhere', () => {
    expect(drawnOf(row('extensions.jev.key'))).toMatchObject({
      kind: 'held',
      text: 'set',
      on: true,
    })
    expect(drawnOf(row('extensions.github.token'))).toMatchObject({
      kind: 'held',
      text: 'not set',
      on: false,
    })
    // Every word the page could draw for every row, opened or not.
    const drawn = EVERY.flatMap((one) => [
      drawnOf(one).text,
      ...drawnOf(one).caps,
      ...factsOf(one).map(([, value]) => value ?? ''),
      ...editorOf(one).options.map((option) => option.label),
    ])
    expect(drawn.join('\n')).not.toContain(KEY)
  })

  it('draws a value nothing set as its fallback, marked default and never in mono', () => {
    const one = row('agents.push')
    expect(one.shown).toBe('')
    expect(drawnOf(one)).toMatchObject({ kind: 'default', text: one.fallback, mono: false })
    expect(drawnOf(one).tag).toBe('default')
    // A fallback with no words is said as that, not as a blank — and not
    // twice, as *nothing set default*.
    expect(drawnOf({ ...one, fallback: '' })).toMatchObject({ text: 'nothing set', tag: null })
    expect(drawnOf(row('surfaces.window.editor')).tag).toBeNull()
  })

  it('reads a flag as on or off, and its fallback too', () => {
    const flag = EVERY.find((one) => one.kind === 'flag' && one.shown === 'true')
    expect(flag).toBeDefined()
    expect(drawnOf(flag as SettingOut)).toMatchObject({ kind: 'flag', text: 'on', on: true })
    expect(drawnOf({ ...(flag as SettingOut), shown: 'false' }).text).toBe('off')
    expect(drawnOf({ ...(flag as SettingOut), shown: '', fallback: 'false' }).text).toBe('off')
  })

  it('draws a key combination as its caps', () => {
    const key = EVERY.find((one) => one.kind === 'key' && one.shown.includes('+'))
    expect(key).toBeDefined()
    expect(drawnOf(key as SettingOut).caps).toEqual((key as SettingOut).shown.split('+'))
    expect(capsOf('ctrl+shift+e')).toEqual(['ctrl', 'shift', 'e'])
    expect(capsOf('ctrl+,')).toEqual(['ctrl', ','])
    // A `+` that is the key itself is one cap, never a cap with nothing on it.
    expect(capsOf('ctrl++')).toEqual(['ctrl++'])
  })

  it('sets what somebody typed in mono, and Tade’s own words in the page’s face', () => {
    expect(drawnOf(row('agents.instructions')).mono).toBe(true)
    expect(drawnOf(row('surfaces.window.editor')).mono).toBe(false)
  })
})

describe('an opened row', () => {
  it('says the value whole only where its line could not', () => {
    const facts = (path: string) => Object.fromEntries(factsOf(row(path)))
    // `zed` is on the line already.
    expect(facts('surfaces.window.editor').Now).toBeNull()
    // Typed text may be cut on the line, and nothing set says so in words.
    expect(facts('agents.instructions').Now).toBe(row('agents.instructions').shown)
    expect(facts('agents.push').Now).toBe('nothing set')
    const long = { ...row('surfaces.window.editor'), shown: 'x'.repeat(CUT_FROM + 1) }
    expect(Object.fromEntries(factsOf(long)).Now).toBe(long.shown)
  })

  it('says when a change applies, and what applies with nothing set', () => {
    const facts = Object.fromEntries(factsOf(row('agents.push')))
    expect(facts.Applies).toBe('at once')
    expect(facts['With nothing set']).toBe(row('agents.push').fallback)
    const later = EVERY.find((one) => !one.live) as SettingOut
    expect(Object.fromEntries(factsOf(later)).Applies).toBe('when Tade next starts')
  })

  it('says nothing of a key but that it is never shown', () => {
    expect(factsOf(row('extensions.jev.key')).filter(([, value]) => value !== null)).toEqual([
      ['Applies', 'at once'],
    ])
    expect(KEYS_SAID).toContain('never shown')
  })
})

describe('changing one', () => {
  it('offers exactly the rows the machine says may be changed, and only to a device that may', () => {
    expect(hereOf(ALL, MAY_NOT)).toEqual([])
    expect(hereOf(ALL, null)).toEqual([])
    const here = hereOf(ALL, MAY)
    expect(here.map((one) => one.row.path).sort()).toEqual(
      EVERY.filter((one) => one.may === 'change')
        .map((one) => one.path)
        .sort(),
    )
    // The window's three and each project's push mode — `settingReach`'s open tier.
    expect(here.map((one) => one.row.path)).toContain('surfaces.window.editor')
    expect(here.map((one) => one.row.path)).toContain('projects.app.push')
    for (const one of here) expect(settingStanding(one.row, MAY).kind).toBe('yes')
  })

  it('says what each is one of, out of its group', () => {
    const crumbs = Object.fromEntries(hereOf(ALL, MAY).map((one) => [one.row.path, one.crumb]))
    expect(crumbs['surfaces.window.editor']).toBe('Window')
    expect(crumbs['projects.app.push']).toBe('app')
  })

  it('offers nothing of a project this device does not read', () => {
    const narrow = answer({ projects: { kind: 'listed', names: ['app'] } })
    const paths = hereOf(narrow, MAY).map((one) => one.row.path)
    expect(paths).toContain('projects.app.push')
    expect(paths).not.toContain('projects.site.push')
    expect(leftSaid(narrow)).toMatch(/^\d+ settings of projects this device does not read/)
  })

  it('draws each changeable row with a control its value fits', () => {
    // A push mode: four options on the screen at once, the empty one named
    // as the window names it.
    const push = editorOf(row('projects.app.push'))
    expect(push.kind).toBe('pick')
    expect(push.options[0]).toEqual({
      value: '',
      label: emptyLabel(row('projects.app.push')),
    })
    expect(emptyLabel(row('projects.app.push'))).toBe('as all projects do (never)')
    expect(emptyLabel(row('agents.push'))).toBe('as it comes (never)')
    // Ten editors are one box that opens.
    const editor = editorOf(row('surfaces.window.editor'))
    expect(editor.kind).toBe('list')
    expect(editor.options.length).toBeGreaterThan(PICK_MOST)
    expect(editorOf(row('surfaces.window.strip_height')).kind).toBe('number')
    expect(editorOf(row('extensions.jev.key')).kind).toBe('clear')
    const flag = EVERY.find((one) => one.kind === 'flag') as SettingOut
    expect(editorOf(flag).options.map((one) => one.value)).toEqual(['true', 'false'])
    // Every option offered is one the machine takes exactly.
    for (const one of hereOf(ALL, MAY)) {
      for (const option of editorOf(one.row).options) {
        if (one.row.kind === 'choice') expect(one.row.options).toContain(option.value)
      }
    }
  })

  it('says an empty box before sending it, since the machine takes no empty value from away', () => {
    expect(typedSaid({ kind: 'number', options: [] }, '  ')).toBe('Type a new value first.')
    expect(typedSaid({ kind: 'number', options: [] }, '12')).toBeNull()
    expect(typedSaid({ kind: 'pick', options: [] }, '')).toBeNull()
  })

  it('empties a box only on a 200, and keeps what was typed when the world moved', () => {
    const editor = row('surfaces.window.editor')
    const height = row('surfaces.window.strip_height')
    // Each answer through the page's own reading of it (`afterAnswer`).
    const ok = (rev: string) => afterAnswer({ status: 200, body: { rev, said: 'Saved.' } }, '')
    const moved = (rev: string) =>
      afterAnswer({ status: 409, body: { error: 'gone', rev } }, 'it moved')
    expect(afterChange(editor, editorOf(editor), 'vim', ok('vim'))).toEqual({
      row: { was: 'vim', shown: 'vim', held: null },
      sync: true,
      clear: false,
    })
    // A typed box: a 200 empties it, a 409 writes what is true now and leaves it.
    expect(afterChange(height, editorOf(height), '14', ok('14')).clear).toBe(true)
    expect(afterChange(height, editorOf(height), '12', moved('12'))).toEqual({
      row: { was: '12', shown: '12', held: null },
      sync: false,
      clear: false,
    })
    // A refusal that is trouble changes nothing, and neither does a body
    // with no revision in it.
    const refused = afterAnswer({ status: 403, body: { error: 'out_of_scope' } }, 'no')
    expect(afterChange(height, editorOf(height), '9', refused)).toEqual({
      row: null,
      sync: false,
      clear: false,
    })
    expect(afterChange(height, editorOf(height), undefined, ok('x')).row).toBeNull()
  })

  it('writes a key’s row as held or not, never as whatever the body said', () => {
    const key = row('extensions.jev.key')
    const cleared = afterChange(
      key,
      editorOf(key),
      'not set',
      afterAnswer({ status: 200, body: { rev: 'not set' } }, ''),
    )
    expect(cleared.row).toEqual({ was: 'not set', shown: '', held: 'not set' })
    const odd = afterChange(
      key,
      editorOf(key),
      KEY,
      afterAnswer({ status: 200, body: { rev: KEY } }, ''),
    )
    expect(odd.row?.held).toBe('not set')
    expect(odd.row?.shown).toBe('')
  })

  it('asks twice, and says what the second press does', () => {
    const pick = { kind: 'pick' as const, options: [] }
    expect(pressWord(pick, false, false)).toBe('Save')
    expect(pressWord(pick, true, false)).toBe('Tap again to save')
    expect(pressWord(pick, false, true)).toBe('Saving…')
    expect(pressWord({ kind: 'clear', options: [] }, true, false)).toBe('Tap again to clear it')
  })
})

describe('the groups', () => {
  it('draws one project at a time', () => {
    const parts = partsOf(group('projects'))
    expect(parts.own).toEqual([])
    expect(parts.scopes.map((one) => one.key)).toEqual(['app', 'site', 'ledger'])
    expect(new Set(parts.scopes.map((one) => one.rows.length)).size).toBe(1)
  })

  it('draws one intake source at a time, with the surface’s own switch above them', () => {
    // The wire names no scope for a source, and four rows called *Accept
    // requests* are four rows nobody can tell apart.
    const parts = partsOf(group('intake'))
    expect(parts.own.map((one) => one.path)).toEqual(['surfaces.intake.enabled'])
    expect(parts.scopes.map((one) => one.key).sort()).toEqual(['cli', 'github', 'linear', 'slack'])
    for (const scope of parts.scopes) {
      expect(new Set(scope.rows.map((one) => one.title)).size).toBe(scope.rows.length)
    }
  })

  it('leaves a group of different settings as one list', () => {
    for (const id of ['agents', 'window', 'away', 'telemetry', 'shortcuts']) {
      expect(partsOf(group(id)).scopes, id).toEqual([])
    }
  })

  it('counts its settings, and what may be changed only to a device that may', () => {
    expect(groupSaid(group('agents'), MAY)).toBe(settingsWord(group('agents').settings.length))
    expect(groupSaid(group('window'), MAY)).toBe(
      `${settingsWord(group('window').settings.length)} · 3 you can change`,
    )
    for (const one of ALL.groups) expect(groupSaid(one, MAY_NOT)).not.toContain('change')
    expect(settingsWord(1)).toBe('1 setting')
  })

  it('draws every group with a mark the sprite has, and a new one with the settings mark', () => {
    for (const one of ALL.groups) expect(Object.keys(GROUP_ICONS), one.id).toContain(one.id)
    for (const drawn of Object.values(GROUP_ICONS)) expect(ICONS).toContain(drawn)
    expect(iconOf('from-an-extension')).toBe('settings')
  })
})

describe('finding one', () => {
  it('finds by every word, in any case, in the name, the meaning, the value or the scope', () => {
    const words = queryOf('  Pushed   APP ')
    expect(words).toEqual(['pushed', 'app'])
    const projects = group('projects')
    expect(
      projects.settings.filter((one) => finds(one, projects, words)).map((one) => one.path),
    ).toEqual(['projects.app.push'])
    expect(finds(row('surfaces.window.editor'), group('window'), queryOf('zed'))).toBe(true)
    expect(finds(row('surfaces.window.editor'), group('window'), [])).toBe(true)
  })

  it('counts what it found per group, and says a search that found nothing as that', () => {
    expect(foundIn(group('window'), queryOf('editor'))).toBe(1)
    expect(groupSaid(group('window'), MAY, queryOf('editor'))).toBe(
      `1 of ${settingsWord(group('window').settings.length)}`,
    )
    const box = missedBox(' nope ')
    expect(box.kind).toBe('empty')
    expect(box.title).toBe('No setting matches “nope”')
  })
})

describe('the page’s four states', () => {
  it('is coming before the machine answers, and wrong in trouble’s own words', () => {
    expect(pageState(null, null).kind).toBe('coming')
    const wrong = pageState(null, OFFLINE)
    expect(wrong.kind).toBe('wrong')
    expect(wrong.box).toMatchObject({
      kind: 'error',
      title: OFFLINE.title,
      line: OFFLINE.fix,
      retry: true,
    })
  })

  it('says not granted and nothing here as two different things', () => {
    const ungranted = pageState(answer({ granted: [] }), null)
    expect(ungranted.kind).toBe('ungranted')
    expect(ungranted.box?.title).toContain('not granted')
    // A device granted the settings and reading none is never told it was
    // not granted — that is the browser harness's `granted` check.
    const none = pageState({ granted: true, groups: [], withheld: 0 }, null)
    expect(none.kind).toBe('nothing')
    expect(`${none.box?.title} ${none.box?.line}`).not.toContain('not granted')
    expect(pageState({ granted: true, groups: [], withheld: 4 }, null).box?.line).toBe(
      leftSaid({ granted: true, groups: [], withheld: 4 }),
    )
    expect(pageState(ALL, null)).toEqual({ kind: 'ready', box: null })
  })

  it('counts what it holds, and what another project’s left out', () => {
    expect(totalOf(ALL)).toBe(EVERY.length)
    expect(totalOf(null)).toBeNull()
    expect(leftSaid(ALL)).toBeNull()
    expect(leftSaid({ granted: true, groups: [], withheld: 1 })).toBe(
      '1 setting of a project this device does not read is not here.',
    )
  })

  it('opens a desk on what may be changed, where anything may, and else on the first group', () => {
    expect(firstChosen(ALL, MAY)).toBe(HERE)
    expect(firstChosen(ALL, MAY_NOT)).toBe(ALL.groups[0]?.id)
  })
})

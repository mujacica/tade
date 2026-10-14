// The settings page's pure half: what a row's value is drawn as, which rows are
// one project's or one source's, what a search finds, what this device may
// change from here, and which of its four states the page is in.
//
// **No DOM and no clock**, so `test/settings-client.test.ts` can hold every
// word and every decision against what `/api/settings` actually sends — the
// rows come out of `settingsFor` over `settingsOf`'s own groups there, so a
// field either renames is a red test rather than a blank row on a phone.
//
// **Nothing here decides what a device may do.** Whether a row has a control
// is `settingStanding`'s, off the row's own `may` and `was` and this device's
// own scopes, and the machine asks `settingReach` again at the write. This
// file only says how to draw what the wire already answered.

import { settingStanding } from '../acts.js'

/**
 * Each group's mark, by the group's stable id; a group nobody named here — one
 * an extension adds tomorrow — is drawn with the settings mark rather than
 * nothing. A mark is decoration beside the group's title, never instead of it.
 */
export const GROUP_ICONS = {
  agents: 'agents',
  models: 'bolt',
  orchestrator: 'spark',
  queue: 'queue',
  checks: 'checks',
  voice: 'talk',
  window: 'laptop',
  away: 'devices',
  intake: 'inbox',
  projects: 'folder',
  journal: 'notes',
  telemetry: 'alert',
  credentials: 'scan',
  shortcuts: 'arrow',
}

export function iconOf(id) {
  return GROUP_ICONS[id] ?? 'settings'
}

/** The index's own entry for what this device may change, ahead of the groups. */
export const HERE = 'here'

/** The sentence a key's row says about itself, said where somebody opens one. */
export const KEYS_SAID = 'A key or a token is said as set or not set, and never shown here.'

/** A flag's two values, in the words a switch is read in. */
function flagWord(value) {
  if (value === 'true') return 'on'
  if (value === 'false') return 'off'
  return value
}

/**
 * The parts of a key combination, one cap each: `ctrl+shift+e` is three. A
 * combination with an empty part — a `+` that is the key itself — is one cap
 * as written, rather than a cap with nothing on it.
 */
export function capsOf(value) {
  const parts = value.split('+')
  return parts.some((one) => one === '') ? [value] : parts
}

/**
 * What a row's value is drawn as.
 *
 * - `held`: a key — `set` or `not set`, and nothing of the key, which the
 *   machine never sent.
 * - `default`: nothing is set, so what applies is the fallback, drawn quiet
 *   with the word *default* (`tag`) beside it.
 * - `flag`: `on` or `off`.
 * - `keys`: a key combination, as caps.
 * - `words`: anything else, in mono where it is text somebody typed or a
 *   model's name — the two kinds that are also text in the window.
 */
export function drawnOf(row) {
  const mono = row.kind === 'text' || row.kind === 'model'
  if (row.held !== null && row.held !== undefined) {
    return {
      kind: 'held',
      text: row.held,
      tag: null,
      on: row.held === 'set',
      mono: false,
      caps: [],
    }
  }
  if (row.shown === '') {
    const fallback = row.kind === 'flag' ? flagWord(row.fallback) : row.fallback
    // A fallback is Tade's own words — *the harness decides*, *no budget* —
    // and never text somebody typed, so it is never in mono.
    return {
      kind: 'default',
      text: fallback === '' ? 'nothing set' : fallback,
      // *Default* is said beside what applies instead, and *nothing set* is
      // already the whole of what it would say.
      tag: fallback === '' ? null : 'default',
      on: false,
      mono: false,
      caps: row.kind === 'key' && fallback !== '' ? capsOf(fallback) : [],
    }
  }
  if (row.kind === 'flag') {
    return {
      kind: 'flag',
      text: flagWord(row.shown),
      on: row.shown === 'true',
      mono: false,
      caps: [],
    }
  }
  if (row.kind === 'key') {
    return {
      kind: 'keys',
      text: row.shown,
      tag: null,
      on: false,
      mono: false,
      caps: capsOf(row.shown),
    }
  }
  return { kind: 'words', text: row.shown, tag: null, on: false, mono, caps: [] }
}

/**
 * The value, whole, as the line under an opened row says it: what is set, or
 * that nothing is and what applies instead.
 */
export function nowSaid(row) {
  if (row.held !== null && row.held !== undefined) return row.held
  if (row.shown !== '') return row.kind === 'flag' ? flagWord(row.shown) : row.shown
  return 'nothing set'
}

/** When a change to this row takes effect. */
export function appliesSaid(row) {
  return row.live ? 'at once' : 'when Tade next starts'
}

/** How long a value may be before its line could cut it, and the opened row says it whole. */
export const CUT_FROM = 16

/**
 * The lines an opened row says, as `dlIn` takes them: what it is now — only
 * where the line could not say it whole, or says a fallback in its place —
 * what applies with nothing set, and when a change applies. A key says
 * nothing of either, because its line already said whether one is held and a
 * fallback is where a key would be kept.
 */
export function factsOf(row) {
  const key = row.held !== null && row.held !== undefined
  const fallback = row.kind === 'flag' ? flagWord(row.fallback) : row.fallback
  const cut = row.kind === 'text' || row.kind === 'model' || row.shown.length > CUT_FROM
  return [
    ['Now', !key && (row.shown === '' || cut) ? nowSaid(row) : null],
    ['With nothing set', key || fallback === '' ? null : fallback],
    ['Applies', appliesSaid(row)],
  ]
}

/**
 * What the empty option of a choice is called: the answer somebody else
 * already gave, and what it is right now — *as all projects do* for one
 * project's own row, *as it comes* for the machine's (the window's words,
 * `emptyMeans` in the app's settings control).
 */
export function emptyLabel(row) {
  const as = row.scope === null || row.scope === undefined ? 'as it comes' : 'as all projects do'
  return row.fallback === '' ? as : `${as} (${row.fallback})`
}

/** How many options are drawn as a list of choices before it is one box that opens. */
export const PICK_MOST = 5

/**
 * The control a row that may be changed is drawn with.
 *
 * - `pick`: every option on the screen at once, one tap each — a flag, and a
 *   choice of up to `PICK_MOST`.
 * - `list`: one box that opens, for a longer choice (ten editors).
 * - `number`, `text`: a box to type in.
 * - `clear`: a key, which a device was never shown and so may only clear.
 */
export function editorOf(row) {
  if (row.held !== null && row.held !== undefined) return { kind: 'clear', options: [] }
  if (row.kind === 'flag') {
    return {
      kind: 'pick',
      options: [
        { value: 'true', label: 'on' },
        { value: 'false', label: 'off' },
      ],
    }
  }
  if (row.kind === 'choice') {
    const options = row.options.map((value) => ({
      value,
      label: value === '' ? emptyLabel(row) : value,
    }))
    return { kind: options.length <= PICK_MOST ? 'pick' : 'list', options }
  }
  if (row.kind === 'number') return { kind: 'number', options: [] }
  return { kind: 'text', options: [] }
}

/**
 * What a typed box says before anything is sent, or null where it may be.
 * A box with nothing in it is not a value the machine takes from away — it
 * asks for one exactly — so it is said here rather than sent to be refused.
 */
export function typedSaid(editor, value) {
  if (editor.kind !== 'number' && editor.kind !== 'text') return null
  return value.trim() === '' ? 'Type a new value first.' : null
}

/** The press's word: once to ask, again to send, and nothing while it goes. */
export function pressWord(editor, armed, going) {
  if (going) return 'Saving…'
  if (editor.kind === 'clear') return armed ? 'Tap again to clear it' : 'Clear it'
  return armed ? 'Tap again to save' : 'Save'
}

/**
 * A group's rows, split into its own and each scope's.
 *
 * **One project at a time, or one source**, the way the window draws them:
 * ten projects of ten settings each is a hundred rows somebody cannot find one
 * of. A row is a scope's when the wire says which project it is, or when its
 * title is said more than once in the group — four intake sources each have an
 * *Accept requests* — and then its scope is the part of its path that names
 * it. The rest are the group's own, on every scope's page.
 */
export function partsOf(group) {
  const said = new Map()
  for (const row of group.settings) said.set(row.title, (said.get(row.title) ?? 0) + 1)
  const own = []
  const scopes = []
  for (const row of group.settings) {
    const scoped = (row.scope !== null && row.scope !== undefined) || (said.get(row.title) ?? 0) > 1
    if (!scoped) {
      own.push(row)
      continue
    }
    const key = row.scope ?? placeOf(row.path)
    let scope = scopes.find((one) => one.key === key)
    if (scope === undefined) {
      scope = { key, rows: [] }
      scopes.push(scope)
    }
    scope.rows.push(row)
  }
  return { own, scopes }
}

/** The part of a dotted path that names what a row is one of: `github` in `…sources.github.accept`. */
function placeOf(path) {
  return path.split('.').at(-2) ?? path
}

/** What a search is, as it is compared: lowercase words. */
export function queryOf(typed) {
  return typed.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Whether a row is one a search finds: every word somewhere in its name, what
 * it means, its value, its fallback, its scope, its group or its path.
 */
export function finds(row, group, words) {
  if (words.length === 0) return true
  const hay = [
    row.title,
    row.means,
    row.shown,
    row.fallback,
    row.scope ?? '',
    row.held ?? '',
    group.title,
    row.path,
  ]
    .join(' ')
    .toLowerCase()
  return words.every((word) => hay.includes(word))
}

/** How many of a group's rows a search finds. */
export function foundIn(group, words) {
  return group.settings.filter((row) => finds(row, group, words)).length
}

/** `1 setting`, `12 settings`. */
export function settingsWord(n) {
  return n === 1 ? '1 setting' : `${n} settings`
}

/**
 * Every row this device may change, wherever its group is: the lead's list.
 * Each carries what it is one of — its project, or its group's name — since a
 * row out of its group is otherwise a name nobody can place.
 */
export function hereOf(answer, acts) {
  if (answer === null || answer?.granted !== true) return []
  const rows = []
  for (const group of answer.groups) {
    for (const row of group.settings) {
      if (settingStanding(row, acts).kind !== 'yes') continue
      rows.push({ row, group, crumb: row.scope ?? group.title })
    }
  }
  return rows
}

/** How many of a group's rows this device may change. */
export function changeableIn(group, acts) {
  return group.settings.filter((row) => settingStanding(row, acts).kind === 'yes').length
}

/**
 * A group's line under its name: how many settings, and how many of them this
 * device may change — said only to a device that may change any, because to
 * one that may not, a count of controls is a map of what else to ask for.
 */
export function groupSaid(group, acts, words = []) {
  const n = group.settings.length
  if (words.length > 0) return `${foundIn(group, words)} of ${settingsWord(n)}`
  const here = changeableIn(group, acts)
  return here === 0 ? settingsWord(n) : `${settingsWord(n)} · ${here} you can change`
}

/** How many settings the answer holds. */
export function totalOf(answer) {
  if (answer === null || answer?.granted !== true) return null
  return answer.groups.reduce((sum, group) => sum + group.settings.length, 0)
}

/** The line under the groups about another project's settings, or null with none. */
export function leftSaid(answer) {
  const n = answer?.withheld ?? 0
  if (n === 0) return null
  return n === 1
    ? '1 setting of a project this device does not read is not here.'
    : `${n} settings of projects this device does not read are not here.`
}

/**
 * Which of its four states the page is in, and what its box says.
 *
 * `coming` before the machine answers; `wrong` when the asking failed (the
 * words are `trouble.js`'s, handed in); `ungranted` for a device that was not
 * granted reading the settings — said as that, never as *nothing*; `nothing`
 * for a device that may read them and reads none; and `ready`.
 */
export function pageState(answer, trouble) {
  if (trouble !== null && trouble !== undefined) {
    return { kind: 'wrong', box: boxOf('error', trouble.title, trouble.fix, true) }
  }
  if (answer === null || answer === undefined) {
    return { kind: 'coming', box: boxOf('loading', 'Asking for the settings…', null) }
  }
  if (answer.granted !== true) {
    return {
      kind: 'ungranted',
      box: boxOf(
        'empty',
        'Settings are not granted to this device',
        'Reading them is granted at this machine, from the away panel.',
        false,
        'settings',
      ),
    }
  }
  if (answer.groups.length === 0) {
    return {
      kind: 'nothing',
      box: boxOf(
        'empty',
        'Nothing here this device may read',
        leftSaid(answer) ?? 'Every setting this device may read would be listed here.',
        false,
        'settings',
      ),
    }
  }
  return { kind: 'ready', box: null }
}

/** A search that found nothing, said as that, with the way back. */
export function missedBox(typed) {
  return boxOf(
    'empty',
    `No setting matches “${typed.trim()}”`,
    'Try another word, or clear the search.',
    false,
    'search',
  )
}

/** A region's box as `stateBoxIn` takes it, with `retry` saying whether to offer asking again. */
function boxOf(kind, heading, line, retry = false, icon = undefined) {
  const title = heading
  return { kind, title, line, retry, icon }
}

/**
 * Where the desk opens: what this device may change, where it may change
 * anything, or else the first group.
 */
export function firstChosen(answer, acts) {
  if (hereOf(answer, acts).length > 0) return HERE
  return answer?.groups?.[0]?.id ?? HERE
}

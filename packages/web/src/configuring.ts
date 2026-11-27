import type { Setting, SettingGroup } from '@tade/core'
import type { From, Outcome } from './acting.ts'
import { cleanScreen } from './screen.ts'

// What a paired device may read of the config, and the one thing it may do to
// it — as the interface the window implements and the pure decisions around
// it.
//
// **A fifth table, not a thirteenth verb.** A verb is a task plus the state it
// expects; a setting has a target too — its dotted path — and a state it
// expects, which is the value the device was shown. But the target belongs to
// the *config* rather than to a project, the write goes through the one door
// every setting is written by (`Settings.write` in the window, which writes
// `config_changed`), and how far it may reach is a question this repository
// already answers in one place: `settingReach` in `@tade/core`. So it is its
// own interface, its own route table (`SETTINGS`) and its own setting
// (`surfaces.web.settings`).
//
// ## Every tier, from every paired device
//
// Every paired device is the person's own (decided 26 Nov): their phone, or
// the link of a machine they paired as owner, and if one is stolen they revoke
// it. So every setting is `change` from it, `asked` and `never` tiers
// included, its key rows may be set as well as cleared (`sets`), and the
// change is written `by` that device, so the record still says it came from
// the phone. The window asks `settingReach` again at the write. Nothing
// anybody else wrote — an agent, a page, a machine link's model — becomes the
// person's here: the change is what the person pressed on their own screen,
// against the value they saw. An agent on this machine that paired itself
// reaches nothing it could not already: it runs as the person and can edit
// `config.yaml` itself (`SETTINGS_FROM_AWAY`).
//
// ## Keys
//
// A credential is **never readable**: the projection says `set` or `not set`
// and carries no value, no revision derived from one and no fallback naming
// where one is kept — the rule `tade_settings` already follows. Every value
// that *is* shown goes through `cleanScreen` with every key Tade holds, so a
// key pasted into an ordinary text setting is taken out too. A key may be
// typed in from a device and is never shown one: the page sends what was
// typed rather than anything it was shown.

/** One setting, as a device is told it. */
export interface SettingOut {
  path: string
  title: string
  /** The project it is one of, where it is one project's. */
  scope: string | null
  /** What changing it does, in Tade's own words. */
  means: string
  /** What it is now, as it may be shown. Empty for a key, always. */
  shown: string
  /** What happens with nothing set, cleaned like `shown`. */
  fallback: string
  /** For a key: whether one is held. Null for everything else. */
  held: 'set' | 'not set' | null
  /** For a key: whether a new one may be typed in. False for everything else. */
  sets: boolean
  /** What kind of value it takes. */
  kind: Setting['type']['kind']
  /** The choices, for a choice. */
  options: string[]
  /** Whether a change applies now or when Tade next starts. */
  live: boolean
  /** `change` where this device may change it, `machine` where only a person here may. */
  may: 'change' | 'machine'
  /** Why not, where it is `machine`. Tade's own clause. */
  why: string
  /** What a change must echo — the value as shown. Only where `may` is `change`. */
  was: string | null
}

/** One group, as the Settings page groups them. */
export interface SettingsGroupOut {
  id: string
  title: string
  settings: SettingOut[]
}

/** What `GET /api/settings` answers. */
export interface SettingsOut {
  groups: SettingsGroupOut[]
}

/**
 * Why a setting is changed only at this machine: its value could not be shown
 * whole, so a change would echo a value nobody saw.
 */
export const AT_THE_MACHINE = {
  partial: 'changed at this machine: its value could not be shown here whole',
} as const

/**
 * The project a setting is one of, read out of its path.
 *
 * Out of the path and never the row's `scope`, because the gate has a path
 * and no row — and the per-project boundary has to hold for a crafted call
 * exactly as it does for a drawn one. A scope is not always a project, either:
 * an intake source's rows carry the source.
 */
export function projectOfSetting(path: string): string | null {
  const parts = path.split('.')
  return parts[0] === 'projects' && parts.length > 2 ? (parts[1] ?? null) : null
}

/**
 * Whether a setting is a credential.
 *
 * The **Keys and tokens** group is the declared list — a key an extension asks
 * for tomorrow is covered the day it asks — and a leaf named like one catches
 * the generated notification key, which has a row of its own elsewhere. A key
 * *on a keyboard* (`push to talk`) is not one, which is why the kind is asked
 * first: redacting `ctrl+space` would be wrong in the direction that teaches
 * people to distrust the redaction.
 */
export function isCredential(group: Pick<SettingGroup, 'id'>, setting: Setting): boolean {
  if (group.id === 'credentials') return true
  if (setting.type.kind === 'key') return false
  const leaf = setting.path.split('.').at(-1) ?? ''
  return /(?:^|_)(?:key|token|secret|password)$/.test(leaf)
}

/** What a credential's revision is: whether one is held, and never anything of it. */
export function heldOf(value: string): 'set' | 'not set' {
  return value === '' ? 'not set' : 'set'
}

/**
 * The longest value a setting may be shown with or changed to.
 *
 * A bound on what a phone is sent for a long text setting, and on what it may
 * send back.
 */
export const SETTING_BOUND = 2_000

/**
 * A setting's dotted path, as Tade would have written one.
 *
 * Lowercase segments with digits, `_` and `-`, two to seven of them — which
 * has no `/`, no space and no `..`, and reaches no file: a path is looked up
 * in the settings the window lists, never joined onto anything.
 */
export const SETTING_PATH = /^[a-z][a-z0-9_]*(\.[a-z0-9][a-z0-9_-]*){1,6}$/

/** One value, cleaned for a phone, and whether what is left is all of it. */
function cleaned(value: string, known: readonly string[]): { text: string; whole: boolean } {
  if (value === '') return { text: '', whole: true }
  const made = cleanScreen(value, known, { lines: 64, width: SETTING_BOUND })
  const text = made.lines.join('\n')
  return { text, whole: made.taken === 0 && made.cut === 0 && made.above === 0 && text === value }
}

/**
 * The settings, as a paired device reads them: every one. Every value through
 * `cleanScreen` with every key Tade
 * holds — the ones in `known` and the credential rows' own — so what leaves is
 * Tade's own words, the owner's values with paths and keys taken out, and for
 * a key nothing but whether one is held.
 *
 * Pure: the window hands the rows it already has and the keys it knows.
 */
export function settingsFor(
  groups: readonly SettingGroup[],
  known: readonly string[] = [],
): SettingsOut {
  const keys = keysOf(groups, known)
  const out: SettingsGroupOut[] = []
  for (const group of groups) {
    // Out of the path, never the row's `scope`: a scope is whatever a group
    // holds over and over, and an intake source's is not a project.
    const settings = group.settings.map((setting) =>
      settingOut(group, setting, projectOfSetting(setting.path), keys),
    )
    if (settings.length > 0) out.push({ id: group.id, title: group.title, settings })
  }
  return { groups: out }
}

/**
 * Every key a shown value is cleaned of: the ones the window knows, and every
 * credential row's own — so a key pasted into an ordinary text setting goes
 * even where the window was never told about it.
 */
export function keysOf(groups: readonly SettingGroup[], known: readonly string[]): string[] {
  return [
    ...known,
    ...groups.flatMap((group) =>
      group.settings.filter((one) => isCredential(group, one)).map((one) => one.value),
    ),
  ]
}

/**
 * One setting, as a device is shown it — and so as a device may change it.
 *
 * Exported because the window asks it again **at the write**: what a change
 * may echo and whether it may be made at all are this row's `was` and `may`,
 * so the write accepts exactly what the read offered and there is no second
 * reading of either to drift.
 */
export function settingOut(
  group: SettingGroup,
  setting: Setting,
  project: string | null,
  keys: readonly string[],
): SettingOut {
  const credential = isCredential(group, setting)
  const shown = credential ? { text: '', whole: true } : cleaned(setting.value, keys)
  const fallback = cleaned(setting.fallback, keys).text
  const may: { may: 'change' } | { may: 'machine'; why: string } = shown.whole
    ? { may: 'change' }
    : { may: 'machine', why: AT_THE_MACHINE.partial }
  return {
    path: setting.path,
    title: setting.title,
    scope: project,
    means: cleaned(setting.means, keys).text,
    shown: shown.text,
    fallback,
    held: credential ? heldOf(setting.value) : null,
    sets: credential && may.may === 'change',
    kind: setting.type.kind,
    options: setting.type.kind === 'choice' ? [...setting.type.options] : [],
    live: setting.live,
    may: may.may,
    why: may.may === 'machine' ? may.why : '',
    // **The value as shown, and only where it may be changed.** A credential's
    // is whether one is held and never the key; a row a device cannot change
    // has nothing to echo, so it carries nothing that could be.
    was: may.may === 'change' ? (credential ? heldOf(setting.value) : setting.value) : null,
  }
}

/**
 * One change, as a device asks for it.
 *
 * `was` is what the device was shown — the value itself for an ordinary
 * setting, `set` or `not set` for a key — so a change from a screen drawn
 * before somebody else changed it meets a value that is not the one it echoed,
 * and is refused with what is true now.
 */
export interface SettingCall {
  path: string
  was: string
  value: string
}

/**
 * Changing one setting: the one method, and the whole of what a paired device
 * may ever do to the config.
 *
 * **There is no method here that reads one** — reading is `WebReading`'s
 * `settings` — and no method that grants, signs in, turns an
 * extension on or names a server. A method that does not exist cannot be
 * reached.
 */
export interface WebConfiguring {
  /**
   * Whether changing is still unlocked, read **at the change**: on waits for
   * the route table a restart builds, off is now.
   */
  unlocked(): boolean
  change(call: SettingCall, from: From): Promise<Outcome>
}

import { type Setting, type SettingGroup, settingReach } from '@tade/core'
import type { From, Outcome } from './acting.ts'
import { has, type Reach, sees } from './reach.ts'
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
// own interface, its own route table (`SETTINGS`), its own setting
// (`surfaces.web.settings`), its own scope (`configure`) and a reading grant
// (`settings`) — and nothing else implies any of them.
//
// ## What a device may change, tier by tier
//
// - **`open`: yes, and nothing else.** The tier where an ordinary request is
//   enough: the window's two sizes, the editor, and one project's push mode
//   (`OPEN`, `OPEN_UNDER`). Each argues for itself in `reach.ts`, and the
//   argument — the worst case is something a person is looking at, or a
//   workflow preference that carries no credential and deletes nothing — is
//   not weakened by the request coming from a phone the person granted it to.
// - **`asked`: no, and this is the decision worth the words.** That tier is
//   passed by *the person's own words* naming the setting (`namedBy`, over the
//   journal's `said` lines). Three provenance models were weighed and none is
//   safe:
//   1. **The device's request as the words.** Then `asked` is `open` for a
//      device, and a device is not the person: an agent on this machine can
//      append a line and pair itself (`DEVICES_AND_AGENTS`), and a stolen
//      session is a stranger. A request from a device is never your own words
//      (`ACTING_IS_NOT_YOU`) — that is the sentence the whole surface stands on.
//   2. **The person's journalled lines, as the orchestrator reads them.** Then
//      a phone rides on a sentence they said last week about something else:
//      the hole Phase 3 found in remote turns, where `namedBy` would authorise a
//      remote turn by the person's old line. Words said at the keyboard are
//      about what was asked at the keyboard.
//   3. **Words typed on the phone, written as a `said` line.** That is a
//      device writing the one record nothing outside the keyboard may write —
//      `test/separation.test.ts` holds that this package never reaches it —
//      and it would give every paired device authority over every `asked`
//      setting at once.
//   So an `asked` setting is drawn with *at this machine* and no control, and a
//   crafted call for one is the `404` of a path nobody built. The gap is real
//   and is said (`SETTINGS_FROM_AWAY`): most settings are changed at the
//   machine.
// - **`never`: no route, by construction.** `readSettingChange` refuses any
//   path that is not `open` before a key is claimed, so there is no shape of a
//   request in which `approvals`, `accounts`, `extensions`, `mcp`,
//   `surfaces.web` or a project's root arrives — and the window asks
//   `settingReach` again at the write, because the tier is core's decision and
//   a second reading of it costs one call.
//
// ## Keys
//
// A credential is **never readable**: the projection says `set` or `not set`
// and carries no value, no revision derived from one and no fallback naming
// where one is kept — the rule `tade_settings` already follows. Every value
// that *is* shown goes through `cleanScreen` with every key Tade holds, so a
// key pasted into an ordinary text setting is taken out too. And where a key
// could ever be changed from here it is **clear-only** (`clearOnly`): the one
// value a device may send is nothing, which for the notification key mints a
// new one when it is next needed. Today no key is in the `open` tier, so from
// away nothing clears one and clearing stays where it is — the Settings page —
// but the rule is in code for the day one is, rather than a masked value
// waiting to be round-tripped into a write.

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
  /**
   * Whether this device was granted `settings`. `false` is the whole answer,
   * and is a different fact from a config with nothing in it.
   */
  granted: boolean
  groups: SettingsGroupOut[]
  /** How many settings were left out because they are another project's. A count. */
  withheld: number
}

/** Saying no without saying anything: what an ungranted device is told. */
export const NOT_GRANTED: SettingsOut = { granted: false, groups: [], withheld: 0 }

/**
 * Why a setting is changed only at this machine, by tier.
 *
 * Tade's own clauses rather than `settingReach`'s `because`, which are written
 * in the orchestrator's voice — *I read pages all day* — and are about a model
 * rather than about a phone.
 */
export const AT_THE_MACHINE = {
  asked:
    'changed at this machine: it needs your own words, and a request from a device is never your own words',
  never:
    'changed at this machine only: it decides what agents may do, who is asked, a key, or where Tade sends things',
  key: 'a key is changed at this machine, and is never shown here',
  partial: 'changed at this machine: its value could not be shown here whole',
} as const

/** How far a device reaches into one setting, decided by its path alone. */
export type AwayReach = { may: 'change' } | { may: 'machine'; why: string }

/**
 * How far a device reaches into one setting: `settingReach`'s `open` tier, and
 * nothing else.
 *
 * By path, so the gate can ask it of a body before anything is looked up —
 * which is what makes a `never` path unrepresentable rather than refused late.
 */
export function awayReach(path: string): AwayReach {
  const { reach } = settingReach(path)
  if (reach === 'open') return { may: 'change' }
  return { may: 'machine', why: reach === 'asked' ? AT_THE_MACHINE.asked : AT_THE_MACHINE.never }
}

/**
 * The project a setting is one of, read out of its path.
 *
 * Out of the path and not only the row's `scope`, because the gate has a path
 * and no row — and the per-project boundary has to hold for a crafted call
 * exactly as it does for a drawn one.
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

/**
 * Whether a change may only clear the setting: true of every credential.
 *
 * A device never sees a key, so it can never have meant to *set* one — and a
 * form that round-tripped the `set` it was shown back into the file would put
 * the word `set` where somebody's key was. Clearing is the one thing a key's
 * owner could want from away (where the setting reaches at all), and for the
 * notification key it is the revocation lever: a new one is minted when one is
 * next needed.
 */
export function clearOnly(group: Pick<SettingGroup, 'id'>, setting: Setting): boolean {
  return isCredential(group, setting)
}

/** What a credential's revision is: whether one is held, and never anything of it. */
export function heldOf(value: string): 'set' | 'not set' {
  return value === '' ? 'not set' : 'set'
}

/**
 * The longest value a setting may be shown with or changed to.
 *
 * Far above anything in the `open` tier, which is a number, an editor's name
 * and a push mode; it is a bound on what a phone is sent for a long text
 * setting, not a guess at one somebody types.
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
 * The settings, as one device may read them.
 *
 * **Built from the request's reach**, like an agent's screen: the device list
 * is read at every request, so a grant taken back a second ago is gone here.
 * A project's settings only for a project this device reads, counted where
 * they are left out. Every value through `cleanScreen` with every key Tade
 * holds — the ones in `known` and the credential rows' own — so what leaves is
 * Tade's own words, the owner's values with paths and keys taken out, and for
 * a key nothing but whether one is held.
 *
 * Pure: the window hands the rows it already has and the keys it knows.
 */
export function settingsFor(
  groups: readonly SettingGroup[],
  reach: Reach,
  known: readonly string[] = [],
): SettingsOut {
  if (!has(reach, 'settings')) return NOT_GRANTED
  const keys = keysOf(groups, known)
  let withheld = 0
  const out: SettingsGroupOut[] = []
  for (const group of groups) {
    const settings: SettingOut[] = []
    for (const setting of group.settings) {
      const project = setting.scope ?? projectOfSetting(setting.path)
      if (project !== null && !sees(reach, project)) {
        withheld += 1
        continue
      }
      settings.push(settingOut(group, setting, project, keys))
    }
    if (settings.length > 0) out.push({ id: group.id, title: group.title, settings })
  }
  return { granted: true, groups: out, withheld }
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
  const reach = awayReach(setting.path)
  const may: AwayReach =
    reach.may === 'machine'
      ? reach
      : !shown.whole
        ? { may: 'machine', why: AT_THE_MACHINE.partial }
        : reach
  return {
    path: setting.path,
    title: setting.title,
    scope: project,
    means: cleaned(setting.means, keys).text,
    shown: shown.text,
    fallback,
    held: credential ? heldOf(setting.value) : null,
    kind: setting.type.kind,
    options: setting.type.kind === 'choice' ? [...setting.type.options] : [],
    live: setting.live,
    may: may.may,
    why: may.may === 'machine' ? (credential ? AT_THE_MACHINE.key : may.why) : '',
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
 * `settings`, behind its grant — and no method that grants, signs in, turns an
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

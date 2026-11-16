import { readPairs } from '@tade/core'
import type { ExtensionSetting, TadeExtension } from './port.ts'

// What an extension declares as a setting, and the one translation between a
// value in the config and the text of a field.
//
// Its own file because it is its own subject: none of it touches the host's
// state, none of it runs an extension, and all four of these are about one
// question — what `extensions.<name>` holds, where a credential is actually
// read from, and what a person typed into a box becomes. `host.ts` is the
// thing that holds extensions and calls into them; this is the thing that
// reads what they declared.

export function unknownSettings(
  extension: TadeExtension,
  settings: Readonly<Record<string, unknown>>,
): string[] {
  // A secret is one of them: it is written into `extensions.<name>.<key>` like
  // every other setting, and a key in the config is the key that is used. It
  // used to be excluded here, so that one written by hand would be reported as
  // not read — which was true while credentials lived in the keychain, and is
  // the opposite of true now.
  const known = new Set(['enabled', ...(extension.settings ?? []).map((setting) => setting.key)])
  return Object.keys(settings).filter((key) => !known.has(key))
}

/** The environment variables a declared secret is read from, in order. */
export function variablesFor(
  setting: ExtensionSetting,
  settings: Readonly<Record<string, unknown>>,
): string[] {
  const named = typeof setting.env === 'string' ? [setting.env] : [...(setting.env ?? [])]
  const chosen = setting.envFrom ? settings[setting.envFrom] : undefined
  // What somebody named comes first: `key_env: MY_KEY` means that one.
  return typeof chosen === 'string' && chosen.trim() !== ''
    ? [chosen.trim(), ...named.filter((one) => one !== chosen.trim())]
    : named
}

/** A setting as it is typed into its field. */
export function written(value: unknown, kind: 'text' | 'list' | 'map' | 'flag' | 'secret'): string {
  if (kind === 'flag') return value === true ? 'on' : value === false ? 'off' : ''
  if (value === undefined || value === null) return ''
  if (kind === 'list' && Array.isArray(value)) return value.map(String).join(', ')
  if (kind === 'map' && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, one]) => `${key}=${Array.isArray(one) ? one.join('+') : String(one)}`)
      .join(', ')
  }
  return String(value)
}

/**
 * A field as typed, as the setting it becomes. Empty is no setting at all —
 * which for a credential is how one is taken back out.
 *
 * A map that does not read throws the sentence that says which part did not,
 * rather than writing what was left: `web, platform` once became `{}` and the
 * page said it was saved (`readPairs`).
 */
export function settingFrom(
  text: string,
  kind: 'text' | 'list' | 'map' | 'flag' | 'secret',
): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (kind === 'flag') return trimmed === 'on'
  if (kind === 'map') {
    const read = readPairs(trimmed)
    if ('problem' in read) throw new Error(read.problem)
    return Object.keys(read.pairs).length > 0 ? read.pairs : undefined
  }
  if (kind === 'list') {
    return trimmed
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  }
  return trimmed
}

/** One row of a map being filled in: the name, and what it maps to as typed. */
export interface MapRow {
  key: string
  value: string
}

/** What separates the values beside one name, as they are typed: spaces, commas or `+`. */
const BETWEEN = /[\s,+]+/

/**
 * A map as it is written (`written`), as rows to fill in — the values beside
 * each name with a space between, which is how they are typed back.
 */
export function mapRows(text: string): MapRow[] {
  const read = readPairs(text)
  if ('problem' in read) return []
  return Object.entries(read.pairs).map(([key, value]) => ({
    key,
    value: Array.isArray(value) ? value.join(' ') : value,
  }))
}

/**
 * Rows filled in, as the map they become — or the sentence saying which row
 * cannot be, thrown, with the field's `label` in front so it can be found.
 *
 * A row with nothing in it at all is a row nobody filled in yet and is passed;
 * one with a name and nothing beside it, or values and no name, is refused,
 * never dropped, because dropping it is a setting that resets itself. No rows
 * is no setting, so the key goes away rather than staying as `{}`. Where the
 * field takes one value per name (`several` unset), two are refused rather
 * than handed to a reader expecting one.
 */
export function mapFrom(
  rows: readonly MapRow[],
  field: { label: string; several?: boolean },
): Record<string, string | string[]> | undefined {
  const out: Record<string, string | string[]> = {}
  for (const row of rows) {
    const key = row.key.trim()
    const values = row.value
      .trim()
      .split(BETWEEN)
      .filter((one) => one !== '')
    if (key === '' && values.length === 0) continue
    const refuse = (why: string) => new Error(`${field.label}: ${why}`)
    if (key === '') throw refuse(`${values.join(' ')} has no name in front of it`)
    if (/[\s,=]/.test(key)) throw refuse(`“${key}” cannot be a name: no spaces, commas or “=”`)
    if (values.length === 0)
      throw refuse(`${key} has nothing beside it — fill it in, or take the row out with ×`)
    if (key in out) throw refuse(`${key} is there twice`)
    if (values.length > 1 && field.several !== true)
      throw refuse(`${key} takes one value, and has ${values.length}`)
    out[key] = values.length === 1 ? (values[0] ?? '') : values
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * One setting an extension declares, as the orchestrator reads and changes it
 * (`tade_settings`, `tade_setting_change`): where it is, what it is now as it
 * would be typed, and how far the extension says the orchestrator reaches
 * into it. A credential is never one of these — it is `secrets()`, and only
 * ever said as set or not.
 */
export interface DeclaredSetting {
  /** `extensions.sentry.projects`. */
  path: string
  extension: string
  /** The extension's title, for saying whose setting it is. */
  title: string
  key: string
  kind: Exclude<ExtensionSetting['kind'], 'secret'>
  means: string
  /** What is written in the config, as it would be typed (`written`). */
  value: string
  /** What the extension declared (`ExtensionSetting.reach`), or null where it said nothing. */
  reach: ExtensionSetting['reach'] | null
}

/** The field kind a declared setting is typed as. */
const TYPED_AS = {
  string: 'text',
  boolean: 'flag',
  number: 'text',
  list: 'list',
  map: 'map',
} as const

/** Every setting one extension declares but its credentials, as it stands in `settings`. */
export function declaredSettings(
  extension: TadeExtension,
  settings: Readonly<Record<string, unknown>>,
): DeclaredSetting[] {
  const out: DeclaredSetting[] = []
  for (const setting of extension.settings ?? []) {
    if (setting.kind === 'secret') continue
    out.push({
      path: `extensions.${extension.name}.${setting.key}`,
      extension: extension.name,
      title: extension.title,
      key: setting.key,
      kind: setting.kind,
      means: setting.means,
      value: written(settings[setting.key], TYPED_AS[setting.kind]),
      reach: setting.reach ?? null,
    })
  }
  return out
}

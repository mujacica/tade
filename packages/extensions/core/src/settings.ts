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
 */
export function settingFrom(
  text: string,
  kind: 'text' | 'list' | 'map' | 'flag' | 'secret',
): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (kind === 'flag') return trimmed === 'on'
  const parts = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (kind === 'list') return parts
  if (kind === 'map') {
    return Object.fromEntries(
      parts.flatMap((part) => {
        const [key, ...rest] = part.split('=')
        const value = rest.join('=').trim()
        return key?.trim() && value
          ? [[key.trim(), value.includes('+') ? value.split('+').map((one) => one.trim()) : value]]
          : []
      }),
    )
  }
  return trimmed
}

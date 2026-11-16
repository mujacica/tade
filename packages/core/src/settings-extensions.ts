import type { Setting, SettingGroup, SettingKind } from './settings.ts'

// Every extension's own settings, as the orchestrator reads and changes them.
//
// Not a group on the Settings page: an extension's settings are filled in on
// its own page (the Extensions panel's setup), and the few Settings draws
// beside the reporting ones — Sentry's — are rows of their own in
// `settingsOf`. This is the rest, so that `tade_settings` lists what an
// extension reads and `tade_setting_change` writes it through the page's one
// write path, parsed as the extension's kind says, rather than "Tade has no
// setting called" for a key that is plainly there. How far the orchestrator
// reaches into each is what the extension declared (`declaredReach`).

/** One setting an extension declares, as the window hands it over (`ExtensionHost.declared`). */
export interface ExtensionRow {
  /** `extensions.deps.ignore`. */
  path: string
  /** The extension's title. */
  title: string
  key: string
  kind: 'string' | 'boolean' | 'number' | 'list' | 'map'
  means: string
  /** What is written now, as it would be typed. */
  value: string
}

/** How each kind an extension declares is typed back. */
function typeOf(kind: ExtensionRow['kind']): SettingKind {
  if (kind === 'boolean') return { kind: 'flag' }
  // A share and a count both: an extension's number has no schema here to
  // say which (`withDecimals`), so a decimal is taken and the extension reads it.
  if (kind === 'number') return { kind: 'number', decimals: true }
  if (kind === 'list') return { kind: 'text', placeholder: '', list: true }
  if (kind === 'map') return { kind: 'text', placeholder: 'name=value, other=one+two', pairs: true }
  return { kind: 'text', placeholder: '' }
}

/**
 * The extensions' settings as rows, leaving out any path `shown` already has a
 * row for — Sentry's, whose rows say more than a declaration can. Null where
 * nothing is left.
 */
export function extensionsGroup(
  rows: readonly ExtensionRow[],
  shown: ReadonlySet<string>,
): SettingGroup | null {
  const settings = rows
    .filter((row) => !shown.has(row.path))
    .map(
      (row): Setting => ({
        path: row.path,
        title: `${row.title} ${row.key.replace(/_/g, ' ')}`,
        means: row.means,
        value: row.value,
        fallback: 'what the extension does unless set, as it says',
        type: typeOf(row.kind),
        // The host is handed the config on every write (`reconfigure`).
        live: true,
      }),
    )
  if (settings.length === 0) return null
  return {
    id: 'extension-settings',
    title: 'Extension settings',
    about: 'What each extension reads, as it declares it; each is filled in on its own page too.',
    keywords: ['extension', 'extensions'],
    settings,
  }
}

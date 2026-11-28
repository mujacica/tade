import type { Setting, SettingGroup } from '@tade/core'

// Whether a setting is a credential, asked by the window's Settings page and
// its tools so a key is never shown or handed over (`settings.ts`,
// `setting-tools.ts` in `@tade/app`). The away view reads and writes no
// setting of its own: a phone changes one in the window's Settings, drawn in
// the full view.

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

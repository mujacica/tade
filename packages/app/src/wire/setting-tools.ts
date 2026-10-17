import {
  LINES_LOOKED_BACK,
  namedBy,
  type Setting,
  type SettingGroup,
  settingFound,
  settingReach,
} from '@tade/core'
import { isCredential } from '@tade/web'
import { configPathOf, saidLately, tilde, type Wiring } from './context.ts'

// The orchestrator's settings tools, answered from this window: `tade_settings`
// and `tade_setting_change`. Out of `settings.ts`, which is the page and the
// one path a setting is written by, because this is the other half — what the
// orchestrator is shown, and who may ask for a change in whose words — and that
// file was at the length a file is allowed to be.

/** What the orchestrator's settings tools do, answered from this window. */
export interface SettingTools {
  settings(find: string): Promise<string>
  change(req: { path: string; value: string; said: string }): Promise<string>
}

/** What the tools need of the page: every row it shows, and the one write. */
export interface SettingWriting {
  rows(): SettingGroup[]
  write(path: string, value: string, by: string, said: string): Promise<string>
}

/**
 * What the orchestrator may do with the config, and the boundary it is held
 * to.
 *
 * The boundary is `settingReach` in core, and it is enforced here rather
 * than in the tool: the tool runs inside the model's own process, and a rule
 * that lives where the model lives is a rule the model can be talked out of.
 * It may only ever refuse — everything it allows, the page already allowed.
 */
export function settingTools(wire: Wiring, page: SettingWriting): SettingTools {
  return {
    settings: async (find) => settingsListed(page.rows(), find),
    change: async (req) => askedSetting(wire, page, req),
  }
}

/**
 * Every setting, as something to read: what it is, what it is now, and how
 * far the orchestrator's arm reaches into it.
 *
 * A credential is never read back — it says whether one is set and, where a
 * variable in the shell is what is actually used, which one. Reading a key
 * out loud to whoever is listening is not a thing a tool does, and the page
 * is where somebody checks one against the console that issued it.
 */
function settingsListed(groups: readonly SettingGroup[], find: string): string {
  const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  for (const group of groups) {
    const found = group.settings.filter(
      (one) => words.length === 0 || settingFound(group, one, words),
    )
    if (found.length === 0) continue
    lines.push(`${group.title} — ${group.about}`)
    for (const setting of found) lines.push(`  ${lineFor(group, setting)}`)
  }
  if (lines.length === 0) {
    return words.length === 0
      ? 'Tade offers no settings at all, which should not happen.'
      : `Nothing matches ${find}. Ask again with fewer words, or with none for all of them.`
  }
  return lines.join('\n')
}

/** One setting on one line: its path, what it is, what it means, how far I reach. */
function lineFor(group: SettingGroup, setting: Setting): string {
  const { reach, because } = settingReach(setting.path)
  // A key's fallback says where the one in use comes from; the notification
  // key's says it is made when first needed, which is only true while unset.
  const shown = isCredential(group, setting)
    ? setting.value === ''
      ? `not set (${setting.fallback})`
      : group.id === 'credentials'
        ? `set (${setting.fallback})`
        : 'set'
    : setting.value === ''
      ? `(${setting.fallback})`
      : setting.value
  const may =
    reach === 'never'
      ? `not mine to change: ${because}`
      : reach === 'asked'
        ? 'only when they ask for it'
        : 'changeable on request'
  return `${setting.path} = ${shown} — ${setting.means} [${may}]`
}

/**
 * Change one setting on somebody's behalf, or say why not.
 *
 * Three things have to hold, and each is refused in its own words so the
 * answer says what to do rather than that something went wrong: the boundary
 * has to reach it, Tade has to offer the setting at all, and — for the tier
 * that is most of them — the person has to have asked for *this* setting in
 * their own words.
 *
 * The boundary is asked first, row or no row: a route's `provider` has no row
 * on purpose, and "Tade has no setting called" it read as a key to look for
 * again rather than as one no words reach, which the `never` clause says.
 *
 * The last check reads the journal, not the argument. `said` is the
 * orchestrator's account of what was asked and is written down beside the
 * change; what *authorises* it is a line the person themselves typed or
 * spoke, because those are kept verbatim and nothing an agent read can ever
 * become one. A page can tell a model to turn the checks off. It cannot put
 * "turn the checks off" in somebody's mouth.
 */
export async function askedSetting(
  wire: Wiring,
  page: SettingWriting,
  req: { path: string; value: string; said: string },
): Promise<string> {
  const path = req.path.trim()
  const setting = page
    .rows()
    .flatMap((group) => group.settings)
    .find((one) => one.path === path)
  const { reach, because } = settingReach(path)
  if (reach === 'never') {
    const where = setting
      ? 'in Settings (ctrl+,) or with `tade config`'
      : `in ${tilde(configPathOf(wire.opts))} themselves`
    throw new Error(
      `${setting?.title ?? path} is not mine to change: ${because}. A person changes it ${where} — say that rather than looking for another way.`,
    )
  }
  if (!setting) {
    throw new Error(
      `Tade has no setting called ${path}. tade_settings lists the ones it offers; the rest of config.yaml is \`tade config\` and a person's own.`,
    )
  }
  if (reach === 'asked') {
    if (req.said.trim() === '') {
      throw new Error(
        `${setting.title} is only changed when somebody asks for it. Pass what they said, word for word.`,
      )
    }
    const line = namedBy(setting, await saidLately(wire, LINES_LOOKED_BACK))
    if (!line) {
      throw new Error(
        `Nothing they have said names ${setting.title}, so I will not change it. Ask them plainly — "${setting.title.toLowerCase()}" said back to you is enough — or tell them it is Settings (ctrl+,) and \`tade config\`.`,
      )
    }
  }
  return page.write(path, req.value, 'orchestrator', req.said.trim())
}

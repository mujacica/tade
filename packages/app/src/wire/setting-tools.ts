import {
  LINES_LOOKED_BACK,
  modelChosen,
  namedBy,
  ownProviderMoved,
  providerBeside,
  type Setting,
  type SettingGroup,
  settingFound,
  settingReach,
  spokenAs,
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
  /** Refuses switching the orchestrator's own model unless they asked for it (`ownModelAsked`). */
  ownModelAsked(): Promise<void>
  /** Refuses the model it resolved where that moves the provider it keeps (`ownProviderHeld`). */
  ownProviderHeld(chosen: { provider: string; id: string }): void
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
    ownModelAsked: async () => ownModelAsked(wire, page),
    ownProviderHeld: (chosen) => ownProviderHeld(wire, chosen),
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
 * again rather than as one no words reach, which the `never` clause says. And
 * a route's model of another provider than the one kept beside it is that
 * provider moved (`providerBeside`), which the person's own press does and
 * this never does: it is refused in the same words, before their words are
 * looked for, because no words reach it. So is the orchestrator's own model of
 * another provider than the one it keeps (`ownProviderMoved`), which its row
 * writes beside the model rather than clearing.
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
  const beside = providerBeside(wire.opts.config, path, req.value)
  if (beside !== null) {
    throw new Error(
      `${req.value.trim()} is not ${beside.provider}'s, and ${beside.path} is not mine to change: ${settingReach(beside.path).because}. One of ${beside.provider}'s I can set; that one a person chooses in Settings (ctrl+,), which clears the provider with it — say that rather than looking for another way.`,
    )
  }
  const moved =
    path === OWN_MODEL ? ownProviderMoved(wire.opts.config, modelChosen(req.value).provider) : null
  if (moved !== null) throw new Error(ownProviderRefused(req.value.trim(), moved))
  if (reach === 'asked') {
    if (req.said.trim() === '') {
      throw new Error(
        `${setting.title} is only changed when somebody asks for it. Pass what they said, word for word.`,
      )
    }
    await namedOrRefused(wire, setting)
  }
  return page.write(path, req.value, 'orchestrator', req.said.trim())
}

/** Refuses unless a line of theirs names this setting: the half of `asked` that reads the journal. */
async function namedOrRefused(wire: Wiring, setting: Setting): Promise<void> {
  if (!namedBy(setting, await saidLately(wire, LINES_LOOKED_BACK))) {
    throw new Error(
      `Nothing they have said names ${setting.title}, so I will not change it. Ask them plainly — "${spokenAs(setting)}" said back to you is enough — or tell them it is Settings (ctrl+,) and \`tade config\`.`,
    )
  }
}

/** The row `tade_orchestrator_model` writes, with `orchestrator.provider` beside it. */
const OWN_MODEL = 'orchestrator.model'

/**
 * Refuse switching the orchestrator's own model unless its row's reach allows
 * it, on the words `askedSetting` asks of that row.
 *
 * `tade_orchestrator_model` writes `orchestrator.model` and
 * `orchestrator.provider` without going through `tade_setting_change`, so it
 * is held here, at its own door, before anything is resolved, switched or
 * kept. Without it, "use a cheaper model for refunds" — which that row refuses,
 * because it names no model of the orchestrator's (`OWNED_ROWS`) — switched
 * the orchestrator's model anyway, by the other door.
 */
async function ownModelAsked(wire: Wiring, page: SettingWriting): Promise<void> {
  const setting = page
    .rows()
    .flatMap((group) => group.settings)
    .find((one) => one.path === OWN_MODEL)
  if (!setting) throw new Error(`Tade has no setting called ${OWN_MODEL}, so I will not switch it.`)
  const { reach, because } = settingReach(OWN_MODEL)
  if (reach === 'never') throw new Error(`${setting.title} is not mine to change: ${because}.`)
  if (reach === 'asked') await namedOrRefused(wire, setting)
}

/**
 * Refuse a model `tade_orchestrator_model` resolved where keeping it would move
 * the provider the orchestrator keeps (`ownProviderMoved`).
 *
 * After resolving and before anything is kept or switched: which provider a
 * name resolves to is the harness's answer, so it cannot be asked sooner, and
 * a refusal here throws before a harness that switches live is told anything.
 */
function ownProviderHeld(wire: Wiring, chosen: { provider: string; id: string }): void {
  const moved = ownProviderMoved(wire.opts.config, chosen.provider)
  if (moved !== null) throw new Error(ownProviderRefused(`${chosen.provider}/${chosen.id}`, moved))
}

/** What the orchestrator is told when a model would move the provider it keeps, at either door. */
function ownProviderRefused(model: string, moved: { path: string; provider: string }): string {
  return `${model} would move me off ${moved.provider}, and ${moved.path} is not mine to change: ${settingReach(moved.path).because}. One of ${moved.provider}'s I can switch to, named as ${moved.provider}/<model>; another provider's a person chooses in Settings (ctrl+,) or on my tab's model picker — say that rather than looking for another way.`
}

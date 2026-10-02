import type { Setting, SettingGroup } from '@tade/core'

// The Projects page: which project you are configuring, and that project's
// rows.
//
// It was three pages — Projects, Checks per project, Budgets — each a list of
// every project, so configuring one meant visiting three of them and reading
// past everybody else in each. The settings themselves are one group now
// (`settings-projects.ts`), every row carrying the project it is about, and
// this is the half that belongs to the window: which project the page is on,
// and the rows that leaves.
//
// Pure: groups and a panel in, names and rows out.

/** The one group whose rows are each about one project. */
export const PROJECTS = 'projects'

/** Every project there is to configure, in the order the config has them. */
export function projectsIn(groups: readonly SettingGroup[]): string[] {
  const group = groups.find((one) => one.id === PROJECTS)
  if (!group) return []
  const names: string[] = []
  for (const setting of group.settings) {
    if (setting.scope !== undefined && !names.includes(setting.scope)) names.push(setting.scope)
  }
  return names
}

/**
 * The project the page is configuring: the one chosen, or the first there is.
 *
 * Resolved here rather than remembered, so a project closed while the page is
 * open leaves the page on one that exists rather than on an empty form.
 */
export function projectHere(chosen: string, groups: readonly SettingGroup[]): string | null {
  const names = projectsIn(groups)
  if (names.includes(chosen)) return chosen
  return names[0] ?? null
}

/** One project's rows, out of the group that holds every project's. */
export function projectRows(
  chosen: string,
  groups: readonly SettingGroup[],
): { project: string | null; rows: Setting[] } {
  const project = projectHere(chosen, groups)
  const group = groups.find((one) => one.id === PROJECTS)
  if (project === null || !group) return { project, rows: [] }
  return { project, rows: group.settings.filter((setting) => setting.scope === project) }
}

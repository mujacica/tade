import type { Setting, SettingGroup } from '@tade/core'

// A page that is one of many: which one you are configuring, and its rows.
//
// The Projects page was the first — it had been three pages, Projects, Checks
// per project and Budgets, each a list of every project, so configuring one
// meant visiting three of them and reading past everybody else in each. Intake
// was the second, thirty-three switches with a source's name in every title.
// Both are one question with a scope on it, so a group says it is one
// (`SettingGroup.scoped`) and every page that is gets the same selector, the
// same keys and the same rows: one answer, rather than a second one for the
// second page somebody needed it on.
//
// Pure: groups and a panel in, names and rows out.

/** The one group whose rows are each about one project. */
export const PROJECTS = 'projects'

/** The group a page is, where it is shown one scope at a time; null for every other page. */
export function scopedGroup(
  category: string,
  groups: readonly SettingGroup[],
): SettingGroup | null {
  const group = groups.find((one) => one.id === category)
  return group?.scoped ? group : null
}

/** Every scope a page has, in the order its group declares them. */
export function scopesOf(
  category: string,
  groups: readonly SettingGroup[],
): readonly { id: string; title: string }[] {
  return scopedGroup(category, groups)?.scoped?.scopes ?? []
}

/**
 * The scope the page is configuring: the one chosen, or the first there is.
 *
 * Resolved here rather than remembered, so a project closed while the page is
 * open leaves the page on one that exists rather than on an empty form.
 */
export function scopeHere(
  chosen: string,
  category: string,
  groups: readonly SettingGroup[],
): string | null {
  const scopes = scopesOf(category, groups)
  if (scopes.some((one) => one.id === chosen)) return chosen
  return scopes[0]?.id ?? null
}

/**
 * One scope's rows, out of the group that holds every scope's — and the
 * group's own rows, the ones with no scope, on every one of them: Intake's own
 * switch is what every source is behind, so a page that left it off would be
 * a page whose rows did nothing with no way to see why.
 */
export function scopedRows(
  chosen: string,
  category: string,
  groups: readonly SettingGroup[],
): { scope: string | null; rows: Setting[] } {
  const group = scopedGroup(category, groups)
  const scope = scopeHere(chosen, category, groups)
  if (!group) return { scope, rows: [] }
  const rows = group.settings.filter(
    (setting) => setting.scope === undefined || setting.scope === scope,
  )
  return { scope, rows }
}

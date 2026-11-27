import type { Config } from './config.ts'
import type { Setting, SettingGroup } from './settings.ts'
import { numberStepped } from './settings-numbers.ts'

// What the Settings panel asks of a setting while it is drawn and answered —
// its name in a list, what finds it, what the arrows make of it, and every key
// the window keeps. Apart from `settings.ts`, which builds the list out of the
// config and so reaches all of it, because the panel is drawn in a browser too
// (`pure.ts`). `settings.ts` hands these on, so nothing that imports them from
// there changes.

/**
 * What to call a setting in a list that crosses scopes: its own name where it
 * has no scope, and the scope with it where it has one.
 *
 * One spelling of it, because `tade config`, the orchestrator's listing, the
 * search results and the Settings page's own search all draw the same list and
 * all have to answer the same question.
 */
export function settingLabel(setting: Pick<Setting, 'title' | 'scope'>): string {
  return setting.scope ? `${setting.scope} — ${setting.title}` : setting.title
}

/** Every key the window keeps, by what it does: Shortcuts settings and the sheet both read this. */
export const KEY_BINDINGS: readonly {
  key: Exclude<keyof Config['surfaces']['window']['keys'], 'agent_by_number' | 'project_by_number'>
  title: string
  means: string
  fallback: string
  /** Claimed only while it means something — an approval waiting — so a letter is fine. */
  printable?: boolean
}[] = [
  {
    key: 'leader',
    title: 'Tade from a lane',
    means: 'in a terminal or an agent, then a key here',
    fallback: 'ctrl+]',
  },
  { key: 'search', title: 'Search', means: 'agents, files, lines, commands', fallback: 'ctrl+k' },
  {
    key: 'next_agent',
    title: 'Next agent',
    means: 'the next agent, then the orchestrator',
    fallback: 'tab',
  },
  {
    key: 'previous_agent',
    title: 'Previous agent',
    means: 'back through the same',
    fallback: 'shift+tab',
  },
  {
    key: 'orchestrator',
    title: 'Talk to Tade',
    means: 'type to the orchestrator',
    fallback: 'ctrl+/',
  },
  {
    key: 'next_waiting',
    title: 'Next waiting agent',
    means: 'the agent waiting on you',
    fallback: 'ctrl+q',
  },
  {
    key: 'new_agent',
    title: 'New agent',
    means: 'start one in the project you are in',
    fallback: 'ctrl+n',
  },
  {
    key: 'new_terminal',
    title: 'New terminal',
    means: 'a terminal in the bottom panel',
    fallback: 'ctrl+t',
  },
  {
    key: 'open_project',
    title: 'Open project',
    means: 'add or go to a repository',
    fallback: 'ctrl+o',
  },
  {
    key: 'mute',
    title: 'Mute',
    means: 'quiet now, and back',
    fallback: 'ctrl+m',
  },
  {
    key: 'extensions',
    title: 'Extensions',
    means: 'turn them on and off',
    fallback: 'ctrl+shift+e',
  },
  { key: 'settings', title: 'Settings', means: 'this panel', fallback: 'ctrl+,' },
  {
    key: 'fill_bottom',
    title: 'Bottom panel fills window',
    means: 'it takes the whole window',
    fallback: 'ctrl+shift+f',
  },
  { key: 'keys_sheet', title: 'Shortcuts', means: 'the sheet of every shortcut', fallback: 'f1' },
  {
    key: 'plans',
    title: 'Plans',
    means: 'every plan, and its graph',
    fallback: 'ctrl+shift+p',
  },
  {
    key: 'reload',
    title: 'Reload',
    means: 'restart with your changes',
    fallback: 'ctrl+shift+r',
  },
  {
    key: 'approve',
    title: 'Allow',
    means: 'allow what an agent asks, while one waits',
    fallback: 'a',
    printable: true,
  },
  {
    key: 'deny',
    title: 'Deny',
    means: 'deny what an agent asks, while one waits',
    fallback: 'd',
    printable: true,
  },
]

/**
 * Everything a setting can be found by: what it is called, what it says, the
 * group it is in, and whatever else somebody would look for it as — the key
 * itself included, because `telemetry.dsn` is a thing people type. Searching
 * for the thing you want is how a panel of switches stays usable, so a word
 * nobody put in the prose goes in `keywords` rather than being lost.
 */
export function findableBy(group: SettingGroup, setting: Setting): string {
  return [
    group.title,
    ...(group.keywords ?? []),
    setting.title,
    setting.means,
    setting.path.replace(/[._]/g, ' '),
    ...(setting.keywords ?? []),
  ]
    .join(' ')
    .toLowerCase()
}

/** Whether a search — every word of it — finds this setting. */
export function settingFound(
  group: SettingGroup,
  setting: Setting,
  words: readonly string[],
): boolean {
  const haystack = findableBy(group, setting)
  return words.every((word) => haystack.includes(word.toLowerCase()))
}

/** What the arrows on a number make of it, inside what the setting allows (`numberStepped`). */
export function stepped(setting: Setting, delta: number): string {
  if (setting.type.kind !== 'number') return setting.value
  return numberStepped(setting.type, setting.value || setting.fallback, delta)
}

import { type Config, EDITORS, UPDATE_CHECKS } from './config.ts'
import type { SettingGroup } from './settings.ts'

// The window: how it is laid out, where things open, what search may send to
// find them, and how often it asks whether anything Tade runs is out of date.
// Its own file because `settings.ts` is at its budget, the reason
// `settings-away.ts` and `settings-keep.ts` give — and the budget there went
// down by what left.

export function windowGroup(config: Config): SettingGroup {
  const window = config.surfaces.window
  const search = config.surfaces.search
  return {
    id: 'window',
    title: 'Window',
    about:
      'How the window is laid out, where things open, what search may send to find them, and how often it asks whether anything Tade runs is out of date.',
    // Search was its own menu item over one switch. What ctrl+k can find is
    // part of the window it is typed into, and the words that used to find
    // that item find it here.
    keywords: ['ctrl+k', 'find', 'command palette', 'might mean', 'search'],
    settings: [
      {
        path: 'surfaces.window.sidebar_width',
        title: 'Sidebar width',
        means: 'columns for the tasks down the side',
        value: window.sidebar_width === undefined ? '' : String(window.sidebar_width),
        fallback: 'a quarter of the window',
        type: { kind: 'number' },
        live: true,
      },
      {
        path: 'surfaces.window.strip_height',
        title: 'Orchestrator height',
        means: 'rows for the strip along the bottom',
        value: window.strip_height === undefined ? '' : String(window.strip_height),
        fallback: '9',
        type: { kind: 'number' },
        live: true,
      },
      {
        path: 'surfaces.window.editor',
        title: 'Editor',
        means: 'where a file opens when you click it',
        value: window.editor ?? '',
        fallback: 'the editor Tade is running in',
        type: { kind: 'choice', options: EDITORS },
        live: true,
      },
      {
        path: 'surfaces.window.check_updates',
        title: 'Check for updates',
        // The one setting here that reaches the network, so it says where.
        means:
          'how often the window asks the npm registry, Homebrew and Tade’s own git remote what is current, and says in the strip when something can move forward. never: only when Settings › Updates is pressed',
        value: window.check_updates,
        fallback: 'daily',
        type: { kind: 'choice', options: UPDATE_CHECKS },
        live: true,
        keywords: ['updates', 'update', 'upgrade', 'out of date', 'current', 'version', 'network'],
      },
      {
        path: 'surfaces.search.context',
        title: 'What search sends',
        means:
          'what a sentence typed into search is put to whoever reads one with: what each agent is doing, what it was asked for, what queued work waits on, your notes — which reaches their provider. Off they get names and where they are, and the letters go on matching all of it here, which sends nothing anywhere',
        value: search.context ? 'on' : 'off',
        fallback: 'on',
        type: { kind: 'flag' },
        live: true,
        keywords: ['privacy', 'judge', 'jev', 'might mean', 'intent', 'notes', 'sentence'],
      },
    ],
  }
}

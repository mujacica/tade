import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { ConfigSchema, type SettingGroup, settingsOf } from '@tade/core'
import { drawPanel, type PanelContext } from '../src/panels/context.ts'
import { type SettingsPanel, settingsPanel } from '../src/panels/settings/state.ts'
import { COLOUR } from '../src/skin.ts'
import type { Drawn } from '../src/ui.ts'

// The Settings panel as its tests draw it: one machine's config, every fact
// the panel reads, and the drawing as plain rows. Shared by the files that
// hold the panel to what it must be, so each draws the same page.

export const config = ConfigSchema.parse({
  projects: {
    checkout: { root: '~/src/checkout', budget: { usd_per_day: 5 } },
    search: { root: '~/src/search' },
  },
  surfaces: {
    voice: {
      mic: { device: 'MacBook Pro Microphone' },
      attention: { budget: 6, quiet: '22:00-07:00' },
    },
  },
})

export const GROUPS: SettingGroup[] = settingsOf(config)

export const context = (over: Partial<PanelContext> = {}): PanelContext =>
  ({
    width: 120,
    height: 34,
    skin: COLOUR,
    pointer: { hover: null, pressed: null },
    home: '~/.tade',
    date: (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' '),
    route: null,
    spend: null,
    panes: [],
    project: 'checkout',
    items: [],
    changes: [],
    ahead: null,
    branch: null,
    base: null,
    diff: null,
    choices: [
      { value: 'whisper', label: 'whisper · base.en', group: 'On this machine', note: 'no key' },
      { value: 'openai', label: 'openai · whisper-1', group: 'In the cloud', note: 'needs a key' },
    ],
    settings: GROUPS,
    accounts: [
      {
        harness: 'claude-code',
        name: null,
        kind: 'subscription' as const,
        canAdd: true,
        why: null,
        status: { signedIn: true, who: 'you@example.com', plan: 'max', problem: null },
        limits: { windows: [{ minutes: 300, used: 34, resetsAt: 0 }] },
        agents: 1,
        forNewAgents: true,
        canSignIn: true,
      },
    ],
    configPath: '~/.tade/config.yaml',
    releases: true,
    budgetWarnings: 1,
    levels: [],
    openRows: [],
    browsing: null,
    homeDir: '/Users/me',
    entries: [],
    searching: false,
    viewing: null,
    talkKey: 'ctrl+space',
    talkMode: 'hold',
    bindings: {},
    running: 0,
    branches: [],
    checkout: null,
    found: 0,
    terminalName: 'terminal',
    extensions: [],
    harnessExtensions: [],
    written: [],
    extensionView: null,
    setup: null,
    extensionsRoot: '~/.tade/extensions',
    models: [],
    modelTarget: 'the orchestrator',
    currentModel: null,
    updates: null,
    updatesBusy: false,
    lanesSurvive: false,
    ...over,
  }) as PanelContext

export const panelFor = (category: string, over: Partial<SettingsPanel> = {}): SettingsPanel => ({
  ...settingsPanel(category),
  ...over,
})

export const drawnAt = (
  category: string,
  over: Partial<PanelContext> = {},
  panel = panelFor(category),
) => drawPanel(panel, context(over)).panel

export const plainRows = (drawn: Drawn) => drawn.rows.map((row) => stripTerminalSequences(row))

/** The widths worth trying: from a terminal nobody should use to a wide one. */
export const WIDTHS = [40, 48, 56, 64, 72, 80, 96, 104, 120, 160]

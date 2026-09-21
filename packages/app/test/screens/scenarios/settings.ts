import { ConfigSchema, settingsOf } from '@tade/core'
import { settingsPanel } from '../../../src/panels/settings/state.ts'
import { base, frame, type Scenario } from './fixtures.ts'

// Settings: the categories down the side, one of them open beside them, and
// what the page does as the window narrows.

/** What the Settings panel is shown: a machine set up the way the design was drawn. */
/**
 * Accounts as the page shows them: pi on its providers, Claude Code on your
 * own plan with some of it used, and a second account added and not yet
 * signed in to.
 */
const ACCOUNTS_SHOWN = [
  {
    harness: 'pi',
    name: null,
    kind: 'subscription' as const,
    canAdd: false,
    why: 'keeps one set of sign-ins, in ~/.pi: its providers are its accounts, and you sign in to them inside pi',
    status: { signedIn: true, who: 'anthropic, openrouter', plan: null, problem: null },
    limits: null,
    agents: 1,
    forNewAgents: true,
    canSignIn: true,
  },
  {
    harness: 'claude-code',
    name: null,
    kind: 'subscription' as const,
    canAdd: true,
    why: null,
    status: { signedIn: true, who: 'you@example.com', plan: 'max', problem: null },
    limits: { fiveHour: { used: 34, resetsAt: 1_789_900_000_000 } },
    agents: 2,
    forNewAgents: true,
    canSignIn: true,
  },
  {
    harness: 'claude-code',
    name: 'work',
    kind: 'subscription' as const,
    canAdd: true,
    why: null,
    status: { signedIn: false, who: null, plan: null, problem: 'not signed in yet' },
    limits: null,
    agents: 0,
    forNewAgents: false,
    canSignIn: true,
  },
]

/**
 * What the Updates page would have read: a Tade behind its remote, a harness
 * that ships with Tade, something Homebrew owns that is behind, something the
 * system owns that nobody can ask about, and a driver's program nothing in
 * use needs. One of every answer the page has to be able to give.
 */
const UPDATES_SHOWN = {
  at: 0,
  asked: true,
  tade: {
    version: '0.1.0',
    from: 'checkout' as const,
    where: '~/src/tade',
    branch: 'main',
    commit: 'f8d73e1',
    install: null,
    newer: 'origin/main is at 1a2b3c4 and this checkout is on f8d73e1',
    cannotTell: null,
    update: { command: 'git -C ~/src/tade pull --ff-only && pnpm install' },
  },
  programs: [
    {
      need: {
        command: 'git',
        title: 'git',
        versionArgs: ['--version'],
        optional: false,
        needed: [
          {
            what: 'Tade',
            why: 'every reading of a project’s state, and every commit an agent makes',
            inUse: true,
          },
        ],
        inUse: true,
      },
      install: {
        manager: 'system' as const,
        name: 'git',
        where: '/usr/bin/git',
        said: 'the system’s own',
      },
      version: '2.39.5',
      latest: null,
      cannotTell: 'Tade cannot ask what is current for something installed as the system’s own',
      update: {
        cannot:
          'it came with the system, so the system updates it — on macOS that is `xcode-select --install`',
      },
      behind: false,
    },
    {
      need: {
        command: 'tmux',
        title: 'tmux',
        versionArgs: ['-V'],
        optional: false,
        needed: [
          {
            what: 'the tmux driver',
            why: 'holding every lane, so agents go on working after Tade closes',
            inUse: false,
          },
        ],
        inUse: false,
      },
      install: null,
      version: null,
      latest: null,
      cannotTell: 'it is not on your PATH, so there is nothing here to read a version from',
      update: { cannot: 'nothing on your PATH answers to `tmux`' },
      behind: false,
    },
    {
      need: {
        command: 'pi',
        title: 'pi',
        versionArgs: ['--version'],
        optional: false,
        needed: [
          {
            what: 'pi',
            why: 'being the agent: every lane Tade opens for work runs one',
            inUse: true,
          },
        ],
        inUse: true,
      },
      install: {
        manager: 'tade' as const,
        name: '@earendil-works/pi-coding-agent',
        where: '~/src/tade/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
        said: 'shipped with Tade',
        version: '0.85.1',
      },
      version: '0.85.1',
      latest: null,
      cannotTell: 'it comes with Tade, and moves when Tade does',
      update: { cannot: 'it comes with Tade, so updating Tade is what moves it forward' },
      behind: false,
    },
    {
      need: {
        command: 'gh',
        title: 'GitHub CLI',
        versionArgs: ['--version'],
        optional: true,
        needed: [
          {
            what: 'github',
            why: 'finding your GitHub credential, unless a token is in the environment',
            inUse: true,
          },
        ],
        inUse: true,
      },
      install: {
        manager: 'homebrew' as const,
        name: 'gh',
        where: '/opt/homebrew/Cellar/gh/2.62.0/bin/gh',
        said: 'Homebrew',
        brew: 'formula' as const,
      },
      version: '2.62.0',
      latest: '2.65.0',
      cannotTell: null,
      update: { command: 'brew upgrade gh' },
      behind: true,
    },
  ],
}

function settingsFacts() {
  const config = ConfigSchema.parse({
    projects: {
      checkout: { root: '~/src/checkout', budget: { usd_per_day: 5 } },
      search: { root: '~/src/search' },
      infra: { root: '~/src/infra' },
    },
    surfaces: {
      voice: {
        mic: { device: 'MacBook Pro Microphone' },
        attention: { budget: 6, quiet: '22:00-07:00' },
      },
    },
  })
  return {
    settings: settingsOf(config),
    accounts: ACCOUNTS_SHOWN,
    configPath: '~/.tade/config.yaml',
    releases: true,
    budgetWarnings: 1,
  }
}

export const SETTINGS_SCREENS: Scenario[] = [
  {
    name: 'settings',
    about: 'Settings over the window: categories down the side, real controls on the right.',
    state: { ...base(), panel: { ...settingsPanel('voice'), row: 0 } },
    frame: frame({ panel: settingsFacts() }),
  },
  {
    name: 'settings-updates',
    about:
      'Keeping what Tade runs current: which of the programs it shells out to are here, how each ' +
      'got here, what is current, and whether there is a newer Tade — with what reloading costs ' +
      'said before anybody presses it.',
    state: { ...base(), panel: { ...settingsPanel('updates'), row: 0 } },
    frame: frame({ panel: { ...settingsFacts(), updates: UPDATES_SHOWN, running: 2 } }),
  },
  {
    name: 'settings-accounts',
    about:
      "Who each harness's agents run as: each harness's own sign-in, a second Claude Code " +
      'account beside it, how much of the plan is used, and what can be done to each.',
    state: { ...base(), panel: { ...settingsPanel('accounts'), row: 0 } },
    frame: frame({ panel: settingsFacts() }),
  },
  {
    name: 'settings-list-open',
    about:
      'A setting whose choices need explaining opens as a list, grouped, with what each needs.',
    state: {
      ...base(),
      panel: {
        ...settingsPanel('voice'),
        row: 2,
        dropdown: { path: 'surfaces.voice.stt.driver', query: '', index: 0 },
      },
    },
    frame: frame({ panel: settingsFacts() }),
  },
  {
    name: 'settings-with-long-names',
    about:
      'The group with the longest names in it: one column of switches, every name whole or cut ' +
      'with an ellipsis, and what the group is about kept inside the panel.',
    state: { ...base(), panel: { ...settingsPanel('telemetry'), row: 2 } },
    frame: frame({ panel: settingsFacts() }),
  },
  {
    name: 'pointing-at-a-switch',
    about: 'A switch under the pointer: the row lights, and the switch with it.',
    state: {
      ...base(),
      hover: { kind: 'control', id: 'toggle:telemetry.metrics' },
      panel: { ...settingsPanel('telemetry'), row: 0 },
    },
    frame: frame({ panel: settingsFacts() }),
  },
  {
    name: 'settings-on-a-small-terminal',
    about:
      'Settings at 80×24: a narrower list of categories, names cut with an ellipsis, and the ' +
      'restart note as its own mark — nothing runs into anything.',
    state: { ...base(), panel: { ...settingsPanel('telemetry'), row: 1 } },
    frame: frame({ width: 80, height: 24, panel: settingsFacts() }),
  },
  {
    name: 'settings-with-no-room-beside',
    about:
      'Narrower still: where a control cannot fit beside its name it goes under it, indented, ' +
      'which is the one shape that cannot overlap.',
    state: { ...base(), panel: { ...settingsPanel('telemetry'), row: 1 } },
    frame: frame({ width: 56, height: 22, panel: settingsFacts() }),
  },
  {
    name: 'choosing-the-talk-key',
    about: 'Pressing a key to talk with, and being told what it would take away.',
    state: {
      ...base(),
      panel: {
        ...settingsPanel('voice'),
        capture: { path: 'surfaces.voice.talk.key', key: 'ctrl+r' },
      },
    },
    frame: frame({ panel: settingsFacts() }),
  },
]

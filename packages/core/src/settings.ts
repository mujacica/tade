import { AGENT_WORKSPACES, COMMIT_RULES, type Config, EDITORS } from './config.ts'

// The settings a person actually changes, and what each one means.
//
// The config schema is the authority on what is *valid*; this is the authority
// on what is worth being shown a list of. Not every key belongs here — a
// setting nobody has ever wanted to change is noise in a menu — and the ones
// that do need a sentence saying what happens if you change them, because the
// answer is rarely guessable from the key's name.
//
// Pure: a config in, a described list out. What it takes to write one back is
// the caller's business.

export type SettingKind =
  | {
      kind: 'choice'
      options: readonly string[]
      /** Show as a list you open, even when it is short: its options need explaining. */
      list?: boolean
      /** For a list: the heading each option sits under, and a note beside it. */
      about?: Readonly<Record<string, { group: string; note: string; label?: string }>>
    }
  | { kind: 'text'; placeholder: string }
  | {
      kind: 'number'
      /** Said after the value: `an hour, at most`. */
      unit?: string
    }
  /** A span of the day, `22:00-07:00`, shown as two times. */
  | { kind: 'hours' }
  | { kind: 'flag' }
  /** A key or combination, chosen by pressing it. */
  | { kind: 'key'; printable?: boolean }
  /** A model from the harness's catalog, as `provider/id`. */
  | { kind: 'model' }

export interface Setting {
  /** Dotted path into the config, which is also how it is written back. */
  path: string
  title: string
  /** What changing it does, in one sentence. */
  means: string
  /** What it is now, as text. Empty when nothing is set. */
  value: string
  /** What happens when nothing is set. */
  fallback: string
  type: SettingKind
  /**
   * Whether changing it takes effect at once. Anything read when Wilco starts
   * says so instead, because a setting that looks applied and is not is worse
   * than one that waits honestly.
   */
  live: boolean
}

export interface SettingGroup {
  /** Stable name, for finding a group rather than reading its title. */
  id: string
  title: string
  /** One sentence under the title: what the group is about. */
  about: string
  settings: Setting[]
}

/** Everything worth putting in front of somebody, grouped as they think of it. */
export function settingsOf(config: Config): SettingGroup[] {
  const voice = config.surfaces.voice
  // `…/ggml-base.en.bin` is the base.en model: the name people know it by.
  const whisperModel =
    voice.stt.model
      ?.split('/')
      .at(-1)
      ?.replace(/^ggml-/, '')
      .replace(/\.bin$/, '') ?? 'base.en'
  const window = config.surfaces.window
  const route = config.workers.routes[config.workers.default]
  const projects = Object.entries(config.projects)
  return [
    {
      id: 'agents',
      title: 'Agents',
      about: 'Where agents work, what they commit, and what happens to them when Wilco closes.',
      settings: [
        {
          path: 'agents.workspace',
          title: 'Where agents work',
          means:
            'checkout: all of them in the project’s checkout, on its branch, at once; worktree: each in a worktree and branch of its own',
          value: config.agents.workspace,
          fallback: 'checkout',
          type: { kind: 'choice', options: [...AGENT_WORKSPACES] },
          live: true,
        },
        {
          path: 'agents.commit',
          title: 'When agents commit',
          means:
            'own-files: their own files when done; when-done: everything when done; as-you-go: small commits; never: you commit',
          value: config.agents.commit,
          fallback: 'own-files',
          type: { kind: 'choice', options: [...COMMIT_RULES] },
          live: true,
        },
        {
          path: 'agents.instructions',
          title: 'Rules for every agent',
          means: 'told to each agent as it starts, in your words',
          value: config.agents.instructions ?? '',
          fallback: '',
          type: { kind: 'text', placeholder: 'run pnpm check before committing' },
          live: true,
        },
        {
          path: 'workspace.driver',
          title: 'Where agents run',
          means: 'tmux keeps agents working after you close Wilco; pty stops them with it',
          value: config.workspace.driver,
          fallback: 'pty',
          type: { kind: 'choice', options: ['pty', 'tmux'] },
          live: false,
        },
        {
          path: 'workspace.fallback',
          title: 'Fallback',
          means: 'where lanes go if the driver is not on this machine',
          value: config.workspace.fallback,
          fallback: 'pty',
          type: { kind: 'choice', options: ['pty', 'tmux'] },
          live: false,
        },
        {
          path: 'workspace.adopt',
          title: 'Adopt other agents',
          means: 'show Claude Code and Codex sessions started outside Wilco',
          value: String(config.workspace.adopt),
          fallback: 'true',
          type: { kind: 'flag' },
          live: false,
        },
      ],
    },
    {
      id: 'models',
      title: 'Models',
      about: 'What agents think with, unless a project says otherwise.',
      settings: [
        {
          path: `workers.routes.${config.workers.default}.model`,
          title: 'Agent model',
          means: 'the model new agents start on; the harness picks when unset',
          value: route?.model
            ? route.provider
              ? `${route.provider}/${route.model}`
              : route.model
            : '',
          fallback: 'the harness decides',
          type: { kind: 'model' },
          live: true,
        },
      ],
    },
    {
      id: 'orchestrator',
      title: 'Orchestrator',
      about: 'The one you talk to.',
      settings: [
        {
          path: 'orchestrator.model',
          title: 'Model',
          means: 'what you talk to. Omit to use whatever the harness is logged in to',
          value: config.orchestrator.model
            ? config.orchestrator.provider
              ? `${config.orchestrator.provider}/${config.orchestrator.model}`
              : config.orchestrator.model
            : '',
          fallback: 'the harness decides',
          type: { kind: 'model' },
          live: false,
        },
        {
          path: 'orchestrator.reflect',
          title: 'Look back at finished tasks',
          means: 'write down a lesson when a task lands, if there is one to write',
          value: String(config.orchestrator.reflect),
          fallback: 'true',
          type: { kind: 'flag' },
          live: true,
        },
      ],
    },
    {
      id: 'approvals',
      title: 'Approvals',
      about: 'When an agent has to ask before it acts.',
      settings: [
        {
          path: 'approvals.mode',
          title: 'Mode',
          means: 'bypass never interrupts; policy holds risky commands until you answer',
          value: config.approvals.mode,
          fallback: 'bypass',
          type: { kind: 'choice', options: ['bypass', 'policy'] },
          live: false,
        },
      ],
    },
    {
      id: 'voice',
      title: 'Voice',
      about: 'How you talk to Wilco, and how it talks back.',
      settings: [
        {
          path: 'surfaces.voice.talk.key',
          title: 'Push to talk',
          means: 'the key you hold to talk; never one that types a character',
          value: voice.talk.key,
          fallback: 'ctrl+space',
          type: { kind: 'key' },
          live: true,
        },
        {
          path: 'surfaces.voice.talk.mode',
          title: 'Mode',
          means: 'hold needs a terminal that reports key releases; toggle works in any',
          value: voice.talk.mode,
          fallback: 'hold',
          type: { kind: 'choice', options: ['hold', 'toggle'] },
          live: true,
        },
        {
          path: 'surfaces.voice.stt.driver',
          title: 'Speech to text',
          means: 'whisper-cpp runs on this machine; the others send audio to a provider',
          value: voice.stt.driver,
          fallback: 'whisper-cpp',
          type: {
            kind: 'choice',
            options: ['whisper-cpp', 'openai', 'groq'],
            list: true,
            about: {
              'whisper-cpp': {
                group: 'On this machine',
                note: 'private, no key',
                label: `whisper · ${whisperModel} · on this machine`,
              },
              openai: { group: 'In the cloud', note: 'needs a key', label: 'OpenAI · whisper-1' },
              groq: {
                group: 'In the cloud',
                note: 'needs a key',
                label: 'Groq · whisper-large-v3',
              },
            },
          },
          live: false,
        },
        {
          path: 'surfaces.voice.mic.device',
          title: 'Microphone',
          means: "the input device, in the system's own terms; the default when unset",
          value: voice.mic.device ?? '',
          fallback: 'the default microphone',
          type: { kind: 'text', placeholder: ':0' },
          live: false,
        },
        {
          path: 'surfaces.voice.speak',
          title: 'Spoken replies',
          means: 'say answers and news out loud; off keeps the sounds and the text',
          value: String(voice.speak),
          fallback: 'true',
          type: { kind: 'flag' },
          live: true,
        },
        {
          path: 'surfaces.voice.attention.budget',
          title: 'Interruptions',
          means:
            'spoken interruptions an hour; beyond this, things wait and come back as one sentence',
          value: voice.attention.budget === undefined ? '' : String(voice.attention.budget),
          fallback: '6',
          type: { kind: 'number', unit: 'an hour, at most' },
          live: false,
        },
        {
          path: 'surfaces.voice.attention.quiet',
          title: 'Quiet hours',
          means: 'when Wilco will not speak, however urgent',
          value: voice.attention.quiet ?? '',
          fallback: 'none',
          type: { kind: 'hours' },
          live: false,
        },
      ],
    },
    {
      id: 'window',
      title: 'Window',
      about: 'How the window is laid out, and where things open.',
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
          fallback: 'the editor Wilco is running in',
          type: { kind: 'choice', options: EDITORS },
          live: true,
        },
      ],
    },
    {
      id: 'projects',
      title: 'Projects',
      about: 'The repositories Wilco can start work in.',
      settings: projects.flatMap(([name, project]) => [
        {
          path: `projects.${name}.root`,
          title: name,
          means: 'where the repository is',
          value: project.root,
          fallback: '',
          type: { kind: 'text', placeholder: '~/src/app' } as const,
          live: false,
        },
        {
          path: `projects.${name}.brief`,
          title: `${name} brief`,
          means: 'one line the orchestrator is told about this project',
          value: project.brief ?? '',
          fallback: 'none',
          type: { kind: 'text', placeholder: 'Payments. Stripe, Postgres, Node.' } as const,
          live: false,
        },
      ]),
    },
    {
      id: 'budgets',
      title: 'Budgets',
      about: 'How much each project may spend a day before new agents are refused.',
      settings: projects.map(([name, project]) => ({
        path: `projects.${name}.budget.usd_per_day`,
        title: name,
        means: 'dollars a day; agents are warned at 80% and refused past it',
        value: project.budget?.usd_per_day === undefined ? '' : String(project.budget.usd_per_day),
        fallback: 'no budget',
        type: { kind: 'number' } as const,
        live: false,
      })),
    },
    {
      id: 'keys',
      title: 'Keys',
      about:
        'The keys Wilco keeps for itself. Everything else goes to your agent. Alt keys need Option as Meta in macOS terminals.',
      settings: [
        {
          path: 'surfaces.voice.talk.key',
          title: 'Push to talk',
          means: 'the key you hold to talk; never one that types a character',
          value: voice.talk.key,
          fallback: 'ctrl+space',
          type: { kind: 'key' },
          live: true,
        },
        ...KEY_BINDINGS.map(
          (binding): Setting => ({
            path: `surfaces.window.keys.${binding.key}`,
            title: binding.title,
            means: binding.means,
            value: config.surfaces.window.keys[binding.key],
            fallback: binding.fallback,
            type: binding.printable ? { kind: 'key', printable: true } : { kind: 'key' },
            live: true,
          }),
        ),
      ],
    },
  ]
}

/** Every key the window keeps, by what it does: the Keys settings and the keys sheet both read this. */
export const KEY_BINDINGS: readonly {
  key: keyof Config['surfaces']['window']['keys']
  title: string
  means: string
  fallback: string
  /** Claimed only while it means something — an approval waiting — so a letter is fine. */
  printable?: boolean
}[] = [
  {
    key: 'search',
    title: 'Search',
    means: 'agents, files, lines in files, commands',
    fallback: 'ctrl+k',
  },
  {
    key: 'next_agent',
    title: 'Next agent',
    means: 'move to the next agent, then the orchestrator',
    fallback: 'tab',
  },
  {
    key: 'previous_agent',
    title: 'Previous agent',
    means: 'move back through the same',
    fallback: 'shift+tab',
  },
  {
    key: 'orchestrator',
    title: 'Talk to Wilco',
    means: 'put the keyboard on the orchestrator line',
    fallback: 'alt+o',
  },
  {
    key: 'next_waiting',
    title: 'Next waiting agent',
    means: 'go to the agent that is waiting on you',
    fallback: 'alt+w',
  },
  {
    key: 'new_agent',
    title: 'New agent',
    means: 'start an agent in the project you are in',
    fallback: 'alt+a',
  },
  {
    key: 'new_terminal',
    title: 'New terminal',
    means: 'open a terminal in the bottom panel',
    fallback: 'alt+t',
  },
  {
    key: 'open_project',
    title: 'Open project',
    means: 'add or go to a repository',
    fallback: 'alt+r',
  },
  {
    key: 'extensions',
    title: 'Extensions',
    means: 'turn extensions on and off, set them up',
    fallback: 'alt+e',
  },
  { key: 'settings', title: 'Settings', means: 'this panel', fallback: 'alt+s' },
  {
    key: 'fill_bottom',
    title: 'Bottom panel fills window',
    means: 'the conversation or terminal takes the window',
    fallback: 'alt+m',
  },
  { key: 'keys_sheet', title: 'Keys', means: 'the sheet of every key', fallback: 'f1' },
  {
    key: 'approve',
    title: 'Allow',
    means: 'allow what an agent asked, only while one waits',
    fallback: 'a',
    printable: true,
  },
  {
    key: 'deny',
    title: 'Deny',
    means: 'deny what an agent asked, only while one waits',
    fallback: 'd',
    printable: true,
  },
]

/** One line per setting, for a list you choose from. */
export function describeSetting(setting: Setting): string {
  const shown = setting.value === '' ? `(${setting.fallback})` : setting.value
  return `${setting.title.padEnd(30)} ${shown}`
}

/**
 * Put a value where it belongs in a config object, making the objects on the
 * way. Empty means "unset", which is how a setting goes back to its default
 * rather than being written down as an empty string.
 */
export function applySetting(
  config: Record<string, unknown>,
  path: string,
  value: string | number | boolean | undefined,
): void {
  const parts = path.split('.')
  const last = parts.pop()
  if (!last) return
  let here = config
  for (const part of parts) {
    const next = here[part]
    if (typeof next !== 'object' || next === null) here[part] = {}
    here = here[part] as Record<string, unknown>
  }
  if (value === undefined || value === '') delete here[last]
  else here[last] = value
}

/** What a typed answer means for a setting, or null if it cannot mean anything. */
export function parseSetting(
  setting: Setting,
  said: string,
): string | number | boolean | undefined {
  const text = said.trim()
  if (text === '') return undefined
  switch (setting.type.kind) {
    case 'flag':
      return /^(y|yes|true|on)$/i.test(text)
    case 'number': {
      const value = Number(text)
      return Number.isInteger(value) && value > 0 ? value : undefined
    }
    default:
      return text
  }
}

import { type Config, EDITORS } from './config.ts'

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
  | { kind: 'choice'; options: readonly string[] }
  | { kind: 'text'; placeholder: string }
  | { kind: 'number' }
  | { kind: 'flag' }

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
}

export interface SettingGroup {
  title: string
  settings: Setting[]
}

/** Everything worth putting in front of somebody, grouped as they think of it. */
export function settingsOf(config: Config): SettingGroup[] {
  const voice = config.surfaces.voice
  return [
    {
      title: 'Where agents run',
      settings: [
        {
          path: 'workspace.driver',
          title: 'Driver',
          means: 'tmux keeps agents working after you close Wilco; pty stops them with it',
          value: config.workspace.driver,
          fallback: 'pty',
          type: { kind: 'choice', options: ['pty', 'tmux'] },
        },
        {
          path: 'workspace.fallback',
          title: 'Fallback',
          means: 'where lanes go if the driver is not on this machine',
          value: config.workspace.fallback,
          fallback: 'pty',
          type: { kind: 'choice', options: ['pty', 'tmux'] },
        },
        {
          path: 'workspace.adopt',
          title: 'Adopt other agents',
          means: 'show Claude Code and Codex sessions started outside Wilco',
          value: String(config.workspace.adopt),
          fallback: 'true',
          type: { kind: 'flag' },
        },
      ],
    },
    {
      title: 'The orchestrator',
      settings: [
        {
          path: 'orchestrator.model',
          title: 'Model',
          means: 'what you talk to. Omit to use whatever the harness is logged in to',
          value: config.orchestrator.model ?? '',
          fallback: 'the harness decides',
          type: { kind: 'text', placeholder: 'claude-opus-5' },
        },
        {
          path: 'orchestrator.provider',
          title: 'Provider',
          means: 'which provider that model comes from',
          value: config.orchestrator.provider ?? '',
          fallback: 'the harness decides',
          type: { kind: 'text', placeholder: 'anthropic' },
        },
        {
          path: 'orchestrator.reflect',
          title: 'Look back at finished tasks',
          means: 'write down a lesson when a task lands, if there is one to write',
          value: String(config.orchestrator.reflect),
          fallback: 'true',
          type: { kind: 'flag' },
        },
      ],
    },
    {
      title: 'Approvals',
      settings: [
        {
          path: 'approvals.mode',
          title: 'Mode',
          means: 'bypass never interrupts; policy holds risky commands until you answer',
          value: config.approvals.mode,
          fallback: 'bypass',
          type: { kind: 'choice', options: ['bypass', 'policy'] },
        },
      ],
    },
    {
      title: 'Voice',
      settings: [
        {
          path: 'surfaces.voice.stt.driver',
          title: 'Speech to text',
          means: 'whisper-cpp runs on this machine; the others send audio to a provider',
          value: voice.stt.driver,
          fallback: 'whisper-cpp',
          type: { kind: 'choice', options: ['whisper-cpp', 'openai', 'groq'] },
        },
        {
          path: 'surfaces.voice.attention.budget',
          title: 'Spoken interruptions an hour',
          means: 'beyond this, things wait and come back as one sentence',
          value: voice.attention.budget === undefined ? '' : String(voice.attention.budget),
          fallback: '6',
          type: { kind: 'number' },
        },
        {
          path: 'surfaces.voice.attention.quiet',
          title: 'Quiet hours',
          means: 'when Wilco will not speak, however urgent',
          value: voice.attention.quiet ?? '',
          fallback: 'none',
          type: { kind: 'text', placeholder: '22:00-08:00' },
        },
      ],
    },
    {
      title: 'The window',
      settings: [
        {
          path: 'surfaces.window.sidebar_width',
          title: 'Sidebar width',
          means: 'columns for the projects list',
          value:
            config.surfaces.window.sidebar_width === undefined
              ? ''
              : String(config.surfaces.window.sidebar_width),
          fallback: '24',
          type: { kind: 'number' },
        },
        {
          path: 'surfaces.window.strip_height',
          title: 'Orchestrator height',
          means: 'rows for the strip along the bottom',
          value:
            config.surfaces.window.strip_height === undefined
              ? ''
              : String(config.surfaces.window.strip_height),
          fallback: '9',
          type: { kind: 'number' },
        },
        {
          path: 'surfaces.window.editor',
          title: 'Editor',
          means: 'where a file opens when you click it',
          value: config.surfaces.window.editor ?? '',
          fallback: 'the editor Wilco is running in',
          type: { kind: 'choice', options: EDITORS },
        },
      ],
    },
  ]
}

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

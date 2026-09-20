import {
  AGENT_WORKSPACES,
  COMMIT_RULES,
  type Config,
  EDITORS,
  HARNESS_IDS,
  THINKING_LEVELS,
} from './config.ts'

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
  | {
      kind: 'text'
      placeholder: string
      /**
       * Read back as pairs — `tade=tade-app, web=web-a+web-b` — for a setting
       * whose reader wants a map rather than a line of text.
       */
      pairs?: boolean
    }
  | {
      kind: 'number'
      /** Said after the value: `an hour, at most`. */
      unit?: string
      /** A share of something, 0 to 1, rather than a whole number above zero. */
      fraction?: boolean
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
   * Whether changing it takes effect at once. Anything read when Tade starts
   * says so instead, because a setting that looks applied and is not is worse
   * than one that waits honestly.
   */
  live: boolean
  /**
   * Other words that should find it, for what its title and `means` do not
   * happen to say. Searching for the thing you want should find it.
   */
  keywords?: readonly string[]
  /**
   * Credential-shaped. It is shown in its own field, where you type it, and
   * nowhere else: not in a list of settings, not in what is said back to you.
   */
  secret?: boolean
  /**
   * Not written to the config at all: kept under this name —
   * `<extension>.<key>` — where Tade keeps credentials, which is the OS
   * keychain or a file of its own written `0600`. Whoever saves it hands it
   * to the secret store rather than to `writeSetting`.
   */
  kept?: string
}

/** A credential something asked for, as Settings offers a field for it. */
export interface SecretRow {
  /** What it is kept under: `jev.key`. */
  name: string
  /** What to call it: `Jev API key`. */
  title: string
  means: string
  /** Where the one it has now is (`$TYPESAFE_API_KEY`), or null when there is none. */
  from: string | null
  placeholder?: string
  /** The environment variables it is read from first, for saying which wins. */
  variables?: readonly string[]
}

export interface SettingGroup {
  /** Stable name, for finding a group rather than reading its title. */
  id: string
  title: string
  /** One sentence under the title: what the group is about. */
  about: string
  /** Other words that should find this group and everything in it. */
  keywords?: readonly string[]
  settings: Setting[]
}

/**
 * Everything worth putting in front of somebody, grouped as they think of it.
 *
 * `secrets` are the credentials whatever is loaded has asked for — an
 * extension's key, a forge's token. They are settings like any other to
 * whoever draws them, and the one thing that is never in the config.
 */
export function settingsOf(config: Config, secrets: readonly SecretRow[] = []): SettingGroup[] {
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
  // The Sentry extension's own settings, shown beside the reporting ones:
  // where Tade sends its trouble and where it reads it back are one decision,
  // and looking for “Sentry” should not end in two different panels.
  const sentry: Readonly<Record<string, unknown>> = config.extensions.sentry ?? {}
  const sentryText = (key: string): string =>
    typeof sentry[key] === 'string' ? (sentry[key] as string) : ''
  return [
    {
      id: 'agents',
      title: 'Agents',
      about: 'Where agents work, what they commit, and what happens to them when Tade closes.',
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
          means: 'tmux keeps agents working after you close Tade; pty stops them with it',
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
          means: 'show Claude Code and Codex sessions started outside Tade',
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
        {
          path: `workers.routes.${config.workers.default}.thinking`,
          title: 'Agent thinking',
          means: 'how hard new agents think; each agent can be changed from its pane',
          value: route?.thinking ?? '',
          fallback: 'the harness decides',
          type: { kind: 'choice', options: [...THINKING_LEVELS] },
          live: true,
        },
        {
          path: `workers.routes.${config.workers.default}.harness`,
          title: 'Agent harness',
          means: 'what runs new agents; each agent can be moved to another from its pane',
          value: route?.harness ?? 'pi',
          fallback: 'pi',
          type: { kind: 'choice', options: [...HARNESS_IDS] },
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
          path: 'orchestrator.harness',
          title: 'Harness',
          means:
            'the program you talk through: pi, or Claude Code on the account it is signed in to. The conversation is the harness’s own, so each keeps its own',
          value: config.orchestrator.harness,
          fallback: 'pi',
          type: { kind: 'choice', options: [...HARNESS_IDS] },
          keywords: ['claude', 'code', 'pi', 'agent'],
          live: false,
        },
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
          path: 'orchestrator.thinking',
          title: 'Thinking',
          means: 'how hard it thinks before it answers; it moves from its next reply',
          value: config.orchestrator.thinking ?? '',
          fallback: 'the harness decides',
          type: { kind: 'choice', options: [...THINKING_LEVELS] },
          live: true,
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
      id: 'checks',
      title: 'Checks',
      about:
        "A project's own checks, run here before anybody else sees the work. What a project checks is `.tade/checks.yaml`, beside its code; these are the rules about when Tade runs them.",
      settings: [
        {
          path: 'checks.before',
          title: 'Needed before',
          means:
            'when a push or commit needs a green run behind it. Only an agent working under policy approvals can actually be held; everyone else is told, and what happened is written down',
          value: config.checks.before,
          fallback: 'push',
          type: { kind: 'choice', options: ['off', 'commit', 'push', 'commit and push'] },
          live: true,
        },
        {
          path: 'checks.on_red',
          title: 'When one is red',
          means:
            'hold it and hand back what failed, tell the person and let it through, or only write it down',
          value: config.checks.on_red,
          fallback: 'hold',
          type: { kind: 'choice', options: ['hold', 'tell', 'note'] },
          live: true,
        },
        {
          path: 'checks.parallel',
          title: 'At once',
          means:
            'how many checks may run at once here; one that needs the machine to itself still runs alone',
          value: String(config.checks.parallel),
          fallback: '2',
          type: { kind: 'number' },
          live: true,
        },
        {
          path: 'checks.from_ci',
          title: 'Checks read from CI',
          means:
            'what to do with the commands a project runs in CI when it has no .tade/checks.yaml: show them without running them, run them here too, or ignore them. `tade checks adopt` turns them into a manifest, which is what makes them ours to run',
          value: config.checks.from_ci,
          fallback: 'show',
          type: { kind: 'choice', options: ['show', 'run', 'off'] },
          live: true,
          keywords: ['github', 'actions', 'workflow', 'ci', 'adopt', 'import'],
        },
        {
          path: 'checks.ci',
          title: 'Show what CI says',
          means: 'put the review\u2019s own checks beside the local run; nothing without a forge',
          value: String(config.checks.ci),
          fallback: 'true',
          type: { kind: 'flag' },
          live: true,
        },
      ],
    },
    {
      id: 'voice',
      title: 'Voice',
      about: 'How you talk to Tade, and how it talks back.',
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
          path: 'surfaces.voice.muted',
          title: 'Muted',
          means:
            'no speech and no sounds at all, cutting off whatever is being said; the conversation still shows everything',
          value: String(voice.muted),
          fallback: 'false',
          type: { kind: 'flag' },
          live: true,
        },
        {
          path: 'surfaces.voice.speak',
          title: 'Spoken replies',
          means: 'say the short of an answer out loud; off keeps the sounds and the text',
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
          means: 'when Tade will not speak, however urgent',
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
          fallback: 'the editor Tade is running in',
          type: { kind: 'choice', options: EDITORS },
          live: true,
        },
      ],
    },
    {
      id: 'projects',
      title: 'Projects',
      about: 'The repositories Tade can start work in.',
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
      // The schema has always allowed `projects.<name>.checks`, and `checksFor`
      // has always read it; until this group there was no way to set one, which
      // made it a key that read like a promise Tade did not keep.
      id: 'project-checks',
      title: 'Checks per project',
      about:
        "One project's own answer to the Checks rules. Left empty it follows the rule above; what a project actually checks is its own `.tade/checks.yaml`, which Settings does not hold because it lives in the repository.",
      settings: projects.flatMap(([name, project]) => [
        {
          path: `projects.${name}.checks.before`,
          title: `${name} — needed before`,
          means: `when Tade runs ${name}'s checks unasked, whatever the rule above says`,
          value: project.checks?.before ?? '',
          fallback: config.checks.before,
          type: { kind: 'choice', options: ['', 'off', 'commit', 'push', 'commit and push'] },
          live: true,
          keywords: [name, 'checks', 'gate', 'push'],
        },
        {
          path: `projects.${name}.checks.on_red`,
          title: `${name} — when one is red`,
          means: `what a failed required check does in ${name}`,
          value: project.checks?.on_red ?? '',
          fallback: config.checks.on_red,
          type: { kind: 'choice', options: ['', 'hold', 'tell', 'note'] },
          live: true,
          keywords: [name, 'checks', 'red', 'fail'],
        },
        {
          path: `projects.${name}.checks.from_ci`,
          title: `${name} — checks read from CI`,
          means: `what ${name}'s CI config is good for when it has no .tade/checks.yaml`,
          value: project.checks?.from_ci ?? '',
          fallback: config.checks.from_ci,
          type: { kind: 'choice', options: ['', 'show', 'run', 'off'] },
          live: true,
          keywords: [name, 'github', 'actions', 'workflow', 'adopt'],
        },
        {
          path: `projects.${name}.checks.parallel`,
          title: `${name} — at once`,
          means: `how many of ${name}'s checks may run at once here`,
          value: project.checks?.parallel === undefined ? '' : String(project.checks.parallel),
          fallback: String(config.checks.parallel),
          type: { kind: 'number' } as const,
          live: true,
          keywords: [name, 'checks', 'parallel'],
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
      id: 'telemetry',
      title: 'Telemetry',
      about:
        'Tade reporting its own trouble to a Sentry project of yours, and reading that Sentry back. Never your work: what may be sent is an allow-list — names, counts and Tade’s own words, with paths scrubbed to ~.',
      keywords: [
        'telemetry',
        'sentry',
        'dsn',
        'reporting',
        'crashes',
        'errors',
        'traces',
        'logs',
        'metrics',
        'monitoring',
        'privacy',
      ],
      settings: [
        {
          path: 'telemetry.dsn',
          title: 'Send to',
          means:
            'a Sentry DSN of yours, from that project’s Client Keys, or $TADE_TELEMETRY_DSN; empty sends nothing',
          value: config.telemetry.dsn,
          fallback: 'nothing is sent',
          type: { kind: 'text', placeholder: 'https://…@…ingest.sentry.io/…' },
          live: false,
          secret: true,
          keywords: ['sentry', 'dsn', 'telemetry'],
        },
        {
          path: 'telemetry.driver',
          title: 'Reporter',
          means:
            'sentry sends through Sentry’s own SDK, imported only when there is a DSN; none sends nothing',
          value: config.telemetry.driver,
          fallback: 'sentry',
          type: { kind: 'choice', options: ['sentry', 'none'] },
          live: false,
          keywords: ['sentry', 'telemetry', 'off'],
        },
        {
          path: 'telemetry.errors',
          title: 'Crashes and warnings',
          means:
            'Tade’s crashes and warnings as issues, with source lines from its files, never yours',
          value: String(config.telemetry.errors),
          fallback: 'true',
          type: { kind: 'flag' },
          live: false,
          keywords: ['sentry', 'issues', 'telemetry'],
        },
        {
          path: 'telemetry.logs',
          title: 'What happened around them',
          means:
            'tasks, runs, the queue and schedules beside an issue: names and kinds, never what was said',
          value: String(config.telemetry.logs),
          fallback: 'true',
          type: { kind: 'flag' },
          live: false,
          keywords: ['sentry', 'telemetry'],
        },
        {
          path: 'telemetry.metrics',
          title: 'Numbers',
          means:
            'tokens, dollars, agents running and what failed, by model and task name: numbers, not the work',
          value: String(config.telemetry.metrics),
          fallback: 'true',
          type: { kind: 'flag' },
          live: false,
          keywords: ['sentry', 'telemetry', 'tokens', 'cost'],
        },
        {
          path: 'telemetry.agents',
          title: 'What agents do',
          means:
            'every turn as a trace: tools, model, tokens — never a prompt, an answer or a tool’s input',
          value: String(config.telemetry.agents),
          fallback: 'true',
          type: { kind: 'flag' },
          live: false,
          keywords: ['sentry', 'telemetry', 'traces', 'agents'],
        },
        {
          path: 'telemetry.traces',
          title: 'How much of Tade is timed',
          means:
            'the share of Tade’s own work that is timed; agents’ turns are timed whatever this says',
          value: String(config.telemetry.traces),
          fallback: '0.1',
          type: { kind: 'number', fraction: true, unit: 'of what Tade does' },
          live: false,
          keywords: ['sentry', 'telemetry', 'sampling'],
        },
        {
          path: 'telemetry.environment',
          title: 'Which Tade this is',
          means: 'the environment an issue is filed under: laptop, ci, the name of a machine',
          value: config.telemetry.environment,
          fallback: 'laptop',
          type: { kind: 'text', placeholder: 'laptop' },
          live: false,
          keywords: ['sentry', 'telemetry'],
        },
        {
          path: 'extensions.sentry.enabled',
          title: 'Read Sentry back',
          means:
            'the Sentry extension: what broke, traces and logs in the window, and an agent put on an issue',
          value: sentry.enabled === false ? 'false' : 'true',
          fallback: 'true',
          type: { kind: 'flag' },
          live: false,
          keywords: ['sentry', 'extension', 'telemetry'],
        },
        {
          path: 'extensions.sentry.org',
          title: 'Sentry organization',
          means:
            'whose Sentry the extension reads, as its slug in the address of its pages; $SENTRY_ORG when empty',
          value: sentryText('org'),
          fallback: '$SENTRY_ORG, or sentry-cli’s default',
          type: { kind: 'text', placeholder: 'acme' },
          live: true,
          keywords: ['sentry', 'org', 'organization', 'telemetry'],
        },
        {
          path: 'extensions.sentry.projects',
          title: 'Sentry projects',
          means:
            'which Sentry project each Tade project reports to: tade=tade-app, + for more than one',
          value: pairsText(sentry.projects),
          fallback: 'each project’s own name',
          type: { kind: 'text', placeholder: 'tade=tade-app, web=web-a+web-b', pairs: true },
          live: true,
          keywords: ['sentry', 'project', 'slug', 'telemetry'],
        },
        {
          path: 'extensions.sentry.url',
          title: 'Your own Sentry',
          means: 'the address of a Sentry you run yourself; sentry.io when empty',
          value: sentryText('url'),
          fallback: 'https://sentry.io',
          type: { kind: 'text', placeholder: 'https://sentry.acme.com' },
          live: true,
          keywords: ['sentry', 'url', 'self-hosted', 'telemetry'],
        },
        {
          path: 'extensions.sentry.token_env',
          title: 'Token variable',
          means:
            'the variable the read token is in; Tade never keeps a copy. $SENTRY_AUTH_TOKEN when empty',
          value: sentryText('token_env'),
          fallback: 'SENTRY_AUTH_TOKEN',
          type: { kind: 'text', placeholder: 'SENTRY_AUTH_TOKEN' },
          live: true,
          keywords: ['sentry', 'token', 'auth', 'telemetry'],
        },
        {
          path: 'extensions.sentry.brief',
          title: 'New issues in the brief',
          means: 'say how many new Sentry issues there are when you are told how things stand',
          value: sentry.brief === false ? 'false' : 'true',
          fallback: 'true',
          type: { kind: 'flag' },
          live: true,
          keywords: ['sentry', 'brief', 'telemetry'],
        },
        {
          path: 'extensions.sentry.brief_query',
          title: 'What the brief counts',
          means: 'a Sentry search; is:unresolved firstSeen:-24h when empty',
          value: sentryText('brief_query'),
          fallback: 'is:unresolved firstSeen:-24h',
          type: { kind: 'text', placeholder: 'is:unresolved firstSeen:-24h' },
          live: true,
          keywords: ['sentry', 'brief', 'query', 'telemetry'],
        },
      ],
    },
    ...(secrets.length > 0
      ? [
          {
            id: 'credentials',
            title: 'Keys and tokens',
            about:
              'The keys Tade holds for you. Paste one in and it goes to your keychain — or, where there is none, to a file of Tade’s own that only you can read. Never into config.yaml, which people commit, never into the journal, and never drawn back. A variable in your shell still wins over anything pasted.',
            keywords: [
              'key',
              'keys',
              'token',
              'secret',
              'credential',
              'api key',
              'keychain',
              'paste',
              'password',
            ],
            settings: secrets.map(
              (secret): Setting => ({
                path: `secrets.${secret.name}`,
                title: secret.title,
                means: secret.means,
                // Never what it is: only that there is one, and where.
                value: '',
                fallback: secret.from ? `kept — ${secret.from}` : 'not set',
                type: { kind: 'text', placeholder: secret.placeholder || 'paste it here' },
                live: true,
                secret: true,
                kept: secret.name,
                keywords: [
                  'key',
                  'token',
                  'secret',
                  'credential',
                  ...(secret.variables ?? []),
                  secret.name,
                ],
              }),
            ),
          },
        ]
      : []),
    {
      id: 'shortcuts',
      title: 'Shortcuts',
      about:
        'The keys Tade keeps for itself; everything else goes to your agent. Keys with shift, and ctrl with a number or m, need a terminal with the Kitty keyboard protocol.',
      // “Keys” is what a person types to find this, and what the panel used to
      // be called — but it is also what an API key is, one group above.
      keywords: ['key', 'keys', 'keyboard', 'shortcut', 'binding', 'hotkey', 'sheet'],
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
          path: 'surfaces.window.keys.agent_by_number',
          title: 'Agent by number',
          means: 'held with 1–9: the agent in that place in the sidebar',
          value: config.surfaces.window.keys.agent_by_number,
          fallback: 'ctrl',
          type: { kind: 'choice', options: [...NUMBER_MODIFIERS] },
          live: true,
        },
        {
          path: 'surfaces.window.keys.project_by_number',
          title: 'Project by number',
          means: 'held with 1–9: the project in that place along the top',
          value: config.surfaces.window.keys.project_by_number,
          fallback: 'ctrl+shift',
          type: { kind: 'choice', options: [...NUMBER_MODIFIERS] },
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

/** Every key the window keeps, by what it does: Shortcuts settings and the sheet both read this. */
export const KEY_BINDINGS: readonly {
  key: Exclude<keyof Config['surfaces']['window']['keys'], 'agent_by_number' | 'project_by_number'>
  title: string
  means: string
  fallback: string
  /** Claimed only while it means something — an approval waiting — so a letter is fine. */
  printable?: boolean
}[] = [
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
    means: 'quiet now, mid-sentence if need be, and back',
    fallback: 'ctrl+m',
  },
  {
    key: 'extensions',
    title: 'Extensions',
    means: 'turn them on and off, set them up',
    fallback: 'ctrl+shift+e',
  },
  { key: 'settings', title: 'Settings', means: 'this panel', fallback: 'ctrl+,' },
  {
    key: 'fill_bottom',
    title: 'Bottom panel fills window',
    means: 'the conversation or terminal takes the window',
    fallback: 'ctrl+shift+f',
  },
  { key: 'keys_sheet', title: 'Shortcuts', means: 'the sheet of every shortcut', fallback: 'f1' },
  {
    key: 'reload',
    title: 'Reload',
    means: 'restart the window with your changes',
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

/** The modifiers a number is held with to go to an agent or a project. */
export const NUMBER_MODIFIERS = ['ctrl', 'alt', 'ctrl+shift', 'ctrl+alt', 'off'] as const

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

/** What a setting wanted instead, when what was typed could not be read as one. */
export function wantedInstead(setting: Setting): string {
  const type = setting.type
  if (type.kind === 'number')
    return type.fraction ? 'a number from 0 to 1' : 'a whole number above zero'
  if (type.kind === 'text' && type.pairs) return `pairs, like ${type.placeholder}`
  return 'a usable value'
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

/**
 * What a setting may be shown as away from the field it is typed into. A
 * credential-shaped one is never repeated: a DSN printed by `tade config`,
 * read back after saving, or scrolled past in a list is a DSN in somebody's
 * scrollback.
 */
export function shownValue(setting: Setting, value = setting.value): string {
  if (!setting.secret || value === '') return value
  // Kept readable enough to tell one project from another: everything before
  // the `@` is the part that is not yours to show.
  const at = value.indexOf('@')
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value)?.[0] ?? ''
  return at > 0 ? `${scheme}…@${value.slice(at + 1)}` : '…'
}

/** One line per setting, for a list you choose from. */
export function describeSetting(setting: Setting): string {
  const shown = setting.value === '' ? `(${setting.fallback})` : shownValue(setting)
  return `${setting.title.padEnd(30)} ${shown}`
}

/** A map setting as it is typed: `tade=tade-app, web=web-a+web-b`. */
export function pairsText(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  return Object.entries(value as Record<string, unknown>)
    .map(([key, one]) => `${key}=${Array.isArray(one) ? one.map(String).join('+') : String(one)}`)
    .join(', ')
}

/** Pairs as they were typed, as the map their reader wants. */
export function pairsFrom(text: string): Record<string, string | string[]> {
  return Object.fromEntries(
    text
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .flatMap((part) => {
        const [key, ...rest] = part.split('=')
        const value = rest.join('=').trim()
        return key?.trim() && value
          ? [[key.trim(), value.includes('+') ? value.split('+').map((one) => one.trim()) : value]]
          : []
      }),
  )
}

/**
 * What the arrows on a number make of it, kept inside what the setting allows.
 * A share of something moves a tenth at a time and never leaves 0 to 1; a
 * count moves by one and never goes below it.
 */
export function stepped(setting: Setting, delta: number): string {
  if (setting.type.kind !== 'number') return setting.value
  const now = Number(setting.value || setting.fallback) || 0
  if (!setting.type.fraction) return String(Math.max(1, now + delta))
  // A tenth at a time, rounded: 0.1 + 0.1 is 0.30000000000000004 otherwise.
  return String(Math.min(1, Math.max(0, Math.round((now + delta * 0.1) * 10) / 10)))
}

/**
 * Put a value where it belongs in a config object, making the objects on the
 * way. Empty means "unset", which is how a setting goes back to its default
 * rather than being written down as an empty string.
 */
export function applySetting(
  config: Record<string, unknown>,
  path: string,
  value: SettingValue,
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

/** What a setting can be written down as. */
export type SettingValue =
  | string
  | number
  | boolean
  | Readonly<Record<string, string | string[]>>
  | undefined

/** What a typed answer means for a setting, or undefined if it cannot mean anything. */
export function parseSetting(setting: Setting, said: string): SettingValue {
  const text = said.trim()
  if (text === '') return undefined
  switch (setting.type.kind) {
    case 'flag':
      return /^(y|yes|true|on)$/i.test(text)
    case 'number': {
      const value = Number(text)
      if (setting.type.fraction)
        return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
      return Number.isInteger(value) && value > 0 ? value : undefined
    }
    case 'text': {
      if (!setting.type.pairs) return text
      // Nothing that reads as a pair is nothing to write: the key goes away
      // rather than being left as an empty map.
      const pairs = pairsFrom(text)
      return Object.keys(pairs).length > 0 ? pairs : undefined
    }
    default:
      return text
  }
}

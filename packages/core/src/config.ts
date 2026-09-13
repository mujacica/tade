import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, YAMLParseError } from 'yaml'
import { z } from 'zod'

// Schema for ~/.wilco/config.yaml. Objects are strict so a typo'd key is an
// error rather than a silently ignored setting.

// The drivers that exist. Names with no implementation behind them used to be
// listed here and validated clean, which reads as a promise.
const DriverId = z.enum(['pty', 'tmux'])
const Harness = z.enum(['pi'])
const RouteName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/)

/**
 * One way of running an agent. Model and provider are passed to the harness,
 * which owns credentials, so a subscription, an API key and a local endpoint
 * are all just different routes.
 */
export const WorkerRoute = z.strictObject({
  harness: Harness.default('pi'),
  /** Harness provider name, e.g. `anthropic`, `openrouter`, `ollama`. */
  provider: z.string().optional(),
  /** Model id; may be `provider/id`. */
  model: z.string().optional(),
  // `container` was here and did nothing; a sandbox you can select and not get
  // is worse than one that is not offered.
  sandbox: z.enum(['none', 'bwrap', 'seatbelt']).default('none'),
})
export type WorkerRoute = z.infer<typeof WorkerRoute>

export const ProjectConfigSchema = z.strictObject({
  root: z.string().min(1),
  brief: z.string().optional(),
  /** Names a route in `workers.routes`. */
  worker: RouteName.optional(),
  max_parallel: z.int().positive().default(1),
  /**
   * How to check the work, run by `wilco check`. Without it, `review` means
   * "finished and clean" rather than "finished, clean and verified".
   */
  test_command: z.string().min(1).optional(),
  /**
   * What this project may spend in a day. Checked before a run starts, with a
   * warning at 80%. Tokens are there for subscription providers, which report
   * no money at all.
   */
  budget: z
    .strictObject({
      usd_per_day: z.number().positive().optional(),
      tokens_per_day: z.int().positive().optional(),
    })
    .optional(),
})

/** Whether a pattern compiles, so a typo is caught at `--check` time. */
function isPattern(source: string): boolean {
  try {
    new RegExp(source)
    return true
  } catch {
    return false
  }
}

/** The editors Wilco knows how to open a file at a line in. */
export const EDITORS = [
  'code',
  'cursor',
  'windsurf',
  'zed',
  'idea',
  'subl',
  'nvim',
  'vim',
  'emacs',
  'system',
] as const

export type EditorName = (typeof EDITORS)[number]

export const ConfigSchema = z
  .strictObject({
    workspace: z
      .strictObject({
        driver: DriverId.default('pty'),
        /**
         * Where lanes go when the driver above cannot be provided — tmux asked
         * for on a machine without tmux. Reported loudly when it happens,
         * because agents that quietly stop outliving the window is exactly the
         * kind of thing you find out about at the worst moment. Set it to the
         * same value as `driver` to refuse instead.
         */
        fallback: DriverId.default('pty'),
        adopt: z.boolean().default(true),
      })
      .prefault({}),
    orchestrator: z
      .strictObject({
        harness: Harness.default('pi'),
        // The harness renders either its own terminal UI or a machine protocol,
        // never both; Wilco renders the orchestrator itself so voice and chat can
        // share one session.
        provider: z.string().optional(),
        model: z.string().optional(),
        extensions: z.string().default('~/.wilco/extensions'),
        /**
         * Look back at a task once it has finished, and write down a lesson if
         * there is one. Costs a turn per finished task; set false if you would
         * rather propose lessons yourself.
         */
        reflect: z.boolean().default(true),
      })
      .prefault({}),
    workers: z
      .strictObject({
        /** Which route to use when a project doesn't name one. */
        default: RouteName.default('default'),
        // prefault, not default: the fallback is an input to parse, so the
        // built-in route picks up harness and sandbox defaults like any other.
        routes: z.record(RouteName, WorkerRoute).prefault({ default: {} }),
      })
      .prefault({}),
    approvals: z
      .strictObject({
        // Default: never interrupt. Wilco still classifies and records every
        // tool call, so the journal stays honest even when nothing is gated.
        mode: z.enum(['bypass', 'policy']).default('bypass'),
        /** Tools that never ask, when mode is `policy`. */
        auto_allow: z.array(z.string()).default([]),
        /**
         * Your own rules, for the things only you know are dangerous here.
         * They can only make Wilco stricter — there is no `auto` to write, and
         * where one disagrees with a built-in the stricter wins. Loosening is
         * `auto_allow`, which names exact tools on purpose.
         */
        rules: z
          .array(
            z.strictObject({
              /** A regular expression, matched against the command. */
              match: z.string().min(1).refine(isPattern, 'not a usable regular expression'),
              tier: z.enum(['soft', 'hard']),
              /** One clause to say out loud. */
              reason: z.string().optional(),
            }),
          )
          .default([]),
      })
      .prefault({}),
    // Only keys that drive something. A setting Wilco accepts and ignores is
    // worse than one it doesn't have, because it reads like a promise.
    surfaces: z
      .strictObject({
        voice: z
          .strictObject({
            /** How speech becomes text. */
            stt: z
              .strictObject({
                // Local by default: what you say to your own machine about
                // your own code should not have to leave it.
                driver: z
                  .enum(['whisper-cpp', 'openai', 'groq', 'scripted'])
                  .default('whisper-cpp'),
                /** Path to a local model, where the engine needs one. */
                model: z.string().optional(),
                base_url: z.string().optional(),
                /** Keys are read from the environment, never stored here. */
                api_key_env: z.string().optional(),
                language: z.string().optional(),
                binary: z.string().optional(),
              })
              .prefault({}),
            /**
             * What Wilco is willing to interrupt you for. The engine decides
             * per event; these are the two parts that are personal rather
             * than structural.
             */
            attention: z
              .strictObject({
                /** Spoken interruptions per hour. Beyond it, things wait. */
                budget: z.int().nonnegative().optional(),
                /** Local quiet hours, like `22:00-08:00`. Omit for none. */
                quiet: z.string().optional(),
              })
              .prefault({}),
            /**
             * The key you hold to talk, and whether holding it is how.
             * Validated where it can be understood — as a key the terminal can
             * send that does not type a character — by the window that reads it.
             */
            talk: z
              .strictObject({
                key: z.string().min(1).default('ctrl+space'),
                /** hold where the terminal reports releases; toggle everywhere. */
                mode: z.enum(['hold', 'toggle']).default('hold'),
              })
              .prefault({}),
            /** Say replies and news out loud. Off keeps the earcons and the text. */
            speak: z.boolean().default(true),
            /** Where the speech comes from. */
            mic: z
              .strictObject({
                driver: z.enum(['ffmpeg', 'scripted']).default('ffmpeg'),
                /** Input device, in the backend's own terms. */
                device: z.string().optional(),
              })
              .prefault({}),
          })
          .prefault({}),
        /**
         * How the window is divided. Sizes are wishes: a sidebar wider than
         * the terminal leaves nothing to watch, so they are fitted rather than
         * obeyed. Which pane you were on is remembered separately, in
         * `<home>/window.json`, because that is the part people notice.
         */
        window: z
          .strictObject({
            sidebar_width: z.int().positive().optional(),
            strip_height: z.int().positive().optional(),
            /**
             * Where a file opens when you click it. Unset means: the editor
             * whose terminal Wilco is running in, then $VISUAL or $EDITOR,
             * then whatever the system opens that kind of file with.
             */
            editor: z.enum(EDITORS).optional(),
          })
          .prefault({}),
      })
      .prefault({}),
    projects: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), ProjectConfigSchema).default({}),
  })
  // A route name that doesn't exist is a typo that would otherwise surface as a
  // failed spawn much later, so catch it at `wilco config --check` time.
  .superRefine((config, ctx) => {
    const routes = Object.keys(config.workers.routes)
    const single = routes.length === 1
    if (!routes.includes(config.workers.default) && !single) {
      ctx.addIssue({
        code: 'custom',
        path: ['workers', 'default'],
        message: `unknown route "${config.workers.default}" (have: ${routes.join(', ') || 'none'})`,
      })
    }
    for (const [name, project] of Object.entries(config.projects)) {
      if (project.worker && !routes.includes(project.worker)) {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', name, 'worker'],
          message: `unknown route "${project.worker}" (have: ${routes.join(', ') || 'none'})`,
        })
      }
    }
  })

export type Config = z.infer<typeof ConfigSchema>
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

/**
 * Where sockets for this home go.
 *
 * Not in the home itself: a Unix socket path is capped near 104 bytes, and a
 * home under a temp directory or a deep checkout blows that — which shows up as
 * an agent that will not start, for a reason no user could act on. These are
 * runtime files with no value after a restart, so somewhere short and
 * disposable is also the honest place for them.
 */
export function runtimeDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR || tmpdir()
  return join(base, `wilco-${createHash('sha1').update(home).digest('hex').slice(0, 8)}`)
}

/** Root of Wilco's per-user state. `WILCO_HOME` overrides for tests. */
export function wilcoHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.WILCO_HOME ?? join(homedir(), '.wilco')
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(wilcoHome(env), 'config.yaml')
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export interface ConfigIssue {
  /** Dotted path to the offending key, e.g. `workspace.driver`. Empty for file-level errors. */
  path: string
  message: string
}

export type ConfigResult =
  | { ok: true; config: Config; path: string; exists: boolean }
  | { ok: false; path: string; issues: ConfigIssue[] }

export function parseConfig(text: string, path = '<inline>'): ConfigResult {
  let raw: unknown
  try {
    raw = parseYaml(text) ?? {}
  } catch (err) {
    const message = err instanceof YAMLParseError ? err.message : String(err)
    return { ok: false, path, issues: [{ path: '', message: `invalid YAML: ${message}` }] }
  }
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      path,
      issues: parsed.error.issues.map((i) => ({
        path: issuePath(i),
        message: i.message,
      })),
    }
  }
  return { ok: true, config: parsed.data, path, exists: true }
}

/** Load config from disk. A missing file is not an error: defaults apply. */
export async function loadConfig(path = defaultConfigPath()): Promise<ConfigResult> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, config: ConfigSchema.parse({}), path, exists: false }
    }
    return { ok: false, path, issues: [{ path: '', message: String(err) }] }
  }
  return parseConfig(text, path)
}

function issuePath(issue: z.core.$ZodIssue): string {
  const segments = [...issue.path]
  // Unrecognized keys report their names separately from the path.
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((k) => [...segments, k].join('.')).join(', ')
  }
  return segments.map(String).join('.')
}

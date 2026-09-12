import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, YAMLParseError } from 'yaml'
import { z } from 'zod'

// Schema for ~/.wilco/config.yaml. Objects are strict so a typo'd key is an
// error rather than a silently ignored setting.

const DriverId = z.enum(['pty', 'tmux', 'ghostty', 'kitty', 'wezterm', 'zellij'])
const WorkerId = z.string().min(1)

export const ProjectConfigSchema = z.strictObject({
  root: z.string().min(1),
  brief: z.string().optional(),
  worker: WorkerId.optional(),
  max_parallel: z.int().positive().default(1),
})

export const ConfigSchema = z.strictObject({
  workspace: z
    .strictObject({
      driver: DriverId.default('pty'),
      fallback: DriverId.default('pty'),
      adopt: z.boolean().default(true),
    })
    .prefault({}),
  orchestrator: z
    .strictObject({
      harness: z.literal('pi').default('pi'),
      model: z.string().default('anthropic/claude-opus-5'),
      extensions: z.string().default('~/.wilco/extensions'),
    })
    .prefault({}),
  workers: z
    .strictObject({
      default: WorkerId.default('claude-code'),
      protocol: z.enum(['acp', 'pty-scrape']).default('acp'),
      sandbox: z.enum(['none', 'bwrap', 'seatbelt', 'container']).default('none'),
      available: z.array(WorkerId).default(['claude-code']),
    })
    .prefault({}),
  surfaces: z
    .strictObject({
      voice: z
        .strictObject({
          backend: z.string().default('qwen-audio-agent'),
          wake: z.string().default('hey wilco'),
          tts: z.string().optional(),
        })
        .optional(),
      tui: z.strictObject({ enabled: z.boolean().default(false) }).optional(),
      web: z
        .strictObject({
          enabled: z.boolean().default(false),
          port: z.int().min(1).max(65535).default(7171),
        })
        .optional(),
    })
    .prefault({}),
  projects: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), ProjectConfigSchema).default({}),
})

export type Config = z.infer<typeof ConfigSchema>
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

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

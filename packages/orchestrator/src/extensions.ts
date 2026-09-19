import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import {
  type Config,
  expandHome,
  extensionEnabled,
  loadable,
  loadableSkills,
  loadConfig,
  runtimeDir,
  type Skill,
  skillAbout,
  skillDirs,
  writeSetting,
} from '@tade/core'
import { checksExtension } from '@tade/extension-checks'
import { depsExtension } from '@tade/extension-deps'
import { jevExtension } from '@tade/extension-jev'
import { resourcesExtension } from '@tade/extension-resources'
import { reviewExtension } from '@tade/extension-review'
import { sentryExtension } from '@tade/extension-sentry'
import {
  type Audience,
  ExtensionHost,
  type ExtensionWorkbench,
  type TadeExtension,
} from '@tade/extensions-core'
import type { WorkerExtras } from '@tade/harnesses-core'
import { branchSlug, type Workbench, type WorkbenchExtensions } from '@tade/workbench'

// Finding the tools Tade wrote for itself. The rules about which files count
// are in core and tested there; this is the part that touches the disk.

/**
 * Absolute paths of the tools the orchestrator loads, in a stable order: the
 * files in the extensions directory somebody has turned on. Being there is
 * being listed; running is what a person says.
 *
 * Never throws: no extensions directory is the normal case, not an error.
 */
export function enabledTools(
  root: string,
  settings: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
): string[] {
  return writtenTools(root)
    .filter((tool) => extensionEnabled(settings[tool.name], 'yours'))
    .map((tool) => tool.path)
}

/** Lessons a human has approved. Never throws. */
export function activeSkills(root: string): Skill[] {
  return skillsIn(skillDirs(root).active)
}

/** Lessons waiting to be read, so the brief can raise one. Never throws. */
export function proposedSkills(root: string): Skill[] {
  return skillsIn(skillDirs(root).proposed)
}

function skillsIn(dir: string): Skill[] {
  try {
    return loadableSkills(readdirSync(dir)).map((file) => {
      const text = readFileSync(join(dir, file), 'utf8')
      const about = skillAbout(text)
      return { name: basename(file, '.md'), text, ...(about ? { about } : {}) }
    })
  } catch {
    // No skills directory is the normal case, not an error.
    return []
  }
}

// ── Tade's extensions ───────────────────────────────────────────────────────
//
// The ones that ship with Tade, and what loading them gives each part: the
// orchestrator its tools and a paragraph about them, every agent the tools it
// may call, what it is told, and the harness-native pieces extensions ship.

/** A tool Tade wrote for itself: one file in the extensions directory. */
export interface WrittenTool {
  name: string
  /** Why it was written, from the comment it starts with. */
  why: string
  path: string
}

/**
 * The single-file tools in the extensions directory, in name order — the ones
 * the orchestrator loads, as against the folders, which are whole Tade
 * extensions the window holds. Reading them says what they are; nothing here
 * runs one. Never throws.
 */
export function writtenTools(root: string): WrittenTool[] {
  let files: string[]
  try {
    files = loadable(readdirSync(root))
  } catch {
    return []
  }
  return files.map((file) => ({
    name: basename(file).replace(/\.(ts|js|mjs)$/, ''),
    why: firstComment(join(root, file)),
    path: join(root, file),
  }))
}

/** What a file says it is, from the comment it starts with. Reading, never running. */
function firstComment(file: string): string {
  try {
    const first =
      readFileSync(file, 'utf8')
        .split('\n')
        .find((line) => line.trim() !== '') ?? ''
    return first
      .replace(/^\s*(\/\/+|\/\*+|\*)\s?/, '')
      .replace(/\*\/\s*$/, '')
      .trim()
  } catch {
    return ''
  }
}

/**
 * One folder, whatever Tade used to do.
 *
 * Extensions once lived in `active/` or waited in `proposed/`, and where a
 * file sat is what decided whether it ran. Now there is one directory and a
 * setting, so anything left in the old places is moved up beside the rest —
 * once, quietly, keeping whatever was already there. What was in `active/` was
 * running, so it is turned on where a config path is given: a person who
 * upgrades must not silently lose a tool they were using. `rejected/` is left
 * exactly where it is — moving something back in that somebody turned down is
 * the one thing this must never do.
 *
 * Never throws: a directory that cannot be moved is not a reason to refuse to
 * start.
 */
export function oneExtensionsFolder(root: string, configPath?: string): string[] {
  const moved: string[] = []
  for (const old of ['active', 'proposed'] as const) {
    const from = join(root, old)
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(from, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const target = join(root, entry.name)
      if (existsSync(target)) continue
      try {
        mkdirSync(root, { recursive: true })
        renameSync(join(from, entry.name), target)
      } catch {
        continue
      }
      const name = basename(entry.name).replace(/\.(ts|js|mjs)$/, '')
      moved.push(name)
      if (old === 'active' && configPath) {
        try {
          writeSetting(configPath, `extensions.${name}.enabled`, true)
        } catch {
          // A config that cannot be written is a tool that has to be turned on
          // by hand, not a window that refuses to open.
        }
      }
    }
    try {
      rmdirSync(from)
    } catch {
      // Something is still in it: leave it, and say nothing.
    }
  }
  return moved
}

/** The extensions that ship with Tade, by name. */
export const BUILTIN_EXTENSIONS: readonly TadeExtension[] = [
  checksExtension,
  depsExtension,
  jevExtension,
  reviewExtension,
  sentryExtension,
  resourcesExtension(),
]

/**
 * Every extension this window runs with: the built-in ones, then yours from
 * the extensions directory. Yours are listed whether or not they are on, and
 * only the ones turned on are loaded. Never throws: a broken one is listed as
 * broken.
 */
export async function loadExtensions(opts: {
  config: Config
  home: string
  safe?: boolean
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  /** Where the settings are, so what used to be in `active/` stays on. */
  configPath?: string
}): Promise<ExtensionHost> {
  const root = expandHome(opts.config.orchestrator.extensions)
  // What the move turned on is read back before anything loads: an extension
  // that was running before the upgrade has to still be running after it.
  const moved = oneExtensionsFolder(root, opts.configPath)
  const settings =
    moved.length > 0 && opts.configPath
      ? await loadConfig(opts.configPath).then(
          (again) => (again.ok ? again.config.extensions : opts.config.extensions),
          () => opts.config.extensions,
        )
      : opts.config.extensions
  return ExtensionHost.load({
    builtin: BUILTIN_EXTENSIONS,
    root,
    ...(opts.safe ? { safe: true } : {}),
    config: { extensions: settings, projects: opts.config.projects },
    home: opts.home,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    expandHome,
  })
}

/**
 * The tools one kind of caller is offered, written where its harness reads
 * them at launch. Somewhere short, because it rides along in an environment
 * variable and in every agent's process listing.
 */
export function writeToolList(host: ExtensionHost, audience: Audience, home: string): string {
  const dir = runtimeDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `extension-tools-${audience}.json`)
  writeFileSync(path, `${JSON.stringify(host.specs(audience), null, 2)}\n`)
  return path
}

/** What the orchestrator gets from the extensions: a paragraph about them, and their tools. */
export function orchestratorExtensions(
  host: ExtensionHost,
  home: string,
  harness: string,
): { prompt: string; extras: WorkerExtras } {
  const pieces = host.harness(harness)
  return {
    prompt: host.orchestratorPrompt(),
    extras: {
      tools: writeToolList(host, 'orchestrator', home),
      ...(pieces.extensions.length > 0 ? { extensions: pieces.extensions } : {}),
    },
  }
}

/**
 * What an open window can do for an extension: start an agent on something,
 * with its context written and its links kept.
 */
export function extensionWorkbench(
  tade: Workbench,
  onStarted?: (task: string) => void,
): ExtensionWorkbench {
  return {
    pid: process.pid,
    lanes: () =>
      tade.lanes().map((lane) => ({
        id: lane.id,
        task: lane.task,
        kind: lane.kind,
        pid: lane.pid,
        alive: lane.alive,
      })),
    async startAgent(request) {
      const base = branchSlug(request.title)
      let slug = base
      for (let n = 2; ; n++) {
        try {
          const task = await tade.createTask({
            project: request.project,
            slug,
            intent: request.prompt,
            ...(request.context ? { context: request.context } : {}),
            ...(request.links ? { links: request.links } : {}),
            by: request.by ?? 'extension:unknown',
          })
          await request.prepare?.(task.worktree)
          await tade.startAgent({ task: task.id, cwd: task.worktree, prompt: request.prompt })
          onStarted?.(task.id)
          return { task: task.id, worktree: task.worktree }
        } catch (err) {
          // The same work started twice gets a second name, not an error.
          if (!/already exists|used before/.test(err instanceof Error ? err.message : '') || n > 20)
            throw err
          slug = `${base}-${n}`
        }
      }
    },
  }
}

/** How the workbench hands extensions to agents, and runs the tools they call. */
export function workbenchExtensions(
  host: ExtensionHost,
  home: string,
  window: () => ExtensionWorkbench | null,
): WorkbenchExtensions {
  return {
    extras: ({ project, cwd, harness }) => {
      // Written for each agent as it starts, so an extension turned on or off
      // since the window opened is what the next agent gets.
      const tools = writeToolList(host, 'agent', home)
      const pieces = host.harness(harness)
      const instructions = host.agentPrompt({ name: project, root: cwd })
      return {
        tools,
        ...(instructions ? { instructions } : {}),
        ...(pieces.skills.length > 0 ? { skills: pieces.skills } : {}),
        ...(pieces.extensions.length > 0 ? { extensions: pieces.extensions } : {}),
      }
    },
    call: async (call) =>
      (
        await host.call(call.tool, call.input, {
          caller: { kind: 'agent', task: call.task, project: call.project, cwd: call.cwd },
          id: call.callId,
          tade: window(),
        })
      ).text,
  }
}

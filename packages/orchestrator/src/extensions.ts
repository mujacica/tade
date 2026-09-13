import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  type Config,
  expandHome,
  extensionDirs,
  loadable,
  loadableSkills,
  runtimeDir,
  type Skill,
  skillAbout,
  skillDirs,
} from '@wilco/core'
import { depsExtension } from '@wilco/extension-deps'
import { sentryExtension } from '@wilco/extension-sentry'
import {
  type Audience,
  ExtensionHost,
  type ExtensionWorkbench,
  type WilcoExtension,
} from '@wilco/extensions-core'
import type { WorkerExtras } from '@wilco/harnesses-core'
import { branchSlug, type Workbench, type WorkbenchExtensions } from '@wilco/workbench'

// Finding the tools Wilco wrote for itself. The rules about which files count
// are in core and tested there; this is the part that touches the disk.

/**
 * Absolute paths of the extensions that should load, in a stable order.
 * Never throws: no extensions directory is the normal case, not an error.
 */
export function activeExtensions(root: string): string[] {
  const dirs = extensionDirs(root)
  try {
    return loadable(readdirSync(dirs.active)).map((name) => join(dirs.active, name))
  } catch {
    return []
  }
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

// ── Wilco's extensions ───────────────────────────────────────────────────────
//
// The ones that ship with Wilco, and what loading them gives each part: the
// orchestrator its tools and a paragraph about them, every agent the tools it
// may call, what it is told, and the harness-native pieces extensions ship.

/** The extensions that ship with Wilco, by name. */
export const BUILTIN_EXTENSIONS: readonly WilcoExtension[] = [depsExtension, sentryExtension]

/**
 * Every extension this window runs with: the built-in ones, then yours from
 * the extensions directory's `active/`. Never throws: a broken one is listed
 * as broken.
 */
export function loadExtensions(opts: {
  config: Config
  home: string
  safe?: boolean
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
}): Promise<ExtensionHost> {
  return ExtensionHost.load({
    builtin: BUILTIN_EXTENSIONS,
    root: expandHome(opts.config.orchestrator.extensions),
    ...(opts.safe ? { safe: true } : {}),
    config: { extensions: opts.config.extensions, projects: opts.config.projects },
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
  wilco: Workbench,
  onStarted?: (task: string) => void,
): ExtensionWorkbench {
  return {
    async startAgent(request) {
      const base = branchSlug(request.title)
      let slug = base
      for (let n = 2; ; n++) {
        try {
          const task = await wilco.createTask({
            project: request.project,
            slug,
            intent: request.prompt,
            ...(request.context ? { context: request.context } : {}),
            ...(request.links ? { links: request.links } : {}),
          })
          await request.prepare?.(task.worktree)
          await wilco.startAgent({ task: task.id, cwd: task.worktree, prompt: request.prompt })
          onStarted?.(task.id)
          return { task: task.id, worktree: task.worktree }
        } catch (err) {
          // The same work started twice gets a second name, not an error.
          if (!/already exists/.test(err instanceof Error ? err.message : '') || n > 20) throw err
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
  const tools = writeToolList(host, 'agent', home)
  return {
    extras: ({ project, cwd, harness }) => {
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
          wilco: window(),
        })
      ).text,
  }
}

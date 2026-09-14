import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
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
import { resourcesExtension } from '@wilco/extension-resources'
import { sentryExtension } from '@wilco/extension-sentry'
import {
  type Audience,
  ExtensionHost,
  type ExtensionWorkbench,
  type WilcoExtension,
} from '@wilco/extensions-core'
import type { WorkerExtras } from '@wilco/harnesses-core'
import {
  branchSlug,
  recordAuthored,
  type Workbench,
  type WorkbenchExtensions,
} from '@wilco/workbench'

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

/** Something Wilco wrote for itself and is waiting on a human for. */
export interface Proposal {
  name: string
  /** A pi extension file for the orchestrator, or a folder that is a whole Wilco extension. */
  kind: 'tool' | 'extension'
  /** Why it was written, from the comment it starts with. */
  why: string
  path: string
}

/** What is waiting in `proposed/`, in name order. Never throws. */
export function proposedExtensions(root: string): Proposal[] {
  const dirs = extensionDirs(root)
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dirs.proposed, { withFileTypes: true })
  } catch {
    return []
  }
  const why = (file: string) => {
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
  return entries
    .flatMap((entry): Proposal[] => {
      const path = join(dirs.proposed, entry.name)
      if (entry.isDirectory() && existsSync(join(path, 'extension.ts'))) {
        return [{ name: entry.name, kind: 'extension', why: why(join(path, 'extension.ts')), path }]
      }
      if (entry.isFile() && loadable([entry.name]).length === 1) {
        return [
          {
            name: basename(entry.name).replace(/\.(ts|js|mjs)$/, ''),
            kind: 'tool',
            why: why(path),
            path,
          },
        ]
      }
      return []
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Approve a proposal, which moves it to `active/` to load when Wilco next
 * starts, or turn it down, which keeps it in `rejected/` so it is not proposed
 * again. Either way it is committed, so the decision can be found later.
 */
export async function decideProposal(
  root: string,
  name: string,
  verdict: 'approve' | 'reject',
): Promise<string> {
  const proposal = proposedExtensions(root).find((one) => one.name === name)
  if (!proposal) throw new Error(`nothing proposed called ${name}`)
  const dirs = extensionDirs(root)
  const to = verdict === 'approve' ? dirs.active : dirs.rejected
  mkdirSync(to, { recursive: true })
  renameSync(proposal.path, join(to, basename(proposal.path)))
  await recordAuthored(
    root,
    `${verdict === 'approve' ? 'activate' : 'reject'} ${proposal.kind} ${name}`,
  )
  return verdict === 'approve'
    ? `${name} is approved: it loads when Wilco next starts`
    : `${name} is turned down, and kept so it is not proposed again`
}

/** The extensions that ship with Wilco, by name. */
export const BUILTIN_EXTENSIONS: readonly WilcoExtension[] = [
  depsExtension,
  sentryExtension,
  resourcesExtension(),
]

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
    pid: process.pid,
    lanes: () =>
      wilco.lanes().map((lane) => ({
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
          const task = await wilco.createTask({
            project: request.project,
            slug,
            intent: request.prompt,
            ...(request.context ? { context: request.context } : {}),
            ...(request.links ? { links: request.links } : {}),
            by: request.by ?? 'extension:unknown',
          })
          await request.prepare?.(task.worktree)
          await wilco.startAgent({ task: task.id, cwd: task.worktree, prompt: request.prompt })
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
          wilco: window(),
        })
      ).text,
  }
}

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  Audience,
  BriefItem,
  Caller,
  ExecResult,
  ExtensionAction,
  ExtensionContext,
  ExtensionWorkbench,
  Link,
  Linker,
  ProjectRef,
  StatusItem,
  ToolAnswer,
  WilcoExtension,
} from './port.ts'
import { inputProblem } from './schema.ts'

// Holding the extensions a window runs with, and running them.
//
// Built-in ones ship with Wilco. Yours are folders in the extensions
// directory's `active/`, each with an `extension.ts`, and they follow the rails
// every self-written thing does: a proposal does nothing until a human moves
// it there, it loads when Wilco starts and never mid-session, and `--safe`
// starts with none of them. A broken one is listed as broken with the reason;
// it never stops the others, or Wilco, from starting.

export type ExtensionState = 'ready' | 'needs setup' | 'off' | 'broken'

export interface LoadedExtension {
  name: string
  title: string
  description: string
  source: 'built-in' | 'yours'
  /** Its folder, where it has one. */
  path: string | null
  state: ExtensionState
  /** What is wrong, or what to do before it can work. */
  problem: string | null
  tools: { name: string; description: string; for: readonly Audience[] }[]
  actions: readonly ExtensionAction[]
  /** Keys under `extensions.<name>` it does not read: a typo, most likely. */
  unknownSettings: string[]
}

/** A tool as a harness is told about it: enough to register it, nothing to run it. */
export interface ToolSpec {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
}

/** A tool being run, as the window shows it. */
export interface ExtensionRun {
  /** The harness's own call id when there is one, so progress lands on the right line. */
  id: string
  tool: string
  extension: string
  caller: Caller
  /** What it was called with, for saying which thing it worked on. */
  input: Record<string, unknown>
  state: 'running' | 'progress' | 'ok' | 'failed'
  text: string
}

export interface HostOptions {
  builtin?: readonly WilcoExtension[]
  /** The extensions directory: yours are the folders in its `active/`. */
  root?: string | null
  /** Start with none of yours. */
  safe?: boolean
  config: {
    extensions: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    projects: Readonly<Record<string, { root: string; test_command?: string | undefined }>>
  }
  home: string
  env?: Readonly<Record<string, string | undefined>>
  fetch?: typeof fetch
  exec?: ExtensionContext['exec']
  now?: () => number
  /** How long a tool may run before it is given up on. */
  timeoutMs?: number
  /** Resolve `~` in a project root. */
  expandHome?: (path: string) => string
}

interface Entry {
  extension: WilcoExtension
  loaded: LoadedExtension
  ctx: ExtensionContext
}

/** Ten minutes: a dependency update or a Seer analysis is slow, and a hung one must still end. */
const TOOL_TIMEOUT_MS = 10 * 60_000
const BRIEF_TIMEOUT_MS = 10_000

export class ExtensionHost {
  private readonly entries: Entry[]
  private readonly opts: HostOptions
  private readonly listeners = new Set<(run: ExtensionRun) => void>()
  private counter = 0

  private constructor(entries: Entry[], opts: HostOptions) {
    this.entries = entries
    this.opts = opts
  }

  /** Nothing loaded: what a surface uses when there are no extensions to run. */
  static empty(home = ''): ExtensionHost {
    return new ExtensionHost([], { config: { extensions: {}, projects: {} }, home })
  }

  static async load(opts: HostOptions): Promise<ExtensionHost> {
    const found: {
      extension: WilcoExtension | null
      source: 'built-in' | 'yours'
      path: string | null
      error: string | null
      name: string
    }[] = (opts.builtin ?? []).map((extension) => ({
      extension,
      source: 'built-in' as const,
      path: extension.root ?? null,
      error: null,
      name: extension.name,
    }))
    for (const folder of yourFolders(opts.root)) {
      const name = folder.split('/').at(-1) ?? folder
      if (opts.safe) {
        found.push({
          extension: null,
          source: 'yours',
          path: folder,
          error: 'started with --safe',
          name,
        })
        continue
      }
      try {
        const module = (await import(pathToFileURL(join(folder, 'extension.ts')).href)) as {
          default?: unknown
        }
        const made =
          typeof module.default === 'function'
            ? (module.default as () => unknown)()
            : module.default
        const extension = (await made) as WilcoExtension
        found.push({
          extension: { ...extension, root: extension.root ?? folder },
          source: 'yours',
          path: folder,
          error: null,
          name,
        })
      } catch (err) {
        found.push({ extension: null, source: 'yours', path: folder, error: why(err), name })
      }
    }

    const host = new ExtensionHost([], opts)
    const taken = new Set<string>()
    for (const one of found) {
      const extension = one.extension
      const settings = opts.config.extensions[extension?.name ?? one.name] ?? {}
      const base: LoadedExtension = {
        name: extension?.name ?? one.name,
        title: extension?.title ?? one.name,
        description: extension?.description ?? '',
        source: one.source,
        path: one.path,
        state: 'ready',
        problem: null,
        tools: (extension?.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          for: tool.for,
        })),
        actions: extension?.actions ?? [],
        unknownSettings: extension ? unknownSettings(extension, settings) : [],
      }
      if (!extension) {
        host.entries.push({
          extension: { name: one.name, title: one.name, description: '' },
          loaded: {
            ...base,
            state: one.error === 'started with --safe' ? 'off' : 'broken',
            problem: one.error,
          },
          ctx: host.context(one.name, settings),
        })
        continue
      }
      const shape = shapeProblem(extension)
      const clash = taken.has(extension.name)
        ? `another extension is already called ${extension.name}`
        : null
      taken.add(extension.name)
      const ctx = host.context(extension.name, settings)
      const entry: Entry = { extension, loaded: base, ctx }
      if (shape || clash) entry.loaded = { ...base, state: 'broken', problem: shape ?? clash }
      else await host.evaluate(entry, settings)
      host.entries.push(entry)
    }
    return host
  }

  /** Whether an extension is on and ready, with the settings it has now. */
  private async evaluate(entry: Entry, settings: Readonly<Record<string, unknown>>): Promise<void> {
    const { extension } = entry
    entry.ctx = this.context(extension.name, settings)
    const base = {
      ...entry.loaded,
      unknownSettings: unknownSettings(extension, settings),
      state: 'ready' as ExtensionState,
      problem: null,
    }
    if (settings.enabled === false) {
      entry.loaded = { ...base, state: 'off', problem: 'turned off' }
      return
    }
    const needs = await Promise.resolve()
      .then(() => extension.ready?.(entry.ctx) ?? null)
      .catch((err: unknown) => why(err))
    entry.loaded = needs ? { ...base, state: 'needs setup', problem: needs } : base
  }

  /**
   * Take new settings — turned on or off, set up — and say again which
   * extensions work. What is broken stays broken, and what `--safe` left out
   * stays out: those need Wilco started again, which is the point of them.
   */
  async reconfigure(
    extensions: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  ): Promise<void> {
    for (const entry of this.entries) {
      if (entry.loaded.state === 'broken' || (entry.loaded.source === 'yours' && this.opts.safe))
        continue
      await this.evaluate(entry, extensions[entry.extension.name] ?? {})
    }
  }

  /** How to set an extension up in the window, when it says. */
  setupOf(name: string): {
    guide: readonly string[]
    fields: {
      key: string
      label: string
      help: string
      placeholder: string
      kind: 'text' | 'list' | 'map' | 'flag'
      offers: boolean
      value: string
    }[]
    links: readonly Link[]
  } | null {
    const entry = this.entries.find((one) => one.extension.name === name)
    if (!entry?.extension.setup) return null
    const setup = safely(() => entry.extension.setup?.(entry.ctx) ?? null, null)
    if (!setup) return null
    return {
      guide: setup.guide,
      links: setup.links ?? [],
      fields: (setup.fields ?? []).map((field) => ({
        key: field.key,
        label: field.label,
        help: field.help ?? '',
        placeholder: field.placeholder ?? '',
        kind: field.kind,
        offers: field.choices !== undefined,
        value: written(entry.ctx.settings[field.key], field.kind),
      })),
    }
  }

  /** What a setup field offers to choose from, asked now. Never throws: nothing to offer is empty. */
  async choices(name: string, key: string): Promise<string[]> {
    const entry = this.entries.find((one) => one.extension.name === name)
    const field = entry?.extension.setup?.(entry.ctx).fields?.find((one) => one.key === key)
    if (!entry || !field?.choices) return []
    return [...(await field.choices(entry.ctx).catch(() => []))]
  }

  /**
   * What the ready extensions keep in the status bar, each given a moment to
   * answer. One that is slow or fails is left out this time, never waited on.
   */
  async statuses(
    wilco: ExtensionWorkbench,
    timeoutMs = 2_000,
  ): Promise<{ extension: string; title: string; item: StatusItem; viewable: boolean }[]> {
    const out: { extension: string; title: string; item: StatusItem; viewable: boolean }[] = []
    for (const entry of this.ready()) {
      if (!entry.extension.status) continue
      let timer: NodeJS.Timeout | undefined
      const item = await Promise.race([
        entry.extension.status({ ...entry.ctx, wilco }).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs)
          timer.unref?.()
        }),
      ])
      if (timer) clearTimeout(timer)
      if (item) {
        out.push({
          extension: entry.extension.name,
          title: entry.extension.title,
          item,
          viewable: entry.extension.view !== undefined,
        })
      }
    }
    return out
  }

  /** An extension's view, as markdown. Throws with the reason it could not be made. */
  async view(
    name: string,
    wilco: ExtensionWorkbench,
  ): Promise<{ title: string; markdown: string }> {
    const entry = this.ready().find((one) => one.extension.name === name)
    if (!entry?.extension.view) throw new Error(`${name} has nothing to show`)
    return {
      title: entry.extension.title,
      markdown: await entry.extension.view({ ...entry.ctx, wilco }),
    }
  }

  /** Every extension found, working or not, in the order they load. */
  list(): LoadedExtension[] {
    return this.entries.map((entry) => entry.loaded)
  }

  /** The tools a caller of this kind is offered: only from extensions that are ready. */
  specs(audience: Audience): ToolSpec[] {
    return this.ready().flatMap((entry) =>
      (entry.extension.tools ?? [])
        .filter((tool) => tool.for.includes(audience))
        .map((tool) => ({
          name: tool.name,
          label: `${entry.extension.title}: ${tool.name.slice(entry.extension.name.length + 1).replace(/_/g, ' ')}`,
          description: tool.description,
          parameters: tool.parameters,
        })),
    )
  }

  /** Every action you can run from the window, with the extension it belongs to. */
  actions(): { extension: LoadedExtension; action: ExtensionAction }[] {
    return this.ready().flatMap((entry) =>
      (entry.extension.actions ?? []).map((action) => ({ extension: entry.loaded, action })),
    )
  }

  /** The action someone asked for out loud, if what they said is one an extension listens for. */
  heard(said: string): { extension: LoadedExtension; action: ExtensionAction } | null {
    const words = said.trim().replace(/[?.!]+$/, '')
    return this.actions().find((one) => one.action.heard?.some((way) => way.test(words))) ?? null
  }

  /** Watch tools run: started, how they are going, and how they ended. */
  onRun(listener: (run: ExtensionRun) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Run a tool. Throws, in words the caller can act on, when it cannot be run
   * or fails; the answer's links are written out after its text, so a model
   * that repeats the answer repeats where to look.
   */
  async call(
    name: string,
    input: Record<string, unknown>,
    options: {
      caller: Caller
      wilco?: ExtensionWorkbench | null
      id?: string
      signal?: AbortSignal
    },
  ): Promise<ToolAnswer> {
    const entry = this.entries.find((one) =>
      one.extension.tools?.some((tool) => tool.name === name),
    )
    const tool = entry?.extension.tools?.find((one) => one.name === name)
    if (!entry || !tool) throw new Error(`no extension has a tool called ${name}`)
    if (entry.loaded.state !== 'ready') {
      throw new Error(
        `${entry.loaded.title} is ${entry.loaded.state}: ${entry.loaded.problem ?? ''}`,
      )
    }
    const audience: Audience | null =
      options.caller.kind === 'agent'
        ? 'agent'
        : options.caller.kind === 'orchestrator'
          ? 'orchestrator'
          : null
    if (audience && !tool.for.includes(audience)) {
      throw new Error(
        `${name} is not offered to ${audience === 'agent' ? 'agents' : 'the orchestrator'}`,
      )
    }
    const problem = inputProblem(tool.parameters, input)
    if (problem) throw new Error(`${name}: ${problem}`)

    const id = options.id || `x${++this.counter}`
    const emit = (state: ExtensionRun['state'], text: string) => {
      for (const listener of this.listeners) {
        try {
          listener({
            id,
            tool: name,
            extension: entry.extension.name,
            caller: options.caller,
            input,
            state,
            text,
          })
        } catch {
          // A broken listener must not break the tool.
        }
      }
    }
    const controller = new AbortController()
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    emit('running', '')
    let timer: NodeJS.Timeout | undefined
    try {
      const answer = await Promise.race([
        tool.run(input, {
          ...entry.ctx,
          caller: options.caller,
          progress: (text) => emit('progress', text),
          signal: controller.signal,
          wilco: options.wilco ?? null,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(
              new Error(
                `${name} took longer than ${Math.round((this.opts.timeoutMs ?? TOOL_TIMEOUT_MS) / 1000)}s and was given up on`,
              ),
            )
          }, this.opts.timeoutMs ?? TOOL_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
      const text = withLinks(answer.text, answer.links ?? [])
      emit('ok', text)
      return { ...answer, text }
    } catch (err) {
      emit('failed', why(err))
      throw err instanceof Error ? err : new Error(why(err))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * What the extensions have for the brief. One that cannot answer in time,
   * or fails, is left out and said in `problems`: a brief that recites an
   * error is one nobody listens to twice.
   */
  async brief(timeoutMs = BRIEF_TIMEOUT_MS): Promise<{ items: BriefItem[]; problems: string[] }> {
    const items: BriefItem[] = []
    const problems: string[] = []
    await Promise.all(
      this.ready().map(async (entry) => {
        if (!entry.extension.brief) return
        let timer: NodeJS.Timeout | undefined
        try {
          const found = await Promise.race([
            entry.extension.brief(entry.ctx),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('it did not answer in time')), timeoutMs)
              timer.unref?.()
            }),
          ])
          items.push(...found)
        } catch (err) {
          problems.push(`${entry.extension.title}: ${why(err)}`)
        } finally {
          if (timer) clearTimeout(timer)
        }
      }),
    )
    return { items, problems }
  }

  /** What the orchestrator is told: each extension it can use, and those it cannot yet. */
  orchestratorPrompt(): string {
    const lines: string[] = []
    for (const entry of this.entries) {
      const { loaded, extension } = entry
      if (loaded.state === 'ready') {
        const tools = (extension.tools ?? [])
          .filter((tool) => tool.for.includes('orchestrator'))
          .map((tool) => tool.name)
        const said = safely(() => extension.orchestrator?.(entry.ctx) ?? '')
        lines.push(
          `- ${loaded.title}${tools.length > 0 ? ` (${tools.join(', ')})` : ''}: ${said || loaded.description}`,
        )
      } else if (loaded.state === 'needs setup') {
        lines.push(
          `- ${loaded.title} is installed but not set up: ${loaded.problem}. Say so when it is asked for.`,
        )
      }
    }
    return lines.length > 0 ? ['Extensions:', ...lines].join('\n') : ''
  }

  /** What an agent working in a project is told about the extensions it can use there. */
  agentPrompt(project: ProjectRef): string {
    const lines = this.ready()
      .map((entry) => safely(() => entry.extension.agents?.(entry.ctx, project) ?? ''))
      .filter((text) => text.trim() !== '')
    return lines.join('\n\n')
  }

  /** The harness-native pieces the ready extensions ship for one harness, as absolute paths. */
  harness(id: string): { extensions: string[]; skills: string[] } {
    const out = { extensions: [] as string[], skills: [] as string[] }
    for (const entry of this.ready()) {
      const pieces = entry.extension.harness?.[id]
      if (!pieces) continue
      const root = entry.extension.root ?? process.cwd()
      const at = (path: string) => (isAbsolute(path) ? path : resolve(root, path))
      out.extensions.push(...(pieces.extensions ?? []).map(at).filter((path) => existsSync(path)))
      out.skills.push(...(pieces.skills ?? []).map(at).filter((path) => existsSync(path)))
    }
    return out
  }

  /** Text on screen the ready extensions know how to open. */
  linkers(): Linker[] {
    return this.ready().flatMap((entry) =>
      safely(() => entry.extension.linkers?.(entry.ctx) ?? [], []),
    )
  }

  private ready(): Entry[] {
    return this.entries.filter((entry) => entry.loaded.state === 'ready')
  }

  private context(name: string, settings: Readonly<Record<string, unknown>>): ExtensionContext {
    const opts = this.opts
    const expand = opts.expandHome ?? ((path: string) => path)
    const projects: ProjectRef[] = Object.entries(opts.config.projects).map(([project, value]) => ({
      name: project,
      root: expand(value.root),
      ...(value.test_command ? { test: value.test_command } : {}),
    }))
    return {
      extension: name,
      settings,
      projects,
      project(wanted) {
        if (wanted) {
          const found = projects.find((project) => project.name === wanted)
          if (found) return found
          throw new Error(
            `there is no project called ${wanted} (there is ${projects.map((project) => project.name).join(', ') || 'none'})`,
          )
        }
        const [only] = projects
        if (projects.length === 1 && only) return only
        throw new Error(
          projects.length === 0
            ? 'no projects are set up yet'
            : `which project? ${projects.map((project) => project.name).join(', ')}`,
        )
      },
      env: opts.env ?? process.env,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
      exec: opts.exec ?? run,
      home: opts.home,
      now: opts.now ?? Date.now,
    }
  }
}

/** Your extension folders: each directory in `active/` with an `extension.ts`, in name order. */
function yourFolders(root: string | null | undefined): string[] {
  if (!root) return []
  const active = join(root, 'active')
  try {
    return readdirSync(active, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'),
      )
      .map((entry) => join(active, entry.name))
      .filter((folder) => existsSync(join(folder, 'extension.ts')))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/** What is wrong with how an extension is put together, or null. */
export function shapeProblem(extension: WilcoExtension): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(extension.name ?? '')) {
    return `"${String(extension.name)}" is not a usable name: lowercase letters, digits and dashes`
  }
  if (!extension.title || !extension.description) return 'it needs a title and a description'
  const prefix = `${extension.name.replace(/-/g, '_')}_`
  const seen = new Set<string>()
  for (const tool of extension.tools ?? []) {
    if (!tool.name.startsWith(prefix)) return `its tool ${tool.name} should start with ${prefix}`
    if (!/^[a-z0-9_]+$/.test(tool.name))
      return `its tool ${tool.name} should be lowercase with underscores`
    if (seen.has(tool.name)) return `it has two tools called ${tool.name}`
    seen.add(tool.name)
    if (!tool.description) return `its tool ${tool.name} says nothing about when to use it`
    if (tool.parameters?.type !== 'object')
      return `its tool ${tool.name} takes parameters that are not an object`
    if (tool.for.length === 0) return `its tool ${tool.name} is offered to nobody`
  }
  for (const action of extension.actions ?? []) {
    if (!seen.has(action.tool))
      return `its action ${action.id} runs ${action.tool}, which it does not have`
  }
  return null
}

function unknownSettings(
  extension: WilcoExtension,
  settings: Readonly<Record<string, unknown>>,
): string[] {
  const known = new Set(['enabled', ...(extension.settings ?? []).map((setting) => setting.key)])
  return Object.keys(settings).filter((key) => !known.has(key))
}

/** A setting as it is typed into its field. */
function written(value: unknown, kind: 'text' | 'list' | 'map' | 'flag'): string {
  if (kind === 'flag') return value === true ? 'on' : value === false ? 'off' : ''
  if (value === undefined || value === null) return ''
  if (kind === 'list' && Array.isArray(value)) return value.map(String).join(', ')
  if (kind === 'map' && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, one]) => `${key}=${Array.isArray(one) ? one.join('+') : String(one)}`)
      .join(', ')
  }
  return String(value)
}

/** A field as typed, as the setting it becomes. Empty is no setting at all. */
export function settingFrom(text: string, kind: 'text' | 'list' | 'map' | 'flag'): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (kind === 'flag') return trimmed === 'on'
  const parts = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (kind === 'list') return parts
  if (kind === 'map') {
    return Object.fromEntries(
      parts.flatMap((part) => {
        const [key, ...rest] = part.split('=')
        const value = rest.join('=').trim()
        return key?.trim() && value
          ? [[key.trim(), value.includes('+') ? value.split('+').map((one) => one.trim()) : value]]
          : []
      }),
    )
  }
  return trimmed
}

function withLinks(text: string, links: readonly Link[]): string {
  const missing = links.filter((link) => !text.includes(link.url))
  if (missing.length === 0) return text
  return `${text.trimEnd()}\n\n${missing.map((link) => `- ${link.title}: ${link.url}`).join('\n')}`
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  // Its own process group, so the terminal Wilco runs in is never retitled
  // after it. `execFile` hands `detached` to the spawn beneath; its types omit it.
  const spawnOptions = {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    detached: true,
  }
  return new Promise((done) => {
    execFile(command, [...args], spawnOptions, (err, stdout, stderr) => {
      const code = err
        ? typeof (err as { code?: unknown }).code === 'number'
          ? Number((err as { code?: unknown }).code)
          : 1
        : 0
      done({
        code,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? (err ? err.message : '')),
      })
    })
  })
}

function safely<T>(make: () => T, otherwise?: T): T {
  try {
    return make()
  } catch {
    return otherwise ?? ('' as T)
  }
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

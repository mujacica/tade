import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extensionEnabled, findSecret, secretPath } from '@tade/core'
import type {
  Audience,
  BriefItem,
  Caller,
  CautionAnswer,
  CautionRequest,
  ExecResult,
  ExtensionAction,
  ExtensionContext,
  ExtensionSetting,
  ExtensionWatch,
  ExtensionWorkbench,
  Finding,
  JsonSchema,
  Link,
  Linker,
  ListRow,
  MeantRequest,
  ProjectRef,
  StatusItem,
  TadeExtension,
  ToolAnswer,
  ViewAt,
  ViewTab,
  WatchAgent,
  WatchContext,
} from './port.ts'
import { inputProblem } from './schema.ts'
import { everyMs, shapeProblem } from './shape.ts'

// Holding the extensions a window runs with, and running them.
//
// Built-in ones ship with Tade. Yours are the folders in the extensions
// directory, each with an `extension.ts`, and they follow the rails every
// self-written thing does: sitting there is being listed, not being loaded —
// one nobody has turned on is never even imported — turning one on takes
// effect when Tade next starts and never mid-session, and `--safe` starts
// with none of them. A broken one is listed as broken with the reason; it
// never stops the others, or Tade, from starting.

export type ExtensionState = 'ready' | 'needs setup' | 'off' | 'broken'

export interface LoadedExtension {
  name: string
  title: string
  description: string
  /**
   * How it is used, as it says itself: empty for one that is off or broken,
   * which is never imported and so has nothing to say beyond its name.
   */
  workflow: readonly string[]
  /**
   * Where it came from: Tade's own, a folder of yours, or an MCP server
   * somebody turned on. `mcp` is not a third kind of extension — it is one
   * produced from a server declaration, and the difference that matters is
   * that it was only ever handed over because it is already on, so there is
   * no second switch under `extensions.<name>` to ask about.
   */
  source: 'built-in' | 'yours' | 'mcp'
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

/** One field of an extension's setup, as a surface draws it. */
export interface SetupFieldView {
  key: string
  label: string
  help: string
  placeholder: string
  kind: 'text' | 'list' | 'map' | 'flag' | 'secret'
  offers: boolean
  /** What is in it now. Always empty for a secret: a credential is never drawn back. */
  value: string
  /** For a secret: where the one it has now is (`$SENTRY_AUTH_TOKEN`), or empty. */
  have: string
}

/** A credential an extension asks for, and where it is now. */
export interface DeclaredSecret {
  /** The setting it is, in the config: `extensions.jev.key`. */
  path: string
  extension: string
  /** The extension's title, for saying whose key it is. */
  title: string
  key: string
  /** What to call the field: `API key`. */
  label: string
  means: string
  /** The environment variables it is read from first, in order. */
  variables: readonly string[]
  /** What is written in the config, as it is written. A key is drawn as itself. */
  value: string
  /** Where the one that is used comes from, or null when there is none. */
  from: string | null
  placeholder: string
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
  builtin?: readonly TadeExtension[]
  /**
   * Extensions produced from MCP servers somebody turned on, one per server.
   * Loaded last, after Tade's own and after yours, so a server can never take
   * a name either of them wanted — it loses it and is listed as broken with
   * why. What is in them is `tools` and nothing else, which the broker's own
   * conformance suite asserts.
   */
  brokered?: readonly TadeExtension[]
  /** The extensions directory: yours are the folders in it. */
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
  /** How long an extension has to say whether it is ready. `READY_MS_LIMIT` unless given. */
  readyMs?: number
  /** Resolve `~` in a project root. */
  expandHome?: (path: string) => string
}

/** A watch an extension offers, as a schedule is turned on with it. */
export interface WatchOffer {
  /** `<extension>.<id>`, which is what a schedule names it by. */
  id: string
  extension: string
  title: string
  means: string
  /** How often it looks unless told otherwise. */
  every: string
  /** What it can be turned on with; null when nothing. */
  input: JsonSchema | null
  /** What it is for when nobody says: work started on each finding, or somebody told. */
  offers: 'ask' | 'agent'
  /** Whether it is on without anybody turning it on, once its extension can look. */
  standing: boolean
  /** Whether its look reaches off this machine, so an offline machine may hold it. */
  network: boolean
  /** How many of one look's findings to act on, where the watch says two is wrong for it. */
  most: number | null
  /** Why it cannot look now — its extension needs setting up, is off, is broken — or null. */
  problem: string | null
}

interface Entry {
  extension: TadeExtension
  loaded: LoadedExtension
  ctx: ExtensionContext
  /**
   * Whether its module was imported this time round. One of yours that is off
   * was not, so nothing about it can change until Tade starts again.
   */
  imported: boolean
}

/** Why an extension cannot be used now, or null when it is ready. */
function notReady(entry: Entry): string | null {
  const { state, title, problem } = entry.loaded
  if (state === 'ready') return null
  // "Turned off", "not turned on", "left out by --safe": what it says is why,
  // and each of those is a different thing to do about it.
  if (state === 'off') return `${title} is ${problem ?? 'turned off'}`
  const because = problem ? `: ${problem}` : ''
  return state === 'needs setup'
    ? `${title} needs setting up${because}`
    : `${title} is broken${because}`
}

/** One asker's own stop, which also stops when whoever asked has stopped waiting. */
function stopAt(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

/** A promise that settles in time, or is given up on — its work told to stop — with why. */
async function inTime<T>(
  work: Promise<T>,
  limit: number,
  late: string,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(late))
        }, limit)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** A section an extension keeps in the sidebar, as the window draws it. */
export interface ListSection {
  /** `<extension>.<id>`: what the window names the section by. */
  id: string
  extension: string
  title: string
  filters: readonly { id: string; title: string }[]
  /** Which filter these rows are for. */
  filter: string
  rows: readonly ListRow[]
  /** Why there are no rows, when something is wrong. Never a throw. */
  problem: string | null
  /** When it was last asked, so the window can say how fresh it is. */
  at: number
}

/** A list is asked for on its own clock; a slow one is left with what it had. */
const LIST_TIMEOUT_MS = 10_000

/** Ten minutes: a dependency update or a Seer analysis is slow, and a hung one must still end. */
const TOOL_TIMEOUT_MS = 10 * 60_000
/** A watch's look is meant to be cheap: a minute is already a slow one. */
const WATCH_TIMEOUT_MS = 60_000
const BRIEF_TIMEOUT_MS = 10_000
/**
 * An agent is held at a tool call while this is asked, so it is the shortest
 * deadline there is: past it, the call is answered the way it would have been
 * answered with nobody reading it at all.
 */
const CAUTION_TIMEOUT_MS = 4_000
/**
 * Somebody is looking at the box while this is asked, and what they typed is
 * still being matched the way it always was: past this, they have their
 * answer already and a later one would move the list under their hands.
 */
const MEANT_TIMEOUT_MS = 2_500
/**
 * `ready()` is declared never to dial, so this is generous — and it is here
 * because an extension is somebody else's code and this is awaited from the
 * Settings page, where a key has just been saved. A window that stops
 * answering is worse than an extension that is called not ready.
 */
const READY_MS_LIMIT = 5_000

export class ExtensionHost {
  private readonly entries: Entry[]
  private readonly opts: HostOptions
  private readonly listeners = new Set<(run: ExtensionRun) => void>()
  /** The last answer from each sidebar section, so drawing costs nothing. */
  private readonly listed = new Map<string, ListSection>()
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
      extension: TadeExtension | null
      source: 'built-in' | 'yours' | 'mcp'
      path: string | null
      /** It would not load, and this is why. */
      error: string | null
      /** It was not loaded at all, and this is why. Nothing is wrong with it. */
      off: string | null
      /** What it says it is, read from its file rather than run. */
      about: string
      name: string
    }[] = (opts.builtin ?? []).map((extension) => ({
      extension,
      source: 'built-in' as const,
      path: extension.root ?? null,
      error: null,
      off: null,
      about: '',
      name: extension.name,
    }))
    for (const folder of yourFolders(opts.root)) {
      const name = folder.split('/').at(-1) ?? folder
      // Not imported until somebody has turned it on: importing a module runs
      // whatever is at the top of it, so "listed and off" has to mean the file
      // was read and not executed. Never asked and turned down are different
      // answers, and the one to do something about is the first.
      const said = opts.config.extensions[name]?.enabled
      const off = opts.safe
        ? 'left out by --safe'
        : extensionEnabled(opts.config.extensions[name], 'yours')
          ? null
          : said === false
            ? 'turned off'
            : 'not turned on'
      if (off) {
        found.push({
          extension: null,
          source: 'yours',
          path: folder,
          error: null,
          off,
          about: firstComment(join(folder, 'extension.ts')),
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
        const extension = (await made) as TadeExtension
        found.push({
          extension: { ...extension, root: extension.root ?? folder },
          source: 'yours',
          path: folder,
          error: null,
          off: null,
          about: '',
          name,
        })
      } catch (err) {
        found.push({
          extension: null,
          source: 'yours',
          path: folder,
          error: why(err),
          off: null,
          about: firstComment(join(folder, 'extension.ts')),
          name,
        })
      }
    }

    // Last, on purpose: Tade's own and yours-in-code have already taken the
    // names they wanted, so a server that asks for one of them loses it.
    for (const extension of opts.brokered ?? []) {
      found.push({
        extension,
        source: 'mcp' as const,
        path: null,
        error: null,
        off: null,
        about: '',
        name: extension.name,
      })
    }

    const host = new ExtensionHost([], opts)
    const taken = new Set<string>()
    for (const one of found) {
      const extension = one.extension
      const settings = opts.config.extensions[extension?.name ?? one.name] ?? {}
      const base: LoadedExtension = {
        name: extension?.name ?? one.name,
        title: extension?.title ?? one.name,
        description: extension?.description ?? one.about,
        workflow: extension?.workflow ?? [],
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
          extension: { name: one.name, title: one.name, description: one.about },
          loaded: {
            ...base,
            state: one.off ? 'off' : 'broken',
            problem: one.off ?? one.error,
          },
          ctx: host.context(one.name, settings),
          imported: false,
        })
        continue
      }
      const shape = shapeProblem(extension)
      const clash = taken.has(extension.name)
        ? `another extension is already called ${extension.name}`
        : null
      // One name for one extension: the folder is what somebody turns on and
      // what its settings are under, so an extension that calls itself
      // something else would be set up in one place and switched in another.
      const named =
        one.source === 'yours' && extension.name !== one.name
          ? `its folder is called ${one.name} but it calls itself ${extension.name}: they have to match, because the folder is the name you turn on`
          : null
      taken.add(extension.name)
      const ctx = host.context(extension.name, settings, extension.settings ?? [])
      const entry: Entry = { extension, loaded: base, ctx, imported: true }
      if (shape || clash || named)
        entry.loaded = { ...base, state: 'broken', problem: shape ?? clash ?? named }
      else await host.evaluate(entry, settings)
      host.entries.push(entry)
    }
    return host
  }

  /** Whether an extension is on and ready, with the settings it has now. */
  private async evaluate(entry: Entry, settings: Readonly<Record<string, unknown>>): Promise<void> {
    const { extension } = entry
    entry.ctx = this.context(extension.name, settings, extension.settings ?? [])
    const base = {
      ...entry.loaded,
      unknownSettings: unknownSettings(extension, settings),
      state: 'ready' as ExtensionState,
      problem: null,
    }
    // A brokered one was only ever handed over because a person turned its
    // server on: one switch, and it is `mcp.servers.<name>.enabled`. Asking a
    // second question under `extensions.mcp-<server>` would be a place to put
    // something that turns nothing on.
    if (entry.loaded.source !== 'mcp' && !extensionEnabled(settings, entry.loaded.source)) {
      entry.loaded = { ...base, state: 'off', problem: 'turned off' }
      return
    }
    // With a deadline, like everything else Tade waits on. `ready()` is
    // declared not to dial, but an extension is somebody else's code and this
    // is awaited from the Settings page: one that never answers would leave a
    // key that was saved looking like a key that was not.
    const needs = await inTime(
      Promise.resolve().then(() => extension.ready?.(entry.ctx) ?? null),
      this.opts.readyMs ?? READY_MS_LIMIT,
      `${extension.name} did not say whether it is ready, so it is treated as not`,
      stopAt(undefined),
    ).catch((err: unknown) => why(err))
    entry.loaded = needs ? { ...base, state: 'needs setup', problem: needs } : base
  }

  /**
   * Take new settings — turned on or off, set up — and say again which
   * extensions work. What is broken stays broken, what `--safe` left out stays
   * out, and one of yours that was off when the window opened was never
   * imported, so turning it on says when it will run rather than running it:
   * all three need Tade started again, which is the point of them.
   */
  async reconfigure(
    extensions: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  ): Promise<void> {
    for (const entry of this.entries) {
      if (entry.loaded.state === 'broken') continue
      const settings = extensions[entry.extension.name] ?? {}
      if (!entry.imported) {
        if (this.opts.safe) continue
        entry.loaded = {
          ...entry.loaded,
          state: 'off',
          problem: extensionEnabled(settings, 'yours')
            ? 'turned on — it loads next time Tade starts'
            : 'not turned on',
        }
        continue
      }
      await this.evaluate(entry, settings)
    }
  }

  /**
   * Take the projects as the config now has them, from whoever holds it.
   *
   * Nothing is evaluated again: which projects there are changes what an
   * extension may be asked *about*, never whether it works, so opening one
   * costs an assignment and no `ready()` call.
   */
  useProjects(projects: HostOptions['config']['projects']): void {
    this.opts.config = { ...this.opts.config, projects }
  }

  /** How to set an extension up in the window, when it says. */
  setupOf(name: string): {
    guide: readonly string[]
    fields: SetupFieldView[]
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
        // A credential is drawn like anything else: it is in the config, in
        // plain text, and a key you cannot read is a key you cannot check.
        value: written(entry.ctx.settings[field.key], field.kind),
        have: field.kind === 'secret' ? (this.secretHeld(name, field.key)?.from ?? '') : '',
      })),
    }
  }

  /**
   * Every credential the extensions declare, and where each one is now. What
   * Settings and the extensions page both draw a field from, so pasting a key
   * looks and behaves the same wherever it is done.
   */
  secrets(): DeclaredSecret[] {
    const out: DeclaredSecret[] = []
    for (const entry of this.entries) {
      const setup = entry.extension.setup
        ? safely(() => entry.extension.setup?.(entry.ctx) ?? null, null)
        : null
      for (const setting of entry.extension.settings ?? []) {
        if (setting.kind !== 'secret') continue
        const field = setup?.fields?.find((one) => one.key === setting.key)
        out.push({
          path: secretPath(entry.extension.name, setting.key),
          extension: entry.extension.name,
          title: entry.extension.title,
          key: setting.key,
          label: field?.label ?? setting.key.replace(/_/g, ' '),
          means: setting.means,
          variables: variablesFor(setting, entry.ctx.settings),
          value: written(entry.ctx.settings[setting.key], 'text'),
          from: this.secretHeld(entry.extension.name, setting.key)?.from ?? null,
          placeholder: field?.placeholder ?? '',
        })
      }
    }
    return out
  }

  /**
   * The variable that will go on winning over a key somebody has just pasted,
   * or null. Whoever saves it writes the setting itself — a credential is a
   * setting like any other now — but only the host knows which variables that
   * extension reads, and a key that is kept and not used is the worst of both.
   */
  secretBeatenBy(name: string, key: string): string | null {
    const entry = this.entries.find((one) => one.extension.name === name)
    const setting = entry?.extension.settings?.find(
      (one) => one.key === key && one.kind === 'secret',
    )
    if (!entry || !setting) throw new Error(`${name} has no key called ${key}`)
    const env = this.opts.env ?? process.env
    const beaten = variablesFor(setting, entry.ctx.settings).find((one) => env[one]?.trim())
    return beaten ? `$${beaten}` : null
  }

  /** What a declared secret is now, without its value leaving this object. */
  private secretHeld(name: string, key: string): { from: string } | null {
    const entry = this.entries.find((one) => one.extension.name === name)
    const found = safely(() => entry?.ctx.secret(key) ?? null, null)
    return found ? { from: found.from } : null
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
    tade: ExtensionWorkbench,
    timeoutMs = 2_000,
  ): Promise<{ extension: string; title: string; item: StatusItem; viewable: boolean }[]> {
    const out: { extension: string; title: string; item: StatusItem; viewable: boolean }[] = []
    for (const entry of this.ready()) {
      if (!entry.extension.status) continue
      let timer: NodeJS.Timeout | undefined
      const item = await Promise.race([
        entry.extension
          .status({ ...entry.ctx, tade: asExtension(tade, entry.extension.name) })
          .catch(() => null),
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

  /**
   * The sections the ready extensions keep in the sidebar, each asked again
   * only when its own `every` has passed. Every caller reads the same answer:
   * status, the rows, the tools and the brief share one poll, and drawing
   * never asks anybody anything.
   *
   * Never throws. A list that fails, hangs or is not ready is a section with
   * a problem on it, which the window draws as one quiet row.
   */
  async lists(
    tade: ExtensionWorkbench,
    options: { filters?: Readonly<Record<string, string>>; timeoutMs?: number } = {},
  ): Promise<ListSection[]> {
    const now = (this.opts.now ?? Date.now)()
    const out: ListSection[] = []
    for (const entry of this.entries) {
      for (const list of entry.extension.lists ?? []) {
        const id = `${entry.extension.name}.${list.id}`
        const filters = list.filters ?? []
        const filter = options.filters?.[id] ?? filters[0]?.id ?? ''
        const known = this.listed.get(id)
        const every = everyMs(list.every)
        const fresh = known !== undefined && known.filter === filter && now - known.at < every
        if (fresh) {
          out.push({ ...known, id, extension: entry.extension.name, title: list.title, filters })
          continue
        }
        const problem = notReady(entry)
        const asked: ListSection = problem
          ? {
              id,
              extension: entry.extension.name,
              title: list.title,
              filters,
              filter,
              rows: [],
              problem,
              at: now,
            }
          : await this.askList(entry, list.title, id, filters, filter, tade, now, options.timeoutMs)
        this.listed.set(id, asked)
        out.push(asked)
      }
    }
    return out
  }

  private async askList(
    entry: Entry,
    title: string,
    id: string,
    filters: readonly { id: string; title: string }[],
    filter: string,
    tade: ExtensionWorkbench,
    now: number,
    timeoutMs?: number,
  ): Promise<ListSection> {
    const list = entry.extension.lists?.find((one) => `${entry.extension.name}.${one.id}` === id)
    const base = { id, extension: entry.extension.name, title, filters, filter, at: now }
    if (!list) return { ...base, rows: [], problem: 'it is gone' }
    const controller = new AbortController()
    try {
      const rows = await inTime(
        Promise.resolve().then(() =>
          list.rows({ ...entry.ctx, tade: asExtension(tade, entry.extension.name) }, filter),
        ),
        timeoutMs ?? LIST_TIMEOUT_MS,
        `${id} did not answer in time`,
        controller,
      )
      return { ...base, rows: [...rows], problem: null }
    } catch (err) {
      return { ...base, rows: [], problem: why(err) }
    }
  }

  /**
   * An extension's view, as markdown, for the tab and window it is being read
   * in. Throws with the reason it could not be made.
   *
   * What tabs there are and whether it is windowed are the extension's own
   * declarations, handed back with the page so the window can draw them without
   * asking anybody: a page that offers none is drawn exactly as every page was
   * before tabs existed.
   */
  async view(
    name: string,
    tade: ExtensionWorkbench,
    at: ViewAt = { tab: '', since: 0, window: 'today' },
  ): Promise<{
    title: string
    markdown: string
    tabs: readonly ViewTab[]
    windowed: boolean
  }> {
    const entry = this.ready().find((one) => one.extension.name === name)
    if (!entry?.extension.view) throw new Error(`${name} has nothing to show`)
    const tabs = entry.extension.viewTabs ?? []
    return {
      title: entry.extension.title,
      tabs,
      windowed: entry.extension.viewWindowed === true,
      markdown: await entry.extension.view(
        { ...entry.ctx, tade: asExtension(tade, entry.extension.name) },
        // A tab nobody offered is the first one there is: the panel remembers
        // which tab you were on per extension, and an extension whose tabs were
        // renamed must not answer about one it no longer has.
        { ...at, tab: tabs.some((tab) => tab.id === at.tab) ? at.tab : (tabs[0]?.id ?? '') },
      ),
    }
  }

  /** Every extension found, working or not, in the order they load. */
  list(): LoadedExtension[] {
    return this.entries.map((entry) => entry.loaded)
  }

  /**
   * Every watch there is, as `<extension>.<id>`, with why it cannot look now
   * when its extension is not ready: one that needs setting up is still worth
   * offering, and saying what it needs.
   */
  watches(): WatchOffer[] {
    return this.entries.flatMap((entry) =>
      (entry.extension.watches ?? []).map((watch) => ({
        id: `${entry.extension.name}.${watch.id}`,
        extension: entry.extension.name,
        title: watch.title,
        means: watch.means,
        every: watch.every,
        input: watch.input ?? null,
        offers: watch.offers ?? 'agent',
        standing: watch.standing === true,
        network: watch.network === true,
        most: watch.most ?? null,
        problem: notReady(entry),
      })),
    )
  }

  /**
   * Why a watch cannot be turned on with this input, or null when it can: one
   * that does not exist, or input it does not take. An extension that is not
   * ready yet is no reason: a watch waits for it, and says so when it looks.
   */
  watchProblem(id: string, input: Readonly<Record<string, unknown>>): string | null {
    const found = this.watchCalled(id)
    if ('problem' in found) return found.problem
    return found.watch.input ? inputProblem(found.watch.input, { ...input }) : null
  }

  /**
   * Look with a watch, for a project: what it found, where the next look
   * starts, and what an agent on a finding would be told. Throws with why it
   * could not look — no such watch, an extension that is not ready, a look that
   * failed, took too long, or found something it could not name.
   */
  async look(
    id: string,
    request: {
      project: string
      input: Readonly<Record<string, unknown>>
      since: string | null
      turnedOn: string
      timeoutMs?: number
      /** The window, for a watch that looks at what Tade is running. */
      tade?: ExtensionWorkbench | null
    },
  ): Promise<{
    found: Finding[]
    since: string | null
    /** Why it found nothing, where the watch had something to say about that. */
    said: string | null
    agent: (finding: Finding) => Promise<WatchAgent>
  }> {
    const called = this.watchCalled(id)
    if ('problem' in called) throw new Error(called.problem)
    const { entry, watch } = called
    const problem = notReady(entry)
    if (problem) throw new Error(problem)
    const controller = new AbortController()
    const ctx: WatchContext = {
      ...entry.ctx,
      watching: entry.ctx.project(request.project),
      input: request.input,
      since: request.since,
      turnedOn: request.turnedOn,
      tade: request.tade ?? null,
      signal: controller.signal,
    }
    const limit = request.timeoutMs ?? WATCH_TIMEOUT_MS
    const looked = await inTime(
      Promise.resolve().then(() => watch.check(ctx)),
      limit,
      `${id} took longer than ${Math.round(limit / 1000)}s to look, and was given up on`,
      controller,
    )
    const found: Finding[] = []
    for (const finding of looked.found ?? []) {
      if (typeof finding?.key !== 'string' || finding.key === '' || !finding.title) {
        throw new Error(`${id} found something without a key and a title to know it by`)
      }
      // The same thing said twice in one look is one finding.
      if (!found.some((one) => one.key === finding.key)) found.push(finding)
    }
    return {
      found,
      since: looked.since ?? request.since,
      // Only ever about a look that found nothing: what was found says what it
      // is itself, and a sentence beside a finding would be a second wording of
      // the same thing for nobody to read.
      said: found.length === 0 && looked.said ? looked.said : null,
      agent: async (finding) => {
        // A watch with nothing to start is not a broken one: it is told to
        // somebody, which is what it said it was for.
        const ask = watch.agent
        if (!ask) {
          throw new Error(
            `${id} has nothing to start work on: what it finds is told to the orchestrator`,
          )
        }
        const agent = await inTime(
          Promise.resolve().then(() => ask(finding, ctx)),
          limit,
          `${id} took longer than ${Math.round(limit / 1000)}s to say what to tell an agent about ${finding.key}`,
          controller,
        )
        if (!agent?.title || !agent.prompt) {
          throw new Error(`${id} said nothing to tell an agent about ${finding.key}`)
        }
        return agent
      },
    }
  }

  /** A watch by its `<extension>.<id>`, or why there is none. */
  private watchCalled(id: string): { entry: Entry; watch: ExtensionWatch } | { problem: string } {
    const dot = id.indexOf('.')
    const name = dot < 0 ? id : id.slice(0, dot)
    const entry = this.entries.find((one) => one.extension.name === name)
    const watch = entry?.extension.watches?.find((one) => one.id === id.slice(dot + 1))
    if (entry && watch && dot > 0) return { entry, watch }
    const all = this.watches().map((one) => one.id)
    return {
      problem: `there is no watch called ${id}${all.length > 0 ? ` (there is ${all.join(', ')})` : ''}`,
    }
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
      tade?: ExtensionWorkbench | null
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
          tade: options.tade ? asExtension(options.tade, entry.extension.name) : null,
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

  /**
   * What the extensions make of a tool call the rules let through, with the
   * agent waiting: the strictest thing any of them says, or nothing.
   *
   * It can only ever come back stricter — `withCaution` is what applies it,
   * and there is no answer here that allows anything. One that fails or runs
   * late is left out and said in `problems`, because a gate that quietly
   * stopped reading is the silence this whole path exists to avoid.
   */
  async caution(
    request: CautionRequest,
    timeoutMs = CAUTION_TIMEOUT_MS,
  ): Promise<{ caution: (CautionAnswer & { by: string }) | null; problems: string[] }> {
    const answers: (CautionAnswer & { by: string })[] = []
    const problems: string[] = []
    await Promise.all(
      this.ready().map(async (entry) => {
        const read = entry.extension.caution
        if (!read) return
        // Its own, so the deadline actually stops the work rather than only
        // stopping the waiting: what is late is money nobody is going to use.
        const controller = stopAt(request.signal)
        try {
          const said = await inTime(
            Promise.resolve().then(() =>
              read(entry.ctx, { ...request, signal: controller.signal }),
            ),
            timeoutMs,
            `it did not answer within ${timeoutMs}ms`,
            controller,
          )
          if (said) answers.push({ ...said, by: entry.extension.name })
        } catch (err) {
          problems.push(`${entry.extension.title}: ${why(err)}`)
        }
      }),
    )
    const hard = answers.find((answer) => answer.tier === 'hard')
    return { caution: hard ?? answers[0] ?? null, problems }
  }

  /**
   * Which of the things in front of somebody they meant, asked of whoever
   * offers to read a sentence. Only ids that were offered come back, in the
   * order they were answered, and one extension failing never hides another's
   * answer: what is in the box is already matched the ordinary way, and this
   * can only add to it.
   */
  async meant(
    request: MeantRequest,
    timeoutMs = MEANT_TIMEOUT_MS,
  ): Promise<{ ids: string[]; problems: string[] }> {
    const offered = new Set(request.choices.map((choice) => choice.id))
    const ids: string[] = []
    const problems: string[] = []
    await Promise.all(
      this.ready().map(async (entry) => {
        const read = entry.extension.meant
        if (!read) return
        const controller = stopAt(request.signal)
        try {
          const said = await inTime(
            Promise.resolve().then(() =>
              read(entry.ctx, { ...request, signal: controller.signal }),
            ),
            timeoutMs,
            `it did not answer within ${timeoutMs}ms`,
            controller,
          )
          // Only what was offered: an id nobody put in front of it is not an
          // answer to this question, and the window would not know what to do
          // with one anyway.
          for (const id of said) if (offered.has(id) && !ids.includes(id)) ids.push(id)
        } catch (err) {
          problems.push(`${entry.extension.title}: ${why(err)}`)
        }
      }),
    )
    return { ids, problems }
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
        for (const watch of extension.watches ?? []) {
          lines.push(
            `  Watch ${extension.name}.${watch.id} (every ${watch.every} unless told otherwise): ${watch.means}`,
          )
        }
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

  private context(
    name: string,
    settings: Readonly<Record<string, unknown>>,
    declared: readonly ExtensionSetting[] = [],
  ): ExtensionContext {
    const opts = this.opts
    return {
      extension: name,
      settings,
      // Asked of the config at every read, never held: see `projectsOf`.
      get projects() {
        return projectsOf(opts)
      },
      project(wanted) {
        const projects = projectsOf(opts)
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
      secret: (key) => {
        const found = declared.find((setting) => setting.key === key)
        if (found?.kind !== 'secret') {
          throw new Error(
            `${name} asked for the secret ${key}, which it does not declare as a secret setting`,
          )
        }
        // The environment first, then the setting itself: one rule, in one
        // place, so nothing here can disagree with what Settings draws.
        return findSecret({
          settings,
          key,
          env: opts.env ?? process.env,
          variables: variablesFor(found, settings),
        })
      },
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
      exec: opts.exec ?? run,
      home: opts.home,
      now: opts.now ?? Date.now,
    }
  }
}

/**
 * The projects as the config has them *now*, resolved against the machine's `~`.
 *
 * Read at every call and never held. A list read once, when the extensions
 * loaded, is how `there is no project called zahlenzauber (there is tade,
 * tade-web)` came to be said about a project that had been open for an hour —
 * by three watches, once every ten minutes, until Tade was started again.
 */
function projectsOf(opts: HostOptions): ProjectRef[] {
  const expand = opts.expandHome ?? ((path: string) => path)
  return Object.entries(opts.config.projects).map(([project, value]) => ({
    name: project,
    root: expand(value.root),
    ...(value.test_command ? { test: value.test_command } : {}),
  }))
}

/**
 * The window as one extension sees it: whatever it starts is marked as its
 * own, so an agent's tab and the journal say where the work came from.
 */
function asExtension(tade: ExtensionWorkbench, name: string): ExtensionWorkbench {
  return {
    pid: tade.pid,
    lanes: () => tade.lanes(),
    agents: () => tade.agents(),
    startAgent: (request) => tade.startAgent({ ...request, by: `extension:${name}` }),
  }
}

/**
 * Your extension folders: each directory in the extensions directory with an
 * `extension.ts`, in name order. There is one place they live; whether each
 * runs is what the settings say.
 */
function yourFolders(root: string | null | undefined): string[] {
  if (!root) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'),
      )
      .map((entry) => join(root, entry.name))
      .filter((folder) => existsSync(join(folder, 'extension.ts')))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * What a file says it is, from the comment it starts with: the one thing that
 * can be known about an extension nobody has turned on, because reading a file
 * is not running it. Empty when there is nothing to read.
 */
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

function unknownSettings(
  extension: TadeExtension,
  settings: Readonly<Record<string, unknown>>,
): string[] {
  // A secret is one of them: it is written into `extensions.<name>.<key>` like
  // every other setting, and a key in the config is the key that is used. It
  // used to be excluded here, so that one written by hand would be reported as
  // not read — which was true while credentials lived in the keychain, and is
  // the opposite of true now.
  const known = new Set(['enabled', ...(extension.settings ?? []).map((setting) => setting.key)])
  return Object.keys(settings).filter((key) => !known.has(key))
}

/** The environment variables a declared secret is read from, in order. */
function variablesFor(
  setting: ExtensionSetting,
  settings: Readonly<Record<string, unknown>>,
): string[] {
  const named = typeof setting.env === 'string' ? [setting.env] : [...(setting.env ?? [])]
  const chosen = setting.envFrom ? settings[setting.envFrom] : undefined
  // What somebody named comes first: `key_env: MY_KEY` means that one.
  return typeof chosen === 'string' && chosen.trim() !== ''
    ? [chosen.trim(), ...named.filter((one) => one !== chosen.trim())]
    : named
}

/** A setting as it is typed into its field. */
function written(value: unknown, kind: 'text' | 'list' | 'map' | 'flag' | 'secret'): string {
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

/**
 * A field as typed, as the setting it becomes. Empty is no setting at all —
 * which for a credential is how one is taken back out.
 */
export function settingFrom(
  text: string,
  kind: 'text' | 'list' | 'map' | 'flag' | 'secret',
): unknown {
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
  // Its own process group, so the terminal Tade runs in is never retitled
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

import { readFileSync, writeFileSync } from 'node:fs'
import { type Config, extensionEnabled, loadConfig } from '@tade/core'
import {
  type SetupFieldView as HostSetupField,
  type ListSection,
  settingFrom,
} from '@tade/extensions-core'
import type { Frame } from '../frame.ts'
import type { Linker } from '../links.ts'
import {
  type AppState,
  notice,
  ORCHESTRATOR_TAB,
  openSchedule,
  type ScheduleView,
  withTranscript,
} from '../model.ts'
import type { PanelContext } from '../panels/context.ts'
import { type ExtensionSetupPanel, extensionSetupPanel } from '../panels/extensions/setup.ts'
import {
  type ExtensionsPanel,
  type ExtensionView,
  type McpServerOffer,
  type McpServerShown,
  serverFacts,
  toolSummary,
  type WrittenToolView,
} from '../panels/extensions/state.ts'
import { extensionsScrollable } from '../panels/extensions/view.ts'
import { writeSetting } from '../settings.ts'
import type { Skin } from '../skin.ts'
import { fromThinker, ran, said } from '../transcript.ts'
import { markdownLines } from '../viewer.ts'
import { configPathOf, type Wiring, whenShort, why } from './context.ts'
// Type-only, so it is erased and no module edge exists between the two
// subjects: this is the shape of what turning a watch on asks for, and what
// it *does* is the schedules'.
import type { ScheduleRequest } from './schedules.ts'

// Extensions, the servers brokered as extensions, and the page that says what
// each is for.
//
// Being in the folder is not being on: one nobody turned on is listed and
// never imported, so a row for it says its name and nothing else — the page
// says that rather than inventing the rest. What an extension is for is the
// extension's own to say, and it is shown unedited.
//
// An MCP server is a source of tools like any other, so it is a row here
// rather than a page of its own, and what its row says is only what is true:
// an off server was never connected, so it has no tools, no version and no
// "last asked".
//
// A server's words are material, never instruction. What comes back from one
// is handed over as a description, because a model must read it to choose,
// and it never becomes a prompt, a task, a note or the reason anybody is
// given.

/** How often extensions are asked what they keep in the status bar. */
const STATUS_MS = 5_000

/** What this subject needs from the rest of the window. */
export interface ExtensionsDeps {
  /** How big the terminal is: the page is laid out exactly as it is drawn. */
  size(): { columns: number; rows: number }
  /** What the window looks like, for laying the page out the way it is drawn. */
  skin: Skin
  /** The config was written by this subject's own hand: read it back. */
  useConfig(config: Config): void
  /** A moment, said the way this window says moments. */
  dateOf(at: number): string
  /** Scrolled back, what you are reading stays where it is while new lines arrive. */
  anchored(next: AppState): AppState
  /** Where a row on the page leads. */
  openPlace(target: { path: string }): Promise<void>
  openLink(url: string): Promise<void>
  reveal(path: string, folder: boolean): Promise<void>
  /** Installing something an extension needs, in a terminal you can watch. */
  watchCommand(kind: 'install', line: string): Promise<void>
  /** Turning a watch on is telling a schedule, like any other. */
  setSchedule(req: ScheduleRequest): Promise<string>
  /** The schedule a name belongs to, by the id that name makes. */
  scheduleNamed(name: string): ScheduleView | undefined
  /** Whether a schedule of that name is already on somewhere else. */
  scheduledElsewhere(name: string, project: string): boolean
  /** A line as a voice would say it, for an answer that had no said form of its own. */
  spoken(text: string): string
}

export class Extensions {
  private readonly wire: Wiring
  private readonly deps: ExtensionsDeps
  /** Text the extensions know how to open, asked once: working it out reads files. */
  private linkers: readonly Linker[] = []
  /** What each field of the setup panel offers, once looked up. */
  private setupChoices: Record<string, readonly string[]> = {}
  /** What each extension can be given, asked once on the way in rather than per frame. */
  private readonly setupViews = new Map<
    string,
    { configurable: boolean; fields: HostSetupField[] }
  >()
  /** The MCP servers Tade has been told about, as last read out of the config. */
  private servers: readonly McpServerShown[] = []
  /** What the harness loads by itself, once asked. */
  private harnessPieces: { name: string; where: string }[] = []
  /** What the extensions keep in the status bar, as they last answered. */
  private statuses: NonNullable<Frame['statuses']> = []
  /** The sections extensions keep in the sidebar, as they last answered. */
  private sections: ListSection[] = []
  /** The extension page being read, and when it was read. */
  private extensionShown: { name: string; title: string; markdown: string; at: number } | null =
    null
  /** They are being asked what they keep in the strip, and when they last were. */
  private asking = false
  private statusedAt = Number.NEGATIVE_INFINITY
  /** Extension actions you have run, for giving each its own line. */
  private ranCount = 0

  constructor(wire: Wiring, deps: ExtensionsDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** The text extensions know how to open, for the frame that draws it. */
  knownLinks(): readonly Linker[] {
    return this.linkers
  }

  /** What they keep in the status bar, and what they keep in the sidebar. */
  strip(): NonNullable<Frame['statuses']> {
    return this.statuses
  }

  lists(): readonly ListSection[] {
    return this.sections
  }

  /** What each harness loads by itself, which Tade lists but does not run. */
  harnessLoads(): { name: string; where: string }[] {
    return this.harnessPieces
  }

  /** The extension page being read, or nothing when none is. */
  shown(): { name: string; title: string; markdown: string } | null {
    return this.extensionShown
  }

  /** The id the next extension call runs under: each action gets its own line. */
  callId(): string {
    return `you-${++this.ranCount}`
  }

  /** Read the linkers once, as the window opens. */
  readLinkers(): void {
    this.linkers = this.wire.opts.extensions?.linkers() ?? []
  }

  /** The Extensions page is opening: read what is on it again, from the top. */
  async reread(): Promise<void> {
    this.harnessPieces = (await this.wire.opts.harnessExtensions?.().catch(() => [])) ?? []
    this.readServers()
    // What each one can be given is asked once, on the way in, rather than on
    // every frame it is drawn.
    this.setupViews.clear()
  }

  /** What each extension can be given, forgotten so it is asked again. */
  forgetSetup(): void {
    this.setupViews.clear()
  }

  /**
   * The tools Tade wrote for itself, as the panel shows them: the files it
   * found, and whether each is turned on, which is a setting like any other.
   */
  writtenViews(): WrittenToolView[] {
    return (this.wire.opts.written?.() ?? []).map((tool) => ({
      ...tool,
      on: extensionEnabled(this.wire.opts.config.extensions[tool.name], 'yours'),
    }))
  }

  private setupView(name: string): { configurable: boolean; fields: HostSetupField[] } {
    const had = this.setupViews.get(name)
    if (had) return had
    const setup = this.wire.opts.extensions?.setupOf(name) ?? null
    const view = { configurable: setup !== null, fields: setup?.fields ?? [] }
    this.setupViews.set(name, view)
    return view
  }

  /**
   * The MCP servers nobody has decided about: the catalogue row, with what
   * each one is for and what turning it on would need. A server somebody has
   * decided about is a row of its own among the extensions instead, because a
   * live source of tools belongs beside the others.
   */
  serverOffers(): McpServerOffer[] {
    return this.servers
      .filter((server) => !server.decided)
      .map((server) => ({
        name: server.name,
        title: server.title,
        description: server.description,
        workflow: server.workflow,
        how: server.how,
        needs: server.problem,
        install: server.install,
        note: server.note,
        fetches: server.fetches,
      }))
  }

  /**
   * A server somebody has decided about, as a row among the extensions.
   *
   * One that is on and working is already one — the broker made an extension
   * of it and the host loaded it — so this is the rest: the ones turned off,
   * and the ones turned on that cannot work yet. It says only what is true of
   * a server nothing has connected to, which is what it is and what it needs.
   */
  private serverViews(loaded: readonly string[]): ExtensionView[] {
    return this.servers
      .filter((server) => server.decided && !loaded.includes(`mcp-${server.name}`))
      .map((server) => ({
        name: `mcp-${server.name}`,
        title: server.title,
        description: server.description,
        // Its own words about how it is used are the catalogue's, and it was
        // never imported, so there is nothing else to say.
        workflow: server.on ? server.workflow : [],
        source: 'mcp' as const,
        state: server.on ? ('needs setup' as const) : ('off' as const),
        // A server that is on and workable is an extension by now, so one
        // that is on and here was left out — `--safe`, or a name Tade's own
        // took first. Either way it is said rather than left blank.
        problem: server.on
          ? (server.problem ?? `${server.name} is on, but nothing connected it in this window`)
          : server.problem,
        tools: [],
        actions: [],
        options: [],
        unknownSettings: [],
        configurable: false,
        folder: null,
        watches: [],
        server: serverFacts(server),
      }))
  }

  /**
   * The server a row is about, whether the row is the server itself or the
   * extension it became. Null when the row is not one.
   */
  serverNamed(name: string): McpServerShown | null {
    const said = name.startsWith('mcp-') ? name.slice('mcp-'.length) : name
    return this.servers.find((server) => server.name === said) ?? null
  }

  readServers(): void {
    this.servers = this.wire.opts.mcpServers?.(this.wire.opts.config) ?? []
  }

  /**
   * Turn a server on or off — which is a setting, and a person's alone.
   *
   * Taking a capability away may be immediate and giving one may not: turning
   * one off drops it from what is offered at once, and turning one on
   * connects the next time Tade starts, because a client dialling into a
   * half-configured server inside a running window is the evening lost.
   */
  private async turnServer(name: string, on: boolean): Promise<string> {
    writeSetting(configPathOf(this.wire.opts), `mcp.servers.${name}.enabled`, on)
    await this.reloadExtensions()
    const server = this.serverNamed(name)
    const needs = on && server?.problem ? `, and needs setting up: ${server.problem}` : ''
    return on
      ? `${name} is on — it connects the next time Tade starts, and its tools are offered to every agent and the orchestrator${needs}`
      : `${name} is off — its tools stop being offered`
  }

  /** The extensions, as the panel shows them. */
  extensionViews(): ExtensionView[] {
    const offers = this.wire.opts.extensions?.watches() ?? []
    const project = this.wire.state.project
    const schedules = this.wire.opts.client.schedules()
    const servers = this.servers
    const loaded = this.wire.opts.extensions?.list() ?? []
    return [
      ...loaded.map((one) => ({
        name: one.name,
        title: one.title,
        description: one.description,
        workflow: one.workflow,
        source: one.source,
        state: one.state,
        problem: one.problem,
        tools: one.tools.map((tool) => ({
          name: tool.name,
          summary: toolSummary(tool.description),
          for: tool.for,
        })),
        actions: one.actions.map((action) => ({ id: action.id, title: action.title })),
        options: this.setupView(one.name).fields.map((field) => ({
          key: field.key,
          label: field.label,
          value: field.value,
          have: field.have,
          secret: field.kind === 'secret',
        })),
        unknownSettings: one.unknownSettings,
        configurable: this.setupView(one.name).configurable,
        folder: one.source === 'yours' ? one.path : null,
        watches: offers
          .filter((offer) => offer.extension === one.name)
          .map((offer) => ({
            id: offer.id.slice(one.name.length + 1),
            title: offer.title,
            means: offer.means,
            every: offer.every,
            project,
            on:
              schedules.find(
                (each) =>
                  each.project === project &&
                  each.does.kind === 'watch' &&
                  each.does.watch === offer.id,
              )?.id ?? null,
          })),
        // What is true of a server and of nothing else, for a row that is one.
        ...(one.source === 'mcp'
          ? { server: serverFacts(servers.find((each) => `mcp-${each.name}` === one.name)) }
          : {}),
      })),
      ...this.serverViews(loaded.map((one) => one.name)),
    ]
  }

  /**
   * Turn a watch on in a project, as you: a schedule named for the watch, or
   * for the watch and the project when it is already on somewhere else, looking
   * as often as the watch says. Said in a line: when it looks, and what it waits
   * for when its extension cannot look yet.
   */
  private async turnOnWatch(watch: string, project: string): Promise<string> {
    const offer = this.wire.opts.extensions?.watches().find((one) => one.id === watch)
    if (!offer) throw new Error(`there is no watch called ${watch}`)
    const elsewhere = this.deps.scheduledElsewhere(offer.title, project)
    const name = elsewhere ? `${offer.title} in ${project}` : offer.title
    await this.deps.setSchedule({ name, project, said: '', watch, by: 'you' })
    const view = this.deps.scheduleNamed(name)
    const first = view?.next[0]
    const when = first === undefined ? '' : `, first at ${whenShort(first, this.wire.now())}`
    const yet = offer.problem ? `; it cannot look yet: ${offer.problem}` : ''
    return `${name} is on in ${project}: it looks ${view?.when ?? `every ${offer.every}`}${when}${yet}`
  }

  /** Something pressed in the Extensions panel. */
  async fromExtensions(panel: ExtensionsPanel, choice: string): Promise<void> {
    const [verb, ...rest] = choice.split(':')
    const name = rest[0] ?? ''
    const host = this.wire.opts.extensions
    const stay = (said: string | null) => {
      this.wire.put({ ...this.wire.state, panel: { ...panel, busy: false, said } })
      this.wire.draw()
    }
    try {
      switch (verb) {
        case 'action':
          this.wire.put({ ...this.wire.state, panel: null })
          await this.runExtension(name, rest[1] ?? '')
          return
        case 'setup':
          this.openSetup(name)
          return
        case 'folder': {
          const folder = host?.list().find((one) => one.name === name)?.path
          if (folder) await this.deps.reveal(folder, true)
          return stay(null)
        }
        case 'watch': {
          const project = this.wire.state.project
          if (!project) return stay('Open a project to watch it')
          return stay(await this.turnOnWatch(`${name}.${rest[1] ?? ''}`, project))
        }
        case 'watching':
          this.wire.put(openSchedule({ ...this.wire.state, panel: null }, name))
          this.wire.draw()
          return
        // A server nobody had decided about, turned on from the catalogue.
        case 'server':
          return stay(await this.turnServer(name, true))
        // The line that installs a server's program, run where you can watch
        // it: Tade never installs anything itself.
        case 'install': {
          const line = this.serverNamed(name)?.install
          if (!line) return stay(null)
          this.wire.put({ ...this.wire.state, panel: null })
          await this.deps.watchCommand('install', line)
          return
        }
        case 'toggle': {
          // One switch, and for a server it is its own: `extensions.<it>` is
          // not a second question, because a server's extension is only ever
          // handed over when the server is already on.
          const server = this.serverNamed(name)
          if (server) return stay(await this.turnServer(server.name, !server.on))
          const was = host?.list().find((one) => one.name === name)
          const tool = was ? null : this.writtenViews().find((one) => one.name === name)
          if (!was && !tool) return stay(null)
          const on = was ? was.state === 'off' : tool?.on !== true
          // Written down either way: one of Tade's own is on unless it says
          // otherwise, and one of yours is off until it says so.
          writeSetting(configPathOf(this.wire.opts), `extensions.${name}.enabled`, on)
          await this.reloadExtensions()
          if (tool) {
            // Nothing is loaded mid-session, so say when it takes effect.
            return stay(
              on
                ? `${name} is on — it loads the next time Tade starts`
                : `${name} is off — it stops loading the next time Tade starts`,
            )
          }
          const now = host?.list().find((one) => one.name === name)
          const later =
            now?.state === 'off' && now.problem?.startsWith('turned on') ? ` — ${now.problem}` : ''
          return stay(
            on
              ? `${was?.title ?? name} is on${later}${now?.state === 'needs setup' ? `, and needs setting up: ${now.problem}` : ''}`
              : `${was?.title ?? name} is off`,
          )
        }
        case 'read': {
          const tool = this.writtenViews().find((one) => one.name === name)
          if (!tool) return stay(null)
          this.wire.put({ ...this.wire.state, panel: null })
          await this.deps.openPlace({ path: tool.path })
          return
        }
        default:
          return stay(null)
      }
    } catch (err) {
      stay(why(err))
    }
  }

  /**
   * Read the config again and let the extensions take it. The orchestrator is
   * started again when what it can call changed, so a turned-on extension is
   * one it can use now, not after a restart.
   */
  async reloadExtensions(): Promise<void> {
    const host = this.wire.opts.extensions
    if (!host) return
    const before = host
      .specs('orchestrator')
      .map((one) => one.name)
      .join()
    const loaded = await loadConfig(configPathOf(this.wire.opts))
    if (!loaded.ok) throw new Error(loaded.issues[0]?.message ?? 'the config would not load')
    this.deps.useConfig(loaded.config)
    await host.reconfigure(loaded.config.extensions)
    // What each one can be given, and where its key is, is asked again: this
    // is the one thing that changes it. The servers with them, since turning
    // one on is a setting in the same file.
    this.setupViews.clear()
    this.readServers()
    this.linkers = host.linkers()
    if (
      host
        .specs('orchestrator')
        .map((one) => one.name)
        .join() !== before
    ) {
      void this.wire.opts.restartThinker?.()
    }
  }

  /**
   * What extensions keep in the status bar, asked every few seconds and never
   * waited on: the tick goes on drawing while they answer, and an open view is
   * asked again with them so it stays current.
   */
  askExtensions(): void {
    const host = this.wire.opts.extensions
    const tade = this.wire.opts.extensionWorkbench
    if (!host || !tade || this.asking || this.wire.now() - this.statusedAt < STATUS_MS) return
    this.asking = true
    this.statusedAt = this.wire.now()
    const panel = this.wire.state.panel
    void host
      .statuses(tade)
      .then(async (found) => {
        this.statuses = found.map((one) => ({
          extension: one.extension,
          text: one.item.text,
          tone: one.item.tone ?? 'quiet',
          viewable: one.viewable,
        }))
        if (panel?.kind === 'extension-view') await this.refreshExtensionView(panel.extension)
        // The sections extensions keep in the sidebar, on the same beat: the
        // host answers each from its own cache and asks nobody oftener than
        // that section says, so this costs a function call most times.
        this.sections = await host.lists(tade).catch(() => this.sections)
        this.wire.draw()
      })
      .catch(() => {})
      .finally(() => {
        this.asking = false
      })
  }

  /** Ask an extension for its view again, and show it if its panel is still open. */
  async refreshExtensionView(name: string): Promise<void> {
    const host = this.wire.opts.extensions
    const tade = this.wire.opts.extensionWorkbench
    if (!host || !tade) return
    try {
      const view = await host.view(name, tade)
      this.extensionShown = { name, ...view, at: this.wire.now() }
    } catch (err) {
      this.extensionShown = { name, title: name, markdown: why(err), at: this.wire.now() }
    }
    if (this.wire.state.panel?.kind === 'extension-view') this.wire.draw()
  }

  /** Set an extension up, or change its settings, in a panel. */
  openSetup(name: string): void {
    const setup = this.wire.opts.extensions?.setupOf(name)
    if (!setup) return
    this.setupChoices = {}
    this.wire.put({ ...this.wire.state, panel: extensionSetupPanel(name, setup.fields) })
    this.wire.draw()
    // What a field offers — the organizations a token can see — is looked up
    // once the panel is open, rather than making it wait.
    for (const field of setup.fields.filter((one) => one.offers)) {
      void this.wire.opts.extensions?.choices(name, field.key).then((choices) => {
        this.setupChoices = { ...this.setupChoices, [field.key]: choices }
        this.wire.draw()
      })
    }
  }

  /** The setup panel's facts: the extension as it stands, and what its fields offer. */
  setupFacts(panel: ExtensionSetupPanel): NonNullable<PanelContext['setup']> | null {
    const host = this.wire.opts.extensions
    const setup = host?.setupOf(panel.extension)
    const loaded = host?.list().find((one) => one.name === panel.extension)
    if (!setup || !loaded) return null
    return {
      title: loaded.title,
      state: loaded.state,
      problem: loaded.problem,
      guide: setup.guide,
      links: setup.links,
      fields: setup.fields.map((field) => ({
        key: field.key,
        label: field.label,
        help: field.help,
        placeholder: field.placeholder,
        kind: field.kind,
        choices: this.setupChoices[field.key] ?? [],
        ...(field.have ? { have: field.have } : {}),
      })),
    }
  }

  /** Save what was typed into the setup panel, and say whether it works now. */
  async saveSetup(panel: ExtensionSetupPanel): Promise<void> {
    const host = this.wire.opts.extensions
    const setup = host?.setupOf(panel.extension)
    if (!host || !setup) return
    const before = readFileSync(configPathOf(this.wire.opts), 'utf8')
    try {
      const kept: string[] = []
      for (const field of setup.fields) {
        const typed = panel.values[field.key] ?? ''
        if (field.kind === 'secret') {
          // Never into the config. A key goes to the keychain, or to Tade's
          // own 0600 file, and an empty field that had nothing in it is left
          // alone rather than forgetting what is already kept.
          if (typed.trim() === '') continue
          const saved = host.saveSecret(panel.extension, field.key, typed)
          kept.push(
            saved.beaten
              ? `${field.label} is in ${saved.where}, but ${saved.beaten} is set and wins`
              : `${field.label} is in ${saved.where}`,
          )
          continue
        }
        const value = settingFrom(typed, field.kind)
        writeSetting(
          configPathOf(this.wire.opts),
          `extensions.${panel.extension}.${field.key}`,
          value as Parameters<typeof writeSetting>[2],
        )
      }
      await this.reloadExtensions()
      const now = host.list().find((one) => one.name === panel.extension)
      const said = [
        now?.state === 'ready' ? `Saved. ${now.title} is ready.` : kept.length > 0 ? 'Saved.' : '',
        ...kept,
      ]
        .filter((line) => line !== '')
        .join(' ')
      this.wire.put({
        ...this.wire.state,
        panel: {
          ...panel,
          busy: false,
          // What was typed is gone from the panel the moment it is kept:
          // nothing holds a key in memory for the next repaint to draw.
          values: Object.fromEntries(
            Object.entries(panel.values).map(([key, value]) => [
              key,
              setup.fields.find((one) => one.key === key)?.kind === 'secret' ? '' : value,
            ]),
          ),
          error: now?.state === 'ready' ? null : (now?.problem ?? null),
          said: said === '' ? null : said,
        },
      })
    } catch (err) {
      writeFileSync(configPathOf(this.wire.opts), before)
      this.wire.put({ ...this.wire.state, panel: { ...panel, busy: false, error: why(err) } })
    }
    this.wire.draw()
  }

  /**
   * Show extension tools running in the conversation: yours from start to
   * answer, and how the orchestrator's are getting on while they run. An
   * agent's are shown in its own pane, by its harness.
   */
  watchExtensions(): void {
    this.wire.opts.extensions?.onRun((run) => {
      const at = this.wire.now()
      let transcript = this.wire.state.transcript
      // An agent running its project's checks is a run somebody may be
      // watching on its ACTIONS tab: look often while it goes, the same as
      // for the button here.
      if (run.tool === 'checks_run' && run.caller.kind === 'agent' && run.state !== 'ok') {
        this.wire.live?.hurryUp(run.caller.task)
      }
      if (run.caller.kind === 'agent') return
      if (run.caller.kind === 'you') {
        if (run.state === 'running') transcript = ran(transcript, run, at)
        if (run.state === 'ok' || run.state === 'failed') {
          transcript = fromThinker(
            transcript,
            {
              type: 'tool_done',
              id: run.id,
              ok: run.state === 'ok',
              text: run.state === 'ok' ? '' : run.text,
            },
            at,
          )
          if (run.state === 'ok') transcript = said(transcript, run.text, at)
        }
      }
      if (run.state === 'progress') {
        transcript = fromThinker(transcript, { type: 'progress', id: run.id, text: run.text }, at)
      }
      this.wire.put(this.deps.anchored(withTranscript(this.wire.state, transcript)))
      this.wire.draw()
    })
  }

  /** Run one of an extension's actions for the project you are in, in front of you. */
  async runExtension(name: string, id: string): Promise<void> {
    const host = this.wire.opts.extensions
    const found = host?.actions().find((one) => one.extension.name === name && one.action.id === id)
    if (!host || !found) {
      this.wire.put(notice(this.wire.state, `no extension action ${name}:${id}`))
      this.wire.draw()
      return
    }
    const { action } = found
    const project = this.wire.state.project
    if (action.project && !project) {
      this.wire.put(notice(this.wire.state, 'open a project first: this works on one'))
      this.wire.draw()
      return
    }
    this.wire.put({
      ...this.wire.state,
      bottom: ORCHESTRATOR_TAB,
      bottomMode: this.wire.state.bottomMode === 'min' ? 'open' : this.wire.state.bottomMode,
    })
    this.wire.draw()
    await host
      .call(
        action.tool,
        { ...(action.input ?? {}), ...(action.project && project ? { project } : {}) },
        {
          caller: { kind: 'you' },
          id: `you-${++this.ranCount}`,
          tade: this.wire.opts.extensionWorkbench ?? null,
        },
      )
      // Shown by the run itself: a failure's reason is already on its line.
      .catch(() => {})
  }

  /**
   * Open a row an extension keeps in the sidebar: it runs the tool the row
   * names, in the conversation, and the answer lands where everything else
   * an extension says does.
   */
  async openListRow(section: string, id: string): Promise<void> {
    const host = this.wire.opts.extensions
    const row = this.sections.find((one) => one.id === section)?.rows.find((one) => one.id === id)
    if (!host || !row) return
    if (!row.opens) {
      const link = row.links?.[0]
      if (link) await this.deps.openLink(link.url)
      return
    }
    this.wire.put({
      ...this.wire.state,
      bottom: ORCHESTRATOR_TAB,
      bottomMode: this.wire.state.bottomMode === 'min' ? 'open' : this.wire.state.bottomMode,
    })
    this.wire.draw()
    await host
      .call(row.opens.tool, row.opens.input ?? {}, {
        caller: { kind: 'you' },
        id: `you-${++this.ranCount}`,
        tade: this.wire.opts.extensionWorkbench ?? null,
      })
      .catch(() => {})
  }

  /**
   * Something said that an extension listens for, run as its button would be;
   * the answer lands in the transcript, and its first sentence is the reply.
   */
  async heardByExtension(said: string): Promise<string | null> {
    const host = this.wire.opts.extensions
    const found = host?.heard(said)
    if (!host || !found) return null
    const project = this.wire.state.project
    if (found.action.project && !project) return 'Open a project first: that works on one.'
    try {
      const answer = await host.call(
        found.action.tool,
        { ...(found.action.input ?? {}), ...(found.action.project && project ? { project } : {}) },
        {
          caller: { kind: 'you' },
          id: `you-${++this.ranCount}`,
          tade: this.wire.opts.extensionWorkbench ?? null,
        },
      )
      return answer.said ?? this.deps.spoken(answer.text)
    } catch (err) {
      return why(err)
    }
  }
  /**
   * How much further each side of the Extensions panel could be scrolled, and
   * how many rows its list shows, laid out exactly as it is drawn. The panel
   * is what holds the scroll, so what its keys, its bars and the wheel may do
   * to it has to be measured against the same layout.
   */
  extensionRoom(): { body: number; list: number; listRoom: number } {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'extensions') return { body: 0, list: 0, listRoom: 1 }
    return extensionsScrollable(
      panel,
      {
        skin: this.deps.skin,
        extensions: this.extensionViews(),
        written: this.writtenViews(),
        harnessExtensions: this.harnessPieces,
        servers: this.serverOffers(),
        project: this.wire.state.project,
        date: (at: number) => this.deps.dateOf(at),
      },
      this.deps.size().columns,
      this.deps.size().rows,
    )
  }

  /** How many lines an extension's view has, as wide as its panel draws it. */
  extensionViewLines(): number {
    const shown = this.extensionShown
    if (!shown) return 0
    const inner = Math.min(110, this.deps.size().columns - 4) - 4
    return markdownLines(shown.markdown, inner, !this.deps.skin.colour).length
  }
}

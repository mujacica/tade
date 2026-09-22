// Type-only, so the pure panel model never loads the extension host behind it.
import type { LoadedExtension } from '@tade/extensions-core'
import type { PanelInputs } from '../../panels.ts'
import { close, type PanelOutcome, stay, typed } from '../outcome.ts'

// The extensions this window runs with, the servers it brokers, and setting
// one up.
//
// Three panel kinds share this folder because they are one page: the list and
// what it says about one of them, the guide for setting one up, and the page
// an extension writes about itself. The drawing is beside this in `view.ts`,
// and what the right-hand side actually says is in `body.ts`.

/**
 * The extensions this window runs with: the list down the side, and one of
 * them in full beside it.
 *
 * It was one long column once — every extension, its buttons and its watches
 * end to end — which meant the last of them was two screens past the fold and
 * nothing could be found. It is the shape Settings has instead: search, a
 * list, and the one you chose, said properly.
 */
export interface ExtensionsPanel {
  kind: 'extensions'
  /**
   * What the right-hand side is showing: an extension's name, `written` or
   * `harness`. Null until something is chosen, which is the first of the list.
   */
  chosen: string | null
  /** Which control of the right-hand side the keyboard is on, of `extensionControls`. */
  index: number
  /** Lines of the right-hand side scrolled past. */
  scroll: number
  /** Rows of the list scrolled past, for the one that is longer than its side. */
  listScroll: number
  /**
   * Whether the right-hand side follows the control the keyboard is on. It
   * does while you tab between them, and stops the moment you scroll it
   * yourself: a page that jumps back to a button every time you read past it
   * is a page nobody can read.
   */
  following: boolean
  focus: 'search' | 'list' | 'body'
  /** Narrows the list: a name, what it is for, or one of its tools. */
  search: string
  busy: boolean
  /** What the last thing done here came to: turned on, approved. */
  said: string | null
}

/** One extension, as the panel shows it. */
export interface ExtensionView {
  name: string
  title: string
  description: string
  /**
   * How it is used, in its own words, a line at a time. Empty for one that is
   * off or broken: it was never imported, so there is nothing to ask.
   */
  workflow: readonly string[]
  /** Tade's own, a folder of yours, or an MCP server somebody turned on. */
  source: 'built-in' | 'yours' | 'mcp'
  state: 'ready' | 'needs setup' | 'off' | 'broken'
  /** What is wrong, or what to do before it can work. */
  problem: string | null
  tools: readonly ExtensionToolView[]
  /** What it can do from here, when it is ready. */
  actions: { id: string; title: string }[]
  /** What it can be given, and what each is set to now. */
  options: readonly ExtensionOptionView[]
  /** Settings it was given and does not read. */
  unknownSettings: string[]
  /** It says how to set it up, or what can be changed about it. */
  configurable: boolean
  /** Its folder, for one of yours. */
  folder: string | null
  /** What it offers to watch, and whether each is on in the project you are in. */
  watches: readonly WatchOfferView[]
  /** What is only true of a server, for a row that is one. */
  server?: McpServerView
}

/**
 * One MCP server, as the page says it.
 *
 * A server is a source of tools like any other, so it is a row among the
 * extensions rather than a page of its own — and these are the few things
 * that are true of one and of nothing else: how Tade talks to it, what it
 * offered when anybody last asked, and what of that it will not hand on.
 *
 * A credential is not here. It is said where every extension's is: as a
 * place, in the setting the broker generates for it, and never as a value.
 */
export interface McpServerView {
  /** The server's own name: `github`, not `mcp-github`. */
  name: string
  /** How Tade talks to it, as somebody would read it: the command, or the address. */
  how: string
  /** Whether a person has turned it on. */
  on: boolean
  /** Whether anybody has decided about it at all, either way. */
  decided: boolean
  /** The line a person runs to get the program, shown and never run unwatched. */
  install: string | null
  /** What is true about it that nobody would guess. */
  note: string | null
  /** When anybody last asked it what it offers. Null when nobody has. */
  asked: string | null
  /** What it offered that Tade will not hand on, and why. */
  dropped: readonly { name: string; why: string }[]
  /** Its command fetches code from the network every time it starts. */
  fetches: boolean
  /** The server's own name for each tool, by the name agents call it. */
  theirs: Readonly<Record<string, string>>
}

/** One of an extension's tools, as the panel says it. */
export interface ExtensionToolView {
  name: string
  /** What it does, in a line: the front of what the model is told about it. */
  summary: string
  /** Who may call it. */
  for: readonly ('orchestrator' | 'agent')[]
}

/** Something an extension can be given, and where its value stands. */
export interface ExtensionOptionView {
  key: string
  label: string
  /** What is in it now, as somebody would read it; empty where nothing is. */
  value: string
  /** For a credential: where the one it has is (`$TYPESAFE_API_KEY`); empty where there is none. */
  have: string
  /** A credential: never drawn back, only ever said as a place. */
  secret: boolean
}

/** A watch an extension offers, as the Extensions panel shows it. */
export interface WatchOfferView {
  /** Its name in the extension: `new-errors`. */
  id: string
  title: string
  means: string
  every: string
  /** The project it would watch: the one you are in. Null when you are in none. */
  project: string | null
  /** The schedule watching it there, once it is on. */
  on: string | null
}

/** A tool Tade wrote for itself: one file, for you to read and turn on. */
export interface WrittenToolView {
  name: string
  /** What it is for, as Tade said when it wrote it. */
  why: string
  path: string
  /** Whether it is turned on. It loads the next time Tade starts. */
  on: boolean
}

export function extensionsPanel(chosen: string | null = null): ExtensionsPanel {
  return {
    kind: 'extensions',
    chosen,
    index: 0,
    scroll: 0,
    listScroll: 0,
    following: true,
    focus: 'list',
    search: '',
    busy: false,
    said: null,
  }
}

/** The three groups that are not extensions, and always come last. */
export const WRITTEN = 'written'
export const HARNESS = 'harness'
export const SERVERS = 'servers'

/** A row in the list down the side of the Extensions panel. */
export interface ExtensionEntry {
  /** An extension's name, or `written` / `harness` / `servers`. */
  id: string
  title: string
  kind: 'extension' | 'written' | 'harness' | 'servers'
  /** How the extension stands; null for the groups that are not one. */
  state: ExtensionView['state'] | null
  /** How many tools it has, or how many pieces are in the group. */
  count: number
  /** Something here wants you: it needs setting up, or it is broken. */
  wants: boolean
}

/**
 * The list down the side: every extension the search matches, then the tools
 * Tade wrote for itself and what the harness loads by itself, where there are
 * any. Searching looks at everything the right-hand side would say — what it
 * is called, what it is for, how it is used, its tools and its watches —
 * because somebody looking for “the one that reads Sentry” has not
 * necessarily remembered that it is called Sentry.
 */
export function extensionEntries(
  views: readonly ExtensionView[],
  written: readonly WrittenToolView[] = [],
  harness: readonly { name: string; where: string }[] = [],
  search = '',
  /**
   * The servers nobody has decided about: the catalogue, as one row. The ones
   * somebody has decided about are among `views`, because a live source of
   * tools belongs beside the others — and twelve entries nobody has looked at
   * would triple the length of a list whose whole point is findability.
   */
  servers: readonly McpServerOffer[] = [],
): ExtensionEntry[] {
  const entries: ExtensionEntry[] = views
    .filter((view) => matchesSearch(extensionWords(view), search))
    .map((view) => ({
      id: view.name,
      title: view.title,
      kind: 'extension' as const,
      state: view.state,
      count: view.tools.length,
      wants: view.state === 'needs setup' || view.state === 'broken',
    }))
  if (written.length > 0) {
    const words = ['written by tade', ...written.map((tool) => `${tool.name} ${tool.why}`)]
    if (matchesSearch(words.join(' '), search)) {
      entries.push({
        id: WRITTEN,
        title: 'Written by Tade',
        kind: 'written',
        state: null,
        count: written.length,
        wants: false,
      })
    }
  }
  if (servers.length > 0) {
    const words = [
      'mcp servers',
      ...servers.map((one) => `${one.name} ${one.title} ${one.description} ${one.how}`),
    ]
    if (matchesSearch(words.join(' '), search)) {
      entries.push({
        id: SERVERS,
        title: 'MCP servers',
        kind: 'servers',
        state: null,
        count: servers.length,
        wants: false,
      })
    }
  }
  if (harness.length > 0) {
    const words = ['harnesses’ own', ...harness.map((one) => `${one.name} ${one.where}`)]
    if (matchesSearch(words.join(' '), search)) {
      entries.push({
        id: HARNESS,
        title: "Harnesses' own",
        kind: 'harness',
        state: null,
        count: harness.length,
        wants: false,
      })
    }
  }
  return entries
}

/**
 * One MCP server, as the window is handed it.
 *
 * What is true about a server is the broker's to say — `shownServers` is
 * where it comes from — and this is the window's word for the same thing, the
 * way a harness's own pieces arrive as a name and a place. Nothing here is a
 * credential: a key is said as a place, in the setting the broker generates
 * for it, and never drawn back.
 */
export interface McpServerShown {
  name: string
  title: string
  description: string
  workflow: readonly string[]
  /** Whether a person has turned it on. */
  on: boolean
  /** Whether anybody has decided about it at all, either way. */
  decided: boolean
  /** What is wrong with it, or what has to happen first. */
  problem: string | null
  /** How Tade talks to it: the command, or the address. */
  how: string
  install: string | null
  note: string | null
  /** When anybody last asked it what it offers. */
  asked: string | null
  /** What it offered, by the name agents use, with the server's own beside it. */
  tools: readonly { name: string; from: string; summary: string }[]
  /** What it offered that Tade will not hand on, and why. */
  dropped: readonly { name: string; why: string }[]
  /** Its command fetches code from the network every time it starts. */
  fetches: boolean
}

/** One server nobody has decided about, as the catalogue row offers it. */
export interface McpServerOffer {
  name: string
  title: string
  description: string
  /** What somebody is doing when they reach for it. */
  workflow: readonly string[]
  /** How Tade would talk to it: the command, or the address. */
  how: string
  /** What it would need before it could work: a program, a credential. */
  needs: string | null
  /** The line a person runs to get the program, shown and never run unwatched. */
  install: string | null
  /** What is true about it that nobody would guess. */
  note: string | null
  /** Its command fetches code from the network every time it starts. */
  fetches: boolean
}

/** Everything about an extension that searching it should find. */
function extensionWords(view: ExtensionView): string {
  return [
    view.name,
    view.title,
    view.description,
    view.source,
    view.state,
    ...view.workflow,
    ...view.tools.map((tool) => `${tool.name} ${tool.summary}`),
    ...view.actions.map((action) => action.title),
    ...view.watches.map((watch) => `${watch.title} ${watch.means}`),
    ...view.options.map((option) => option.label),
    // A server is found by what it is reached at, too: somebody looking for
    // the one they set up remembers the address before the name.
    view.server?.how ?? '',
  ].join(' ')
}

/** Every word typed is in it, in any order: the same rule the rest of the window searches by. */
function matchesSearch(text: string, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = text.toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/**
 * The first row of a list to draw: where it was scrolled to, moved as far as
 * it must to keep the row you are on in view.
 *
 * Which is the whole rule, in one place: whoever scrolls reads where they
 * like, and the keyboard moving the choice brings the list back to it —
 * because a choice you cannot see is a choice you did not make.
 */
export function listStart(scroll: number, total: number, room: number, chosen: number): number {
  const most = Math.max(0, total - room)
  let from = Math.max(0, Math.min(scroll, most))
  if (chosen >= from + room) from = Math.min(most, chosen - room + 1)
  if (chosen < from) from = chosen
  return Math.max(0, Math.min(from, most))
}

/** Which entry the panel is on: what was chosen, or the first one there is. */
export function chosenEntry(
  panel: ExtensionsPanel,
  entries: readonly ExtensionEntry[],
): ExtensionEntry | null {
  return entries.find((entry) => entry.id === panel.chosen) ?? entries[0] ?? null
}

/**
 * The controls on the right-hand side, in the order the keyboard moves through
 * them and in the order they are drawn: for the extension shown, setting it
 * up, what it can do from here, its folder, turning it off, and watching what
 * it offers to watch — or showing the watch, once it is on. For the tools Tade
 * wrote for itself, reading each and turning it on or off. What the harness
 * loads by itself has none: Tade only lists those.
 *
 * Turning it off comes last on purpose. Enter into the right-hand side lands
 * on the first control, and the first control being the one that switches the
 * thing off is how a look becomes a change.
 */
export function extensionControls(
  chosen: string | null,
  views: readonly ExtensionView[],
  written: readonly WrittenToolView[] = [],
  servers: readonly McpServerOffer[] = [],
): string[] {
  if (chosen === HARNESS) return []
  if (chosen === WRITTEN) {
    return written.flatMap((tool) => [`read:${tool.name}`, `toggle:${tool.name}`])
  }
  // A catalogue row offers two things at most: running the line that
  // installs the program, in a lane you are looking at, and turning it on —
  // which is a person's act and the only way a server is ever connected.
  if (chosen === SERVERS) {
    return servers.flatMap((server) => [
      ...(server.install ? [`install:${server.name}`] : []),
      `server:${server.name}`,
    ])
  }
  const view = views.find((one) => one.name === chosen)
  if (!view) return []
  const controls: string[] = []
  if (view.configurable && view.state !== 'broken' && view.state !== 'off')
    controls.push(`setup:${view.name}`)
  if (view.state === 'ready')
    controls.push(...view.actions.map((action) => `action:${view.name}:${action.id}`))
  // Nothing is installed behind a spinner: the line is shown, and running it
  // types it into a terminal you are looking at.
  if (view.server?.install && view.state !== 'ready') controls.push(`install:${view.server.name}`)
  if (view.folder) controls.push(`folder:${view.name}`)
  if (view.state !== 'broken') controls.push(`toggle:${view.name}`)
  if (view.state === 'broken') return controls
  for (const watch of view.watches) {
    const control = watchControl(view.name, watch)
    if (control) controls.push(control)
  }
  return controls
}

/**
 * What a tool does, in a line: the first sentence of what its model is told.
 * The whole description is written for whoever is choosing the tool and runs
 * to a paragraph; a person scanning eight of them wants the first clause.
 */
export function toolSummary(description: string): string {
  const said = description.trim().replace(/\s+/g, ' ')
  const stop = said.search(/(?<![A-Z])[.:](?:\s|$)/)
  return stop > 0 ? said.slice(0, stop) : said
}

/**
 * What a watch's button does: show the schedule watching it, once one is on;
 * turn it on in the project you are in; or nothing, when you are in none.
 */
export function watchControl(extension: string, watch: WatchOfferView): string | null {
  if (watch.on) return `watching:${watch.on}`
  return watch.project ? `watch:${extension}:${watch.id}` : null
}

/**
 * Moving around the Extensions panel: typing narrows the list, the arrows walk
 * it, and the right-hand side is a page — tab steps between the things that
 * can be pressed, the arrows scroll what there is to read.
 */
export function extensionsKey(
  panel: ExtensionsPanel,
  key: string | undefined,
  data: string,
  inputs: PanelInputs,
): PanelOutcome {
  const entries = extensionEntries(
    inputs.extensions ?? [],
    inputs.written ?? [],
    inputs.harnessExtensions ?? [],
    panel.search,
    inputs.servers ?? [],
  )
  const here = chosenEntry(panel, entries)
  const controls = extensionControls(
    here?.id ?? null,
    inputs.extensions ?? [],
    inputs.written ?? [],
    inputs.servers ?? [],
  )
  /**
   * Moving anywhere in the list starts the right-hand side at its top again,
   * and brings the list to what was chosen if it had been scrolled away from
   * it. The list holds where it is rather than working it out from the
   * choice, so that the wheel and the bar can move it and it stays moved.
   */
  const at = (id: string | null): PanelOutcome => {
    const index = Math.max(
      0,
      entries.findIndex((entry) => entry.id === id),
    )
    const room = Math.max(1, inputs.listRoom ?? entries.length)
    return stay({
      ...panel,
      chosen: id,
      index: 0,
      scroll: 0,
      following: true,
      focus: 'list',
      listScroll: listStart(panel.listScroll, entries.length, room, index),
    })
  }

  if (panel.focus === 'search') {
    if (key === 'escape') return stay({ ...panel, search: '', focus: 'list' })
    if (key === 'enter' || key === 'down' || key === 'tab') return stay({ ...panel, focus: 'list' })
    if (key === 'backspace')
      return stay({
        ...panel,
        search: [...panel.search].slice(0, -1).join(''),
        chosen: null,
        index: 0,
        scroll: 0,
        following: true,
      })
    const text = typed(data, key)
    if (text)
      // What was chosen may not be in the list any more, so the first match is.
      return stay({
        ...panel,
        search: panel.search + text,
        chosen: null,
        index: 0,
        scroll: 0,
        following: true,
      })
    return stay(panel)
  }

  if (key === 'escape') return close
  if (panel.busy) return stay(panel)
  if (key === 'ctrl+f' || data === '/') return stay({ ...panel, focus: 'search' })

  if (panel.focus === 'list') {
    const index = Math.max(
      0,
      entries.findIndex((entry) => entry.id === here?.id),
    )
    if (key === 'down' || key === 'up') {
      const step = key === 'down' ? 1 : -1
      const next = entries[index + step]
      if (!next)
        return key === 'up' && index === 0 ? stay({ ...panel, focus: 'search' }) : stay(panel)
      return at(next.id)
    }
    if (key === 'home') return entries[0] ? at(entries[0].id) : stay(panel)
    if (key === 'end') {
      const last = entries[entries.length - 1]
      return last ? at(last.id) : stay(panel)
    }
    if (key === 'right' || key === 'tab' || key === 'enter')
      return stay({ ...panel, chosen: here?.id ?? null, focus: 'body', index: 0, following: true })
    return stay(panel)
  }

  // The right-hand side: tab steps between what can be pressed, the arrows
  // read through what there is to read.
  const most = Math.max(0, inputs.scrollable ?? 0)
  const scrolled = (by: number) =>
    stay({
      ...panel,
      scroll: Math.max(0, Math.min(most, panel.scroll + by)),
      following: false,
    })
  if (key === 'left' || (key === 'shift+tab' && panel.index === 0))
    return stay({ ...panel, focus: 'list' })
  if (key === 'shift+tab')
    return stay({ ...panel, index: Math.max(0, panel.index - 1), following: true })
  if (key === 'tab')
    return stay({
      ...panel,
      index: Math.min(Math.max(0, controls.length - 1), panel.index + 1),
      following: true,
    })
  if (key === 'up') return scrolled(-1)
  if (key === 'down') return scrolled(1)
  if (key === 'pageUp') return scrolled(-10)
  if (key === 'pageDown') return scrolled(10)
  if (key === 'home') return stay({ ...panel, scroll: 0, following: false })
  if (key === 'end') return stay({ ...panel, scroll: most, following: false })
  const pressed = controls[panel.index]
  if ((key === 'enter' || key === 'space') && pressed)
    return { panel: { ...panel, said: null }, submit: true, choice: pressed }
  return stay(panel)
}

/** A click in the Extensions panel: on the list, the search field, or a control. */
export function extensionsClick(
  panel: ExtensionsPanel,
  control: string,
  inputs: PanelInputs,
): PanelOutcome {
  if (control === 'close') return close
  if (control === 'search') return stay({ ...panel, focus: 'search' })
  if (control.startsWith('pick:')) {
    const id = control.slice(5)
    return stay({
      ...panel,
      chosen: id,
      index: 0,
      scroll: 0,
      following: true,
      focus: 'list',
      said: null,
    })
  }
  const entries = extensionEntries(
    inputs.extensions ?? [],
    inputs.written ?? [],
    inputs.harnessExtensions ?? [],
    panel.search,
    inputs.servers ?? [],
  )
  const here = chosenEntry(panel, entries)
  const index = extensionControls(
    here?.id ?? null,
    inputs.extensions ?? [],
    inputs.written ?? [],
    inputs.servers ?? [],
  ).indexOf(control)
  return index < 0
    ? stay(panel)
    : {
        panel: { ...panel, index, focus: 'body', following: true, said: null },
        submit: true,
        choice: control,
      }
}

/**
 * What is true of a row that is an MCP server and of nothing else.
 *
 * Only what was actually asked: a server that is off was never connected, so
 * it has no tools, no version and no "last asked" — and saying otherwise
 * would be the page inventing a connection nobody made.
 */
export function serverFacts(server: McpServerShown | undefined): McpServerView | undefined {
  if (!server) return undefined
  return {
    name: server.name,
    how: server.how,
    on: server.on,
    decided: server.decided,
    install: server.install,
    note: server.note,
    asked: server.asked,
    dropped: server.dropped,
    fetches: server.fetches,
    theirs: Object.fromEntries(server.tools.map((tool) => [tool.name, tool.from])),
  }
}

/**
 * A server nobody has decided about, as the catalogue row offers it.
 *
 * Between two of this module's own types, and so here rather than beside the
 * subject that reads the servers: a mapping is what a row *is*, and the page
 * that draws one is the thing that has to agree with it.
 */
export function serverOffer(server: McpServerShown): McpServerOffer {
  return {
    name: server.name,
    title: server.title,
    description: server.description,
    workflow: server.workflow,
    how: server.how,
    needs: server.problem,
    install: server.install,
    note: server.note,
    fetches: server.fetches,
  }
}

/**
 * A server somebody has decided about and nothing connected, as a row among
 * the extensions.
 *
 * One that is on and working is already an extension — the broker made one of
 * it and the host loaded it — so this is the rest: the ones turned off, and
 * the ones turned on that cannot work yet. It says only what is true of a
 * server nothing has connected to, which is what it is and what it needs.
 */
export function serverView(server: McpServerShown): ExtensionView {
  return {
    name: `mcp-${server.name}`,
    title: server.title,
    description: server.description,
    // Its own words about how it is used are the catalogue's, and it was never
    // imported, so there is nothing else to say.
    workflow: server.on ? server.workflow : [],
    source: 'mcp',
    state: server.on ? 'needs setup' : 'off',
    // A server that is on and workable is an extension by now, so one that is
    // on and here was left out — `--safe`, or a name Tade's own took first.
    // Either way it is said rather than left blank.
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
  }
}

/**
 * An extension the host loaded, as a row on the page.
 *
 * What it says about itself is handed over unedited — a page that says only
 * what something *is* is how an extension with eight tools gets taken for the
 * one watch it happens to show. What had to be gathered from elsewhere comes
 * in already gathered: its setup's fields, its watches, and the server it was
 * made from where it was made from one.
 */
export function extensionRow(
  one: LoadedExtension,
  about: {
    options: ExtensionView['options']
    configurable: boolean
    watches: ExtensionView['watches']
    server: McpServerShown | undefined
  },
): ExtensionView {
  return {
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
    options: about.options,
    unknownSettings: one.unknownSettings,
    configurable: about.configurable,
    folder: one.source === 'yours' ? one.path : null,
    watches: about.watches,
    // What is true of a server and of nothing else, for a row that is one.
    ...(one.source === 'mcp' ? { server: serverFacts(about.server) } : {}),
  }
}

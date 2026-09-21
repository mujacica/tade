import { expandHome, type SettingGroup } from '@tade/core'
import { grep, listFiles, type Match, type SearchRoot } from '../finder.ts'
import type { Frame } from '../frame.ts'
import type { Target } from '../hits.ts'
import { focusTask, glyph, MARK_TONES, markOf, notice, projects } from '../model.ts'
import { searchPanel } from '../panels/search/state.ts'
import {
  parseOpenId,
  parseQuery,
  type SearchEntry,
  searchResults,
  shortlist,
  TEXT_MIN,
  worthAsking,
} from '../search.ts'
import { type Actions, type Subject, type Submits, type Wiring, why } from './context.ts'

// Search matches letters, and asking is what happens when they match nothing.
//
// `ctrl+k` is a pure ranking of what Tade already has, and that is what answers
// instantly and what answers when nobody is set up. Everything slow here —
// looking inside files, putting a sentence to whoever reads one — only ever
// *adds* rows, a moment after typing stops, and an answer that arrives after
// the box changed is dropped: somebody is watching it, and a list that moves
// under their hands is worse than one that says nothing.

/** At most this many entries are put to whoever reads a sentence. */
const MEANT_CHOICES = 24

/** How long the list of files search looks through is good for. */
const FILES_FOR_MS = 10_000

/** How long after the last keystroke the files are looked inside. */
const GREP_AFTER_MS = 150

/** How long after the last keystroke a sentence is put to anybody. */
const ASK_AFTER_MS = 250

/** What this subject needs from the rest of the window. */
export interface SearchDeps {
  /** Every setting there is, so one can be found by its name. */
  settings(): SettingGroup[]
  /** Open a file in the viewer, at a line. */
  openFile(path: string, line: number | null): void
  /** Find text in a terminal's scrollback. */
  openFind(id: string, query: string, index: number): Promise<void>
  /** What a click on something does, so a result does exactly that. */
  clicked(target: Target): void
  /** Answer the approval the agent in front is waiting on. */
  decide(allow: boolean): Promise<void>
  /** Stop an agent. */
  stopAgent(task: string): Promise<void>
  /** Show one of an agent's changes. */
  openDiff(task: string, path: string): Promise<void>
  /** Open Settings on a category. */
  openSettings(category: string): Promise<string>
  /** Put a terminal in front. */
  showTerminal(id: string): Promise<void>
  /** Close Tade. */
  quit(): void
  /** Do a named action, exactly as its button would. */
  run(action: string): Promise<void>
}

export class Search implements Subject {
  private readonly wire: Wiring
  private readonly deps: SearchDeps
  /** Search's results for the last query, so a redraw does not rank every file again. */
  private results: { key: string; entries: SearchEntry[] } | null = null
  /** Lines found inside files, for the text they were found for. */
  private grepped: { text: string; matches: Match[] } = { text: '', matches: [] }
  private grepping: string | null = null
  private grepTimer: NodeJS.Timeout | null = null
  /**
   * What somebody made of the last sentence typed into search, and which
   * sentence it was about: shown only while that sentence is still in the box,
   * because an answer to what was there before moves the list under your hands.
   */
  private meant: { said: string; entries: SearchEntry[] } | null = null
  private askingAbout: string | null = null
  private askingWith: AbortController | null = null
  private askTimer: NodeJS.Timeout | null = null
  /** Every file in every place search looks, and when they were listed. */
  private files: { at: number; files: { root: SearchRoot; path: string }[] } | null = null
  /** What each terminal has printed, read when search opens. */
  private terminalTexts: { id: string; name: string; project: string; text: string }[] = []

  constructor(wire: Wiring, deps: SearchDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** What the box shows for what is typed in it, and whether files are still being read. */
  panel(): Frame['panel'] {
    if (this.wire.state.panel?.kind !== 'search') return {}
    return { entries: this.entries(), searching: this.searching }
  }

  inputs() {
    return { entries: this.entries() }
  }

  actions(): Actions {
    return { search: () => this.open() }
  }

  submits(): Submits {
    return { search: (_panel, choice) => this.from(choice ?? '') }
  }

  /**
   * Opened: the slow halves start, a moment after typing stops. Both only ever
   * add rows to what the letters already matched.
   */
  opened(): void {
    this.lookInFiles()
    this.askWhatIsMeant()
  }

  /** Whether a look inside files is going, for the panel to say so. */
  get searching(): boolean {
    return this.grepping !== null
  }

  /** Open search, listing the files it looks through again when that list is old. */
  open(query = ''): void {
    this.wire.put({ ...this.wire.state, panel: searchPanel(query) })
    this.wire.draw()
    // What every terminal has printed, to find lines in.
    void Promise.all(
      this.wire.state.terminals.map(async (terminal) => ({
        ...terminal,
        text: await this.wire.opts.client.readTerminal(terminal.id, 5_000).catch(() => ''),
      })),
    ).then((texts) => {
      this.terminalTexts = texts
      this.results = null
      this.wire.draw()
    })
    if (this.files && this.wire.now() - this.files.at < FILES_FOR_MS) return
    const roots = this.roots()
    void Promise.all(
      roots.map(async (root) =>
        (await listFiles(root.path).catch(() => [])).map((path) => ({ root, path })),
      ),
    ).then((lists) => {
      this.files = { at: this.wire.now(), files: lists.flat() }
      this.results = null
      this.wire.draw()
    })
  }

  /** What search shows for the query in the box. */
  entries(): SearchEntry[] {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'search') return []
    const text = parseQuery(panel.query).text
    const matches = this.grepped.text === text ? this.grepped.matches : []
    const key = [
      panel.query,
      this.meant?.said === panel.query ? this.meant.entries.length : -1,
      this.files?.at ?? 0,
      this.grepped.text,
      matches.length,
      this.wire.state.panes.length,
      this.wire.state.panes.map((pane) => `${pane.task}${pane.state}${pane.waiting}`).join(),
    ].join('\0')
    if (this.results?.key !== key) {
      this.results = {
        key,
        entries: searchResults(panel.query, {
          entries: this.searchable(),
          files: this.files?.files ?? [],
          matches,
          terminals: this.terminalTexts,
          ...(this.meant?.said === panel.query ? { meant: this.meant.entries } : {}),
        }),
      }
    }
    return this.results.entries
  }

  /**
   * Look inside files for what is typed, a moment after typing stops: every
   * keystroke starting git grep across every worktree would be most of the work
   * the machine does while you type.
   */
  lookInFiles(): void {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'search') return
    const query = parseQuery(panel.query)
    const text = query.text
    if (
      query.scope === 'agents' ||
      query.scope === 'actions' ||
      text.length < TEXT_MIN ||
      query.line
    )
      return
    if (text === this.grepped.text || text === this.grepping) return
    if (this.grepTimer) clearTimeout(this.grepTimer)
    this.grepTimer = setTimeout(() => {
      this.grepping = text
      this.wire.draw()
      const roots = this.roots()
      void Promise.all(roots.map((root) => grep(root, text, 50).catch(() => []))).then((found) => {
        if (this.grepping !== text) return
        this.grepped = { text, matches: found.flat() }
        this.grepping = null
        this.results = null
        this.wire.draw()
      })
    }, GREP_AFTER_MS)
  }

  /**
   * Put a sentence to whoever reads sentences, a moment after typing stops.
   *
   * Only a sentence, and only one whose letters found nothing — search matches
   * letters, and that is still what answers first and what answers instantly.
   * This can only ever add rows to what is already there, and if it is late,
   * or wrong, or nobody answers, search is what it has always been.
   */
  askWhatIsMeant(): void {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'search') return
    const said = panel.query
    const host = this.wire.opts.extensions
    if (!host) return
    if (this.meant?.said === said || this.askingAbout === said) return
    if (!worthAsking(said, this.entries())) return
    if (this.askTimer) clearTimeout(this.askTimer)
    this.askTimer = setTimeout(() => {
      const choices = shortlist(said, this.searchable(), MEANT_CHOICES)
      if (choices.length === 0) return
      this.askingAbout = said
      // Whatever was being asked about the line before this one is not wanted
      // now: they have typed since, and are looking at something else.
      this.askingWith?.abort()
      const stop = new AbortController()
      this.askingWith = stop
      void host
        .meant({
          said,
          choices: choices.map((entry) => ({
            id: entry.id,
            label: entry.label,
            ...(entry.detail ? { detail: entry.detail } : {}),
          })),
          signal: stop.signal,
        })
        .then((answer) => {
          if (this.askingAbout !== said) return
          // What was typed while it was thinking is what they are looking at
          // now, and this is not about that.
          const open = this.wire.state.panel
          if (open?.kind !== 'search' || open.query !== said) return
          const by = new Map(choices.map((entry) => [entry.id, entry]))
          const entries = answer.ids
            .map((id) => by.get(id))
            .filter((entry): entry is SearchEntry => entry !== undefined)
          this.meant = { said, entries }
          this.results = null
          for (const problem of answer.problems) this.wire.put(notice(this.wire.state, problem))
          this.wire.draw()
        })
        .catch((err: unknown) => {
          // Never the reason search shows nothing: it shows what it always did.
          this.wire.put(notice(this.wire.state, why(err)))
        })
        .finally(() => {
          if (this.askingAbout === said) this.askingAbout = null
        })
    }, ASK_AFTER_MS)
  }

  /** Where a search result goes. */
  async from(id: string): Promise<void> {
    const place = parseOpenId(id)
    if (place) {
      this.deps.openFile(place.path, place.line)
      return
    }
    if (id.startsWith('terminal\0')) {
      const [, terminal, query, back] = id.split('\0')
      if (terminal) await this.deps.openFind(terminal, query ?? '', Number(back) || 0)
      return
    }
    const [verb, ...rest] = id.split(':')
    const arg = rest.join(':')
    this.wire.put({ ...this.wire.state, panel: null })
    switch (verb) {
      case 'task':
        this.deps.clicked({ kind: 'task', task: arg })
        return
      case 'approve':
        this.wire.put(focusTask(this.wire.state, arg))
        await this.deps.decide(true)
        return
      case 'stop':
        await this.deps.stopAgent(arg)
        return
      case 'changes': {
        const first = this.wire.live?.changes(arg)[0]
        if (first) await this.deps.openDiff(arg, first.path)
        else this.wire.put(notice(this.wire.state, `${arg} has not changed anything yet`))
        break
      }
      case 'project':
        this.deps.clicked({ kind: 'project', project: arg })
        return
      case 'setting':
        await this.deps.openSettings(arg)
        return
      case 'show-terminal':
        await this.deps.showTerminal(arg)
        return
      case 'run':
        if (arg === 'keys')
          this.wire.put({ ...this.wire.state, panel: { kind: 'keys', busy: false } })
        else if (arg === 'quit') this.deps.quit()
        else await this.deps.run(arg)
        break
      default:
        break
    }
    this.wire.draw()
  }

  /** Everything search knows without looking at the disk, what needs you first. */
  private searchable(): SearchEntry[] {
    const entries: SearchEntry[] = []
    const panes = [...this.wire.state.panes].sort((a, b) => Number(b.waiting) - Number(a.waiting))
    const toneOf = (pane: (typeof panes)[number]): SearchEntry['tone'] => MARK_TONES[markOf(pane)]
    for (const pane of panes) {
      if (pane.approval) {
        entries.push({
          id: `approve:${pane.task}`,
          kind: 'approval',
          label: `Allow once: ${pane.approval.summary}`,
          detail: pane.name,
          mark: '▲',
          tone: 'waiting',
        })
      }
    }
    // What the extensions can do, where you are.
    for (const { extension, action: one } of this.wire.opts.extensions?.actions() ?? []) {
      entries.push({
        id: `run:extension:${extension.name}:${one.id}`,
        kind: 'action',
        label: one.title,
        detail: extension.title,
        mark: '◆',
        complete: `>${one.title}`,
      })
    }
    for (const pane of panes) {
      entries.push({
        id: `task:${pane.task}`,
        kind: 'agent',
        label: pane.name,
        detail: `in ${pane.project}`,
        mark: glyph(pane),
        tone: toneOf(pane),
        complete: `@${pane.name}`,
        ...(pane.waiting ? { note: 'waiting on you' } : {}),
      })
    }
    const action = (id: string, label: string, mark = '›') =>
      entries.push({ id, kind: 'action', label, mark, complete: `>${label}` })
    for (const [id, label] of [
      ['run:new-agent', 'New agent'],
      ['run:new-terminal', 'New terminal'],
      ['run:open-project', 'Open project'],
      ['run:spend', 'Spend'],
      ['run:extensions', 'Extensions'],
      ['run:brief', 'Brief'],
      ['run:settings', 'Settings'],
      ['run:keys', 'Shortcuts'],
      ['run:quit', 'Quit'],
    ] as const) {
      action(id, label)
    }
    for (const pane of panes) {
      if (pane.lane) action(`stop:${pane.task}`, `Stop ${pane.name}`, '■')
      action(`changes:${pane.task}`, `Show the changes in ${pane.name}`, '±')
    }
    for (const terminal of this.wire.state.terminals) {
      action(`show-terminal:${terminal.id}`, `Terminal: ${terminal.name}`, '›')
    }
    for (const project of projects(this.wire.state)) {
      entries.push({ id: `project:${project}`, kind: 'project', label: project, mark: '▣' })
    }
    for (const group of this.deps.settings()) {
      for (const setting of group.settings) {
        entries.push({
          id: `setting:${group.id}`,
          kind: 'setting',
          label: `${group.title} › ${setting.title}`,
          mark: '◇',
        })
      }
    }
    return entries
  }

  /** Every place an agent works, and every project, for search to look in. */
  private roots(): SearchRoot[] {
    const roots: SearchRoot[] = Object.entries(this.wire.opts.config.projects).map(
      ([name, project]) => ({
        path: expandHome(project.root),
        label: name,
        task: null,
      }),
    )
    for (const pane of this.wire.state.panes) {
      const worktree = this.wire.live?.worktreeOf(pane.task)
      if (worktree)
        roots.push({ path: worktree, label: `${pane.project} › ${pane.name}`, task: pane.task })
    }
    return roots
  }
}

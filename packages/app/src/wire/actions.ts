import { matchActions, parseCommand } from '../commands.ts'
import { focusTask, notice } from '../model.ts'
import type { ExtensionViewPanel } from '../panels/extensions/setup.ts'
import { type MenuSubject, menuPanel } from '../panels/menu/state.ts'
import type { PanelOutcome } from '../panels/outcome.ts'
import { UPDATES } from '../panels/settings/state.ts'
import type { PromptPanel } from '../panels/small/state.ts'
import type { Panel, PanelInputs } from '../panels.ts'
import {
  type Actions,
  menuOf,
  type Prompts,
  promptFailed,
  type Subject,
  type Submits,
  type Wiring,
  why,
} from './context.ts'
import { panelInputsOf } from './frame.ts'

// What the window does when you ask it to do something, and where the asking
// lands.
//
// Every button, key and search result names an action, and `run` used to be a
// 338-line if-chain: the fortieth button added the fortieth branch, in a file
// that already knew about everything. Here it is a table the subjects fill in,
// looked up once — so a button's name belongs to whoever answers it, and this
// file does not change when one is added.
//
// Four tables, one shape. `actions` is what a button is called, `menus` is
// what a menu of some kind offers and what choosing one does, `submits` is
// carrying a panel out, and `prompts` is carrying out a one-line panel by what
// it is for. Every one of them was an if-chain over the same twenty subjects.
//
// A name belongs to exactly one subject. Two answering for the same one is a
// mistake rather than a fallback, and the later subject in the list wins — so
// the answer to "who runs `close-task:`" is always the same, whoever asks.

const HELP =
  'tab moves · / lists commands · ctrl+space talks · esc stops · ctrl+c clears, then quits'

/** What the router needs of the window that no subject answers for. */
export interface RouterDeps {
  /** Every subject, in the order their answers are folded together. */
  subjects(): readonly Subject[]
  /** Close the window. Not `quit`, which asks first: this is the answer to having asked. */
  stop(): Promise<void>
  /** Open Settings on a category. */
  openSettings(category: string): Promise<string>
  /** A command Tade's own grammar does not answer goes to the orchestrator. */
  onScreen(name: string): Promise<void>
  /** Read a diff, because the diff panel moved to another file. */
  loadDiff(task: string, path: string): Promise<void>
  /** Ask git about the open file, because it is now being shown with its changes in it. */
  loadFileDiff(path: string): Promise<void>
  /** Ask an extension for its page again, for the tab and window its panel is on. */
  loadExtensionView(panel: ExtensionViewPanel): Promise<void>
  /** Search was opened: the slow halves of it start. */
  searchOpened(): void
  /** The Updates page was opened: what is installed here is read. */
  lookAtWhatIsInstalled(): void
}

export class Router {
  private readonly wire: Wiring
  private readonly deps: RouterDeps

  constructor(wire: Wiring, deps: RouterDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * Do what a button says. Each is exactly what its label says.
   *
   * A name ending in `:` is a prefix and is handed what follows it; the
   * longest one that matches wins, so `queue-start:` and `queue-filter:` can
   * both be in the table without either shadowing the other. What nothing
   * answers for is tried as a command, which is how search's `>` results and
   * the command line reach the same place.
   */
  async run(action: string): Promise<void> {
    const found = this.lookUp(action)
    if (found) {
      await found.does(found.rest)
      return
    }
    await this.act(action)
  }

  /**
   * Carry out a slash command.
   *
   * Work happens in the window. Starting a task used to throw the whole screen
   * away for a form, which is a strange thing for a window whose entire job is
   * to show you what is running: you said what you wanted, so it is done, and
   * what you get back is the agent working on it. Only the two commands that
   * edit configuration — which is neither urgent nor about a task — borrow the
   * terminal, because a YAML editor does not fit in three rows.
   */
  async act(said: string): Promise<void> {
    const { name, rest } = parseCommand(said)
    const [chosen] = matchActions(this.wire.state, name)
    if (!chosen) {
      this.wire.put(notice(this.wire.state, `no command like ${said}`))
      this.wire.draw()
      return
    }
    if (!chosen.ready) {
      this.wire.put(notice(this.wire.state, chosen.about))
      this.wire.draw()
      return
    }
    const does = this.table()[chosen.name]
    if (does) {
      await does(rest)
      return
    }
    await this.deps.onScreen(chosen.name)
  }

  /** What a panel needs to answer a key or a click, from whoever holds each piece. */
  panelInputs(): PanelInputs {
    return panelInputsOf(this.deps.subjects(), this.wire.state.panel)
  }

  /** What a panel's answer changes: the panel itself, and what opening one starts. */
  applyPanel(outcome: PanelOutcome): void {
    const before = this.wire.state.panel
    this.wire.put({ ...this.wire.state, panel: outcome.panel })
    // A different file in the diff panel is a different diff to read.
    if (outcome.panel?.kind === 'diff') {
      const was = before?.kind === 'diff' ? before : null
      if (!was || was.file !== outcome.panel.file || was.task !== outcome.panel.task) {
        void this.deps.loadDiff(outcome.panel.task, outcome.panel.files[outcome.panel.file] ?? '')
      }
    }
    // The file panel asked for what git says about it: asked now rather than on
    // the next status beat, because a toggle that takes a second to answer is a
    // toggle that looks broken. Only on the press that turned it on — it is
    // asked again when the file changes, and that is the save's to do.
    if (outcome.panel?.kind === 'file' && outcome.panel.inline) {
      const was = before?.kind === 'file' ? before : null
      if (!was?.inline || was.path !== outcome.panel.path) {
        void this.deps.loadFileDiff(outcome.panel.path)
      }
    }
    // A different tab or a different window is a different page: the extension
    // is asked again now rather than on the next status beat, because a tab that
    // takes a second to answer is a tab that looks broken.
    if (outcome.panel?.kind === 'extension-view') {
      const was = before?.kind === 'extension-view' ? before : null
      if (!was || was.tab !== outcome.panel.tab || was.window !== outcome.panel.window) {
        void this.deps.loadExtensionView(outcome.panel)
      }
    }
    if (outcome.panel?.kind === 'search') this.deps.searchOpened()
    // The Updates page reads the machine when it is opened, and asks the
    // network only when the button on it is pressed.
    if (outcome.panel?.kind === 'settings' && outcome.panel.category === UPDATES) {
      this.deps.lookAtWhatIsInstalled()
    }
    this.wire.draw()
    if (outcome.submit && outcome.panel) void this.submitPanel(outcome.panel, outcome.choice)
  }

  /** Carry a panel out, and either close it or say in it why not. */
  async submitPanel(panel: Panel, choice?: string): Promise<void> {
    if (panel.kind === 'menu') {
      // The menu goes first: what it leads to may open a panel of its own, and
      // one drawn under a menu that is still there is a panel nobody can see.
      this.wire.put({ ...this.wire.state, panel: null })
      this.wire.draw()
      await menuOf(this.deps.subjects(), panel.subject.kind)?.choose(panel.subject, choice ?? '')
      return
    }
    if (panel.kind === 'prompt') await this.savePrompt(panel, choice)
    else {
      // Widened at the lookup: the key it was registered under is what says the
      // handler is the one for this panel, and the compiler cannot see that.
      const does = this.submits()[panel.kind] as
        | ((panel: Panel, choice: string | undefined) => Promise<void> | void)
        | undefined
      if (does) await does(panel, choice)
    }
    this.wire.draw()
  }

  /** Something's menu, opened where you clicked, just below and to the left. */
  openMenu(subject: MenuSubject, at: { x: number; y: number }): void {
    // Opening an agent's menu is standing on that agent: everything the menu
    // then says is about the one in front of you.
    const base =
      subject.kind === 'task' ? focusTask(this.wire.state, subject.task) : this.wire.state
    const title = menuOf(this.deps.subjects(), subject.kind)?.title(subject) ?? ''
    this.wire.put({
      ...base,
      panel: menuPanel(subject, title, { row: at.y + 1, col: Math.max(0, at.x - 26) }),
    })
    this.wire.draw()
  }

  /**
   * Carry out a one-line panel: keep a note, or make or rename a branch.
   *
   * The reason a throw is caught here rather than in each handler is that they
   * all answer it the same way — the panel stays open, with everything typed
   * still in it and the reason underneath.
   */
  private async savePrompt(panel: PromptPanel, choice?: string): Promise<void> {
    const does = this.prompts()[panel.purpose]
    if (!does) return
    try {
      await does(panel, panel.text.trim(), choice)
    } catch (err) {
      promptFailed(this.wire, panel, why(err))
    }
  }

  /** The two actions the window answers for itself: closing it, and saying what the keys do. */
  private own(): Actions {
    return {
      '/quit': () => void this.deps.stop(),
      '/help': () => {
        this.wire.put(notice(this.wire.state, HELP))
        this.wire.draw()
      },
    }
  }

  private table(): Actions {
    let table = this.own()
    for (const subject of this.deps.subjects()) {
      if (subject.actions) table = { ...table, ...subject.actions() }
    }
    return table
  }

  private submits(): Submits {
    let table: Submits = {
      quit: async (_panel, choice) => {
        if (choice === 'where') {
          await this.deps.openSettings('agents')
          return
        }
        await this.deps.stop()
      },
      reload: async () => {
        await this.wire.opts.reloadWindow?.()
      },
    }
    for (const subject of this.deps.subjects()) {
      if (subject.submits) table = { ...table, ...subject.submits() }
    }
    return table
  }

  private prompts(): Prompts {
    let table: Prompts = {}
    for (const subject of this.deps.subjects()) {
      if (subject.prompts) table = { ...table, ...subject.prompts() }
    }
    return table
  }

  /** The handler for an action, and what is left of the name after its prefix. */
  private lookUp(
    action: string,
  ): { does: (rest: string) => Promise<void> | void; rest: string } | null {
    const table = this.table()
    const exact = table[action]
    if (exact) return { does: exact, rest: '' }
    let best: string | null = null
    for (const name of Object.keys(table)) {
      if (!name.endsWith(':') || !action.startsWith(name)) continue
      if (best === null || name.length > best.length) best = name
    }
    const does = best === null ? undefined : table[best]
    return does && best !== null ? { does, rest: action.slice(best.length) } : null
  }
}

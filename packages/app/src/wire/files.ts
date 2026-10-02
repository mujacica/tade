import { basename, isAbsolute, relative, resolve } from 'node:path'
import { expandHome, type LaneId } from '@tade/core'
import { git } from '@tade/status'
import { type ParsedDiff, parseDiff } from '../diff.ts'
import {
  chooseEditor,
  launch,
  type Open,
  openerFor,
  openerForLink,
  openerForReveal,
} from '../editor.ts'
import type { Frame } from '../frame.ts'
import { focusTask, notice, shownName, toggleFolder, viewLane } from '../model.ts'
import { type FilePanel, filePanel, savedFile, showsDiff } from '../panels/file/state.ts'
import { fileBodySize } from '../panels/file/view.ts'
import { branchMenuItems, changeMenuItems, fileMenuItems } from '../panels/menu/state.ts'
import type { PanelOutcome } from '../panels/outcome.ts'
import { type BranchRow, branchPanel, diffPanel, promptPanel } from '../panels/small/state.ts'
import type { Panel } from '../panels.ts'
import type { Ui } from '../screen.ts'
import type { Skin } from '../skin.ts'
import {
  type Actions,
  type Menus,
  type Prompts,
  promptFailed,
  type Subject,
  type Submits,
  tilde,
  type Wiring,
  why,
} from './context.ts'
import { Viewed } from './viewed.ts'

// The file you have open, the diff beside it, and the branch underneath.
//
// One subject because they are one question asked three ways: what is on disk
// here. A path clicked anywhere in the window resolves against the agent's
// worktree — that is what `resolvePath` and `hereOnDisk` are — and everything
// else follows from where that lands: read it, edit it and save it, read what
// git says changed about it, throw those changes away, or move the whole
// checkout to another branch.
//
// The file the viewer has open is `viewed.ts` beside this, read once and kept:
// this subject is what git says about the checkout, that one is the one file.
// Clicking a changed file goes through `openChange`, which opens that same
// viewer with git's answer in it — so a change you can read you can also fix.

/** What this subject needs from the rest of the window. */
export interface FilesDeps {
  /** How big the terminal is: the viewer lays the file out for it. */
  size(): { columns: number; rows: number }
  /** Whether what is read comes back coloured. */
  skin: Skin
  /** Put something on the clipboard, said in the strip. */
  copy(text: string): Promise<void>
  /** Look through the files of a folder. */
  openSearch(query: string): void
  /** Borrow the terminal for a flow on the shared screen, then put the window back. */
  onScreenWith(flow: (ui: Ui) => Promise<void>): Promise<void>
  /** The agent's part of the window: a shell opened here is made that size. */
  paneSize(): { cols: number; rows: number }
  /** What a panel's answer changes. */
  applyPanel(outcome: PanelOutcome): void
  /** What is selected in the open file, for copying it. */
  selectedInFile(): string | null
  /** Put a selection on the clipboard, said as how much of it there was. */
  copySelection(text: string): Promise<void>
}

export class Files implements Subject {
  private readonly wire: Wiring
  private readonly deps: FilesDeps
  /** The file the viewer has open: read once, coloured once, laid out once. */
  private readonly viewed = new Viewed()
  /** The diff the diff panel is showing, once git has answered. */
  private diff: ParsedDiff | null = null
  /** The project checkout's branches, for the Switch branch panel. */
  private branchRows: BranchRow[] = []

  constructor(wire: Wiring, deps: FilesDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * How an opener is actually started: the machine's own unless the window was
   * given another. Read here rather than imported at each of the three call
   * sites, so there is one answer to "what happens when Tade reaches the
   * desktop" and a test can be handed a different one.
   */
  private get open(): Open {
    return this.wire.opts.open ?? launch
  }

  /**
   * What is on disk here: the tree beside the agent, what git says about it,
   * and where the work is. The worktree when an agent is in front of you and
   * the project's own checkout otherwise, which is the same rule `hereOnDisk`
   * follows — one answer to "here", read two ways.
   */
  facts(): Partial<Frame> {
    const live = this.wire.live
    const state = this.wire.state
    const focused = state.panes.find((pane) => pane.task === state.focused)
    const configured = state.project ? this.wire.opts.config.projects[state.project] : null
    const repo = configured ? expandHome(configured.root) : null
    const worktree = focused ? (live?.worktreeOf(focused.task) ?? null) : null
    const facts = focused ? live?.factsOf(focused.task) : null
    // What the changes are measured from: where the agent branched when one is
    // in front of you, and nowhere — so, `git status` — when none is.
    const base = live?.baseOf(state.focused) ?? null
    return {
      files: live?.files(worktree ?? repo, state.expanded) ?? [],
      fileMarks: live?.marksAt(worktree ?? repo) ?? {},
      where: repo
        ? {
            repo: tilde(repo),
            branch: facts?.branch ?? live?.branchAt(repo) ?? null,
            base: focused ? (live?.baseOf(focused.task) ?? null) : null,
            // Only a worktree of its own is worth a line: one sharing the
            // checkout works in `repo`.
            worktree: worktree && resolve(worktree) !== resolve(repo) ? tilde(worktree) : null,
            path: worktree ?? repo,
            shownPath: tilde(worktree ?? repo),
            links: facts?.links ?? [],
          }
        : null,
      // The same "here" the tree and the marks above are read at, rather than
      // the focused task: a change in this checkout is a change whoever made
      // it, and with no agent in front of you there is still a checkout to ask
      // about.
      changes: live?.changesAt(worktree ?? repo, base) ?? [],
      base,
    }
  }

  /** The file being read, the diff beside it, or the branches to switch to. */
  panel(width: number): Frame['panel'] {
    const panel = this.wire.state.panel
    if (panel?.kind === 'file') return { viewing: this.viewing(width), diff: this.viewed.diff() }
    if (panel?.kind === 'diff') return { diff: this.diff }
    if (panel?.kind === 'branch') return { branches: this.branchRows }
    return {}
  }

  inputs() {
    const panel = this.wire.state.panel
    const file = panel?.kind === 'file' ? this.body(panel) : null
    return {
      text: this.textAt(panel),
      branches: this.branchRows,
      ...(panel?.kind === 'file' ? { diffRows: this.viewed.rows(panel.edit) } : {}),
      ...(file ? { lines: this.lines(), body: file.rows, columns: file.columns } : {}),
    }
  }

  actions(): Actions {
    return {
      'new-shell': () => this.openShell(),
      'copy-path': async () => {
        const path = this.hereOnDisk()
        if (path) await this.deps.copy(path)
      },
      'open-path': async () => {
        const path = this.hereOnDisk()
        if (path) await this.reveal(path, true)
      },
    }
  }

  menus(): Menus {
    return {
      file: {
        title: (subject) => subject.path.split('/').at(-1) ?? subject.path,
        items: (subject) => {
          const focused = this.focusedPane()
          const here = this.hereOnDisk()
          const marks = this.wire.live?.marksAt(here) ?? {}
          return fileMenuItems({
            folder: subject.folder,
            open: this.wire.state.expanded.includes(subject.path),
            // The checkout the tree beside it is drawn from, agent or not: it
            // used to need an agent *and* a mark, which left the orchestrator's
            // own edits with the item turned off.
            changed:
              marks[subject.path] !== undefined ||
              this.wire.live
                ?.changesAt(here, this.wire.live.baseOf(this.wire.state.focused))
                .some((change) => change.path === subject.path) === true,
            agent: focused?.lane != null,
            platform: process.platform,
          })
        },
        choose: (subject, item) => this.fromFileMenu(subject.path, subject.folder, item),
      },
      change: {
        title: (subject) => subject.path.split('/').at(-1) ?? subject.path,
        items: (subject) => {
          const marks = this.wire.live?.marksAt(this.hereOnDisk()) ?? {}
          return changeMenuItems({
            uncommitted: marks[subject.path] !== undefined,
            agent: this.focusedPane()?.lane != null,
            // A row of the checkout's own changes carries no task, and a diff
            // is measured from where a task branched.
            diffable: subject.task !== null,
          })
        },
        choose: (subject, item) => this.fromChangeMenu(subject.task, subject.path, item),
      },
      branch: {
        title: () => this.branchHere() || 'branch',
        items: () => {
          const focused = this.focusedPane()
          return branchMenuItems({
            agent: focused !== undefined,
            name: focused ? (this.wire.live?.factsOf(focused.task)?.branch ?? '') : '',
          })
        },
        choose: (_subject, item) => this.fromBranchMenu(item),
      },
    }
  }

  submits(): Submits {
    return {
      branch: (_panel, choice) => this.switchBranch(choice ?? ''),
      confirm: (panel) => this.discard(panel.task, panel.path),
      file: async (panel, choice) => {
        if (choice === 'editor') {
          this.wire.put({ ...this.wire.state, panel: null })
          await this.openPlace({
            path: panel.path,
            ...(panel.edit ? { line: panel.edit.row + 1, column: panel.edit.column + 1 } : {}),
            ...(!panel.edit && panel.line ? { line: panel.line } : {}),
          })
          return
        }
        if (choice === 'save') return this.saveFile(panel)
        if (choice === 'copy-selection') {
          const text = this.deps.selectedInFile()
          if (text !== null && text !== '') await this.deps.copySelection(text)
          return
        }
        if (choice === 'copy-path') await this.deps.copy(panel.path)
      },
      diff: async (panel, choice) => {
        const path = panel.files[panel.file]
        if (!path) return
        if (choice === 'editor') {
          this.wire.put({ ...this.wire.state, panel: null })
          await this.openPlace({ path })
          return
        }
        if (choice === 'ask') await this.askAbout(panel.task, path)
      },
    }
  }

  /**
   * A branch is named once and renamed after that, and an agent with no branch
   * yet is named rather than renamed: the first change it makes is what gives
   * it one, so naming it here is naming the task.
   */
  prompts(): Prompts {
    return {
      'new-branch': async (panel, text) => {
        const here = this.hereOnDisk()
        if (!here)
          return promptFailed(this.wire, panel, 'There is no checkout here to make a branch in.')
        const out = await git(here, ['switch', '-c', text])
        if (!out.ok)
          return promptFailed(
            this.wire,
            panel,
            out.stderr.split('\n')[0] ?? 'git would not make it',
          )
        this.wire.put(notice({ ...this.wire.state, panel: null }, `on ${text}`))
      },
      'rename-branch': async (panel, text) => {
        const here = this.hereOnDisk()
        if (!here)
          return promptFailed(this.wire, panel, 'There is no checkout here to make a branch in.')
        const focused = this.focusedPane()
        if (!focused) return promptFailed(this.wire, panel, 'Open the agent whose branch this is.')
        const current = this.wire.live?.factsOf(focused.task)?.branch ?? ''
        const root = this.wire.opts.config.projects[focused.project]?.root
        if (!current) {
          if (!root)
            return promptFailed(
              this.wire,
              panel,
              'I cannot find the project this agent belongs to.',
            )
          const made = await this.wire.opts.client.nameTask({
            task: focused.task,
            root: expandHome(root),
            worktree: here,
            title: text,
          })
          this.wire.put(notice({ ...this.wire.state, panel: null }, `on ${made}`))
        } else {
          const name = text.startsWith('tade/') ? text : `tade/${text}`
          const out = await git(here, ['branch', '-m', current, name])
          if (!out.ok)
            return promptFailed(
              this.wire,
              panel,
              out.stderr.split('\n')[0] ?? 'git would not rename it',
            )
          this.wire.put(notice({ ...this.wire.state, panel: null }, `renamed to ${name}`))
        }
        await this.wire.live?.refresh()
      },
    }
  }

  /** The agent in front of you, whose worktree everything here is about. */
  private focusedPane() {
    return this.wire.state.panes.find((pane) => pane.task === this.wire.state.focused)
  }

  /** The branch under what you are looking at: the agent's, or the checkout's own. */
  private branchHere(): string {
    const focused = this.focusedPane()
    return (
      (focused
        ? this.wire.live?.factsOf(focused.task)?.branch
        : this.wire.live?.branchAt(this.hereOnDisk() ?? '')) ?? ''
    )
  }

  /**
   * The file's own lines, and only while they are the file the panel is on: a
   * caret counts columns in them, and in the wrong file it would land
   * somewhere nobody pointed at.
   */
  textAt(panel: Panel | null): readonly string[] {
    return panel?.kind === 'file' ? this.viewed.text(panel.path) : []
  }

  /**
   * Open a file you clicked, in your editor, at the line if there is one.
   * Relative paths are the agent's, so they resolve in its worktree.
   */
  async openPlace(target: { path: string; line?: number; column?: number }): Promise<void> {
    const file = this.resolvePath(target.path)
    const { editor } = chooseEditor(this.wire.opts.config.surfaces.window.editor, process.env)
    const opener = openerFor(
      editor,
      {
        file,
        ...(target.line ? { line: target.line } : {}),
        ...(target.column ? { column: target.column } : {}),
      },
      process.env,
    )
    const where = `${basename(file)}${target.line ? `:${target.line}` : ''}`
    if (opener.kind === 'terminal') {
      // A terminal editor gets a terminal: this one, for as long as you are in
      // it, with the window put back when you quit — never two programs reading
      // one keyboard.
      await this.deps.onScreenWith(async (ui) => {
        await ui.run(`${opener.command} ${where}`, opener.command, opener.args)
      })
      return
    }
    try {
      await this.open(opener)
      this.wire.put(
        notice(this.wire.state, `opened ${where} in ${editor === 'system' ? 'its app' : editor}`),
      )
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
    }
    this.wire.draw()
  }

  /**
   * Where a path someone clicked is: relative ones are the agent's, so they
   * resolve in its worktree, or in the project when no agent is in front of you.
   */
  resolvePath(path: string): string {
    return isAbsolute(path)
      ? path
      : resolve(this.hereOnDisk() ?? this.wire.opts.cwd ?? process.cwd(), path)
  }

  /** The folder you are looking at on disk: the focused agent's worktree, or the project's. */
  hereOnDisk(): string | null {
    const focused = this.wire.state.panes.find((pane) => pane.task === this.wire.state.focused)
    const worktree = focused ? this.wire.live?.worktreeOf(focused.task) : null
    if (worktree) return worktree
    const root = this.wire.state.project
      ? this.wire.opts.config.projects[this.wire.state.project]?.root
      : undefined
    return root ? expandHome(root) : null
  }

  /**
   * Read a file into the viewer, at a line if there is one — and, where it was
   * opened as a change, with git's answer in it from the first frame.
   */
  openFile(path: string, line: number | null = null, inline = false): void {
    this.viewed.open(path, !this.deps.skin.colour)
    this.wire.put({
      ...this.wire.state,
      panel: filePanel(path, line, this.viewed.markdown(), inline),
    })
    this.wire.draw()
  }

  /** What the viewer draws, with Markdown laid out for the width it has now. */
  viewing(width: number): NonNullable<Frame['panel']>['viewing'] {
    const panel = this.wire.state.panel
    return this.viewed.showing(
      width,
      this.deps.size().rows,
      !this.deps.skin.colour,
      panel?.kind === 'file' ? panel.edit : null,
    )
  }

  /**
   * Write what was typed into the file back, and read it again — so what is on
   * screen is what is on disk, coloured as a whole file rather than line by
   * line, and the tree beside it shows git's new mark for it.
   *
   * A save that could not happen stays in the panel, with the file still open
   * and everything typed still in it.
   */
  async saveFile(panel: FilePanel): Promise<void> {
    const edit = panel.edit
    if (!edit || !this.viewed.has(panel.path)) return
    const about = this.viewed.about()
    try {
      const lines = this.viewed.save(edit, !this.deps.skin.colour)
      this.wire.put({
        ...this.wire.state,
        panel: savedFile(panel, lines, `Saved ${basename(panel.path)}.`),
      })
      this.wire.draw()
      await this.wire.live?.refresh()
      // What was saved is a change, so what git says about it has changed too:
      // the file it was asked about is the file that was just written.
      await this.loadFileDiff(about, panel.path)
    } catch (err) {
      this.wire.put({ ...this.wire.state, panel: { ...panel, said: why(err), warned: true } })
    }
    this.wire.draw()
  }

  async openLink(url: string): Promise<void> {
    try {
      const opener = openerForLink(url)
      if (opener.kind === 'detached') await this.open(opener)
      this.wire.put(notice(this.wire.state, `opened ${url}`))
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
    }
    this.wire.draw()
  }
  /**
   * A shell in the task's worktree, as a tab beside its agent: the place to
   * run the tests yourself, or look at what it did, without leaving the task.
   */
  async openShell(): Promise<void> {
    const pane = this.wire.state.panes.find((p) => p.task === this.wire.state.focused)
    const worktree = pane ? this.wire.live?.worktreeOf(pane.task) : null
    if (!pane || !worktree) {
      this.wire.put(notice(this.wire.state, 'open an agent first: a shell starts in its worktree'))
      this.wire.draw()
      return
    }
    const taken = new Set(pane.lanes.map((lane) => lane.id))
    let id = `${pane.task}/shell`
    for (let n = 2; taken.has(id); n++) id = `${pane.task}/shell-${n}`
    const size = this.deps.paneSize()
    try {
      await this.wire.opts.client.spawn({
        id: id as LaneId,
        task: pane.task as never,
        kind: 'shell',
        cwd: worktree,
        command: process.env.SHELL ?? '/bin/sh',
        args: ['-l'],
        cols: size.cols,
        rows: size.rows,
        title: `${pane.name} shell`,
      })
      await this.wire.live?.refresh()
      this.wire.put(viewLane(this.wire.state, pane.task, id))
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
    }
    this.wire.draw()
  }
  async fromFileMenu(path: string, folder: boolean, item: string): Promise<void> {
    const full = this.resolvePath(path)
    const focused = this.wire.state.panes.find((p) => p.task === this.wire.state.focused)
    switch (item) {
      case 'open':
        this.openFile(full)
        return
      case 'toggle':
        this.wire.put(toggleFolder(this.wire.state, path))
        break
      case 'search':
        this.deps.openSearch(`${path}/`)
        return
      case 'editor':
        await this.openPlace({ path: full })
        return
      case 'changes':
        await this.openChange(focused?.task ?? null, path)
        return
      case 'ask':
        if (focused) await this.askAbout(focused.task, path)
        break
      case 'copy-path':
        await this.deps.copy(full)
        return
      case 'copy-relative':
        await this.deps.copy(path)
        return
      case 'reveal':
        await this.reveal(full, folder)
        return
      default:
        break
    }
    this.wire.draw()
  }

  async fromChangeMenu(task: string | null, path: string, item: string): Promise<void> {
    const full = this.resolvePath(path)
    switch (item) {
      case 'diff':
        await this.openChange(task, path)
        return
      case 'patch':
        if (task) await this.openDiff(task, path)
        return
      case 'open':
        this.openFile(full)
        return
      case 'editor':
        await this.openPlace({ path: full })
        return
      case 'ask':
        if (task) await this.askAbout(task, path)
        break
      case 'copy-path':
        await this.deps.copy(full)
        return
      case 'discard':
        this.wire.put({
          ...this.wire.state,
          panel: {
            kind: 'confirm',
            purpose: 'discard',
            task,
            path,
            field: 'keep',
            busy: false,
            error: null,
          },
        })
        break
      default:
        break
    }
    this.wire.draw()
  }

  async fromBranchMenu(item: string): Promise<void> {
    const focused = this.wire.state.panes.find((p) => p.task === this.wire.state.focused)
    const here = this.hereOnDisk()
    const branch = focused
      ? (this.wire.live?.factsOf(focused.task)?.branch ?? '')
      : (this.wire.live?.branchAt(here ?? '') ?? '')
    switch (item) {
      case 'switch': {
        this.branchRows = here ? await (this.wire.live?.branchesOf(here) ?? []) : []
        this.wire.put({ ...this.wire.state, panel: branchPanel() })
        break
      }
      case 'new':
        this.wire.put({
          ...this.wire.state,
          panel: promptPanel('new-branch', 'New branch', 'BRANCH NAME'),
        })
        break
      case 'rename':
        this.wire.put({
          ...this.wire.state,
          panel: promptPanel(
            'rename-branch',
            branch ? 'Rename branch' : 'Name the branch',
            'BRANCH NAME',
            branch ? branch.replace(/^tade\//, '') : '',
          ),
        })
        break
      case 'pull': {
        if (!here) break
        const out = await git(here, ['pull', '--ff-only'], 60_000)
        this.wire.put(
          notice(
            this.wire.state,
            out.ok
              ? `pulled ${branch || 'the branch'}`
              : `pull failed: ${out.stderr.split('\n')[0]}`,
          ),
        )
        break
      }
      case 'copy':
        if (branch) await this.deps.copy(branch)
        return
      case 'copy-path':
        if (here) await this.deps.copy(here)
        return
      case 'changes': {
        if (!focused) break
        const first = this.wire.live?.changes(focused.task)[0]
        if (first) await this.openChange(focused.task, first.path)
        else
          this.wire.put(
            notice(this.wire.state, `${shownName(focused)} has not changed anything yet`),
          )
        break
      }
      default:
        break
    }
    this.wire.draw()
  }
  /** Reveal a file in the system's file manager. */
  async reveal(path: string, folder: boolean): Promise<void> {
    try {
      await this.open(openerForReveal(path, folder))
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
      this.wire.draw()
    }
  }
  /** Switch the project's checkout to a branch, or to a new one. */
  async switchBranch(choice: string): Promise<void> {
    const panel = this.wire.state.panel
    const [verb, ...rest] = choice.split(':')
    const name = rest.join(':')
    const here = this.hereOnDisk()
    if (!here || !name || panel?.kind !== 'branch') return
    const out = await git(
      here,
      verb === 'create' ? ['switch', '-c', name] : ['switch', name],
      30_000,
    )
    if (!out.ok) {
      // Git's own words: an unstaged change in the way is a reason worth reading.
      this.wire.put({
        ...this.wire.state,
        panel: { ...panel, busy: false, error: out.stderr.split('\n')[0] ?? 'git refused' },
      })
      return
    }
    this.wire.put(notice({ ...this.wire.state, panel: null }, `on ${name}`))
    await this.wire.live?.refresh()
  }

  /** Throw away a file's uncommitted changes: back to the last commit, or gone if never committed. */
  async discard(task: string | null, path: string): Promise<void> {
    const panel = this.wire.state.panel
    const root = task ? this.wire.live?.worktreeOf(task) : this.hereOnDisk()
    if (!root || panel?.kind !== 'confirm') return
    const marks = this.wire.live?.marksAt(root) ?? {}
    const out =
      marks[path] === 'U'
        ? await git(root, ['clean', '-f', '--', path])
        : await git(root, ['restore', '--staged', '--worktree', '--source=HEAD', '--', path])
    if (!out.ok) {
      this.wire.put({
        ...this.wire.state,
        panel: { ...panel, busy: false, error: out.stderr.split('\n')[0] ?? 'git refused' },
      })
      return
    }
    this.wire.put(notice({ ...this.wire.state, panel: null }, `discarded ${path}`))
  }
  /**
   * A changed file, opened in the editor with git's answer drawn into it: the
   * same panel a file opens in from FILES or from search, so a change is read
   * and fixed in one place rather than read in one and fixed in another. The
   * task is whose changes these are, and nothing where they are the checkout's.
   */
  async openChange(task: string | null, path: string): Promise<void> {
    this.openFile(this.resolvePath(path), null, true)
    await this.loadFileDiff(task, path)
  }

  /**
   * Ask git about the file that is open, and keep the answer with it. Asked
   * where the CHANGES section asks: the task's own worktree when the changes are
   * a task's, and otherwise the checkout in front of you.
   */
  async loadFileDiff(task: string | null, path: string): Promise<void> {
    const live = this.wire.live
    const root = (task ? live?.worktreeOf(task) : null) ?? this.hereOnDisk()
    const open = this.resolvePath(path)
    if (!live || !root) return
    // A file somewhere else is one this checkout cannot be asked about — search
    // reaches into every worktree, and a path in an agent's own words reaches
    // anywhere. Nothing is said about it rather than git being asked a question
    // about `../..`, whose answer would read as "nothing changed".
    const inside = relative(root, open)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return
    const base = live.baseOf(task ?? this.wire.state.focused)
    const text = await live.diffAt(root, base, inside).catch(() => null)
    // A look that could not happen is not a look that found nothing, so a git
    // that would not answer leaves the file with no answer beside it.
    if (text === null) return
    // And a slow git must never draw one file's changes into another: the answer
    // is offered to the file it was about and dropped if that is not the one open.
    if (this.viewed.tell(open, task, parseDiff(text))) this.wire.draw()
  }

  /** The diff panel, on a changed file, with every other changed file a step away. */
  async openDiff(task: string, path: string): Promise<void> {
    const files = (this.wire.live?.changes(task) ?? []).map((change) => change.path)
    const at = Math.max(0, files.indexOf(path))
    this.deps.applyPanel({
      panel: diffPanel(task, files.length > 0 ? files : [path], at),
      submit: false,
    })
  }

  async loadDiff(task: string, path: string): Promise<void> {
    this.diff = null
    this.wire.draw()
    const live = this.wire.live
    const root = live?.worktreeOf(task)
    const text =
      live && root ? await live.diffAt(root, live.baseOf(task), path).catch(() => null) : null
    const panel = this.wire.state.panel
    // Only if the panel is still on that file: a slow git must not draw an old diff.
    if (panel?.kind === 'diff' && panel.task === task && panel.files[panel.file] === path) {
      this.diff = text ? parseDiff(text) : parseDiff('')
      this.wire.draw()
    }
  }

  /**
   * Put a question about a file in front of the agent, unsent. Typed into its
   * prompt, not submitted: asking costs money, so you are the one who presses
   * enter.
   */
  async askAbout(task: string, path: string): Promise<void> {
    const pane = this.wire.state.panes.find((p) => p.task === task)
    this.wire.put({ ...focusTask(this.wire.state, task), panel: null })
    if (!pane?.lane) {
      this.wire.put(notice(this.wire.state, `open ${task}'s agent first, then ask`))
      return
    }
    this.wire.put(viewLane(this.wire.state, task, pane.lane))
    await this.wire.opts.client
      .write(pane.lane as LaneId, new TextEncoder().encode(`Look at ${path}: `))
      .catch(() => {})
  }
  /** How many lines the viewer has to scroll through, as it is showing the file now. */
  lines(): number {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'file') return 0
    const size = this.deps.size()
    return this.viewed.lines({
      edit: panel.edit,
      formatted: panel.formatted,
      inline: showsDiff(panel),
      width: size.columns,
      height: size.rows,
      plain: !this.deps.skin.colour,
    })
  }

  /** The size of the viewer's body, for keeping the caret in it and for reading a click. */
  body(panel: FilePanel): { rows: number; columns: number } {
    return fileBodySize(
      this.deps.size().columns,
      this.deps.size().rows,
      this.lines(),
      panel.asking !== null,
      showsDiff(panel) && this.viewed.rows(panel.edit) !== null,
    )
  }
}

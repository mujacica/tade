import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { expandHome, type LaneId } from '@tade/core'
import { git } from '@tade/status'
import { type ParsedDiff, parseDiff } from '../diff.ts'
import { chooseEditor, launch, openerFor, openerForLink } from '../editor.ts'
import type { Frame } from '../frame.ts'
import { focusTask, notice, shownName, toggleFolder, viewLane } from '../model.ts'
import { type FilePanel, filePanel, savedFile } from '../panels/file/state.ts'
import { fileBodySize, fileViewSize } from '../panels/file/view.ts'
import type { PanelOutcome } from '../panels/outcome.ts'
import { type BranchRow, branchPanel, diffPanel, promptPanel } from '../panels/small/state.ts'
import type { Panel } from '../panels.ts'
import type { Ui } from '../screen.ts'
import type { Skin } from '../skin.ts'
import {
  editedText,
  formattable,
  formattedLines,
  readForView,
  saveEdited,
  sourceLines,
  textLines,
  type ViewedFile,
} from '../viewer.ts'
import { type Wiring, why } from './context.ts'

// The file you have open, the diff beside it, and the branch underneath.
//
// One subject because they are one question asked three ways: what is on disk
// here. A path clicked anywhere in the window resolves against the agent's
// worktree — that is what `resolvePath` and `hereOnDisk` are — and everything
// else follows from where that lands: read it, edit it and save it, read what
// git says changed about it, throw those changes away, or move the whole
// checkout to another branch.
//
// The viewer keeps the file it read rather than reading again per frame: a
// file is coloured as a whole file, and Markdown is laid out for the width it
// has, so both are kept beside the lines and redone only when the width moves.

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
}

export class Files {
  private readonly wire: Wiring
  private readonly deps: FilesDeps
  /** The file the viewer is showing, its coloured source, and its Markdown laid out at a width. */
  private viewed: {
    file: ViewedFile
    source: string[]
    /** The same lines uncoloured: what a find looks through and a caret counts in. */
    text: string[]
    formatted: { width: number; lines: string[] } | null
  } | null = null
  /** The diff the diff panel is showing, once git has answered. */
  private diff: ParsedDiff | null = null
  /** The project checkout's branches, for the Switch branch panel. */
  private branchRows: BranchRow[] = []

  constructor(wire: Wiring, deps: FilesDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** The diff the diff panel is showing, or nothing while git is still answering. */
  shownDiff(): ParsedDiff | null {
    return this.diff
  }

  /** The branches the Switch branch panel offers, as last read. */
  branches(): readonly BranchRow[] {
    return this.branchRows
  }

  /**
   * The file's own lines, and only while they are the file the panel is on: a
   * caret counts columns in them, and in the wrong file it would land
   * somewhere nobody pointed at.
   */
  textAt(panel: Panel | null): readonly string[] {
    if (panel?.kind !== 'file' || this.viewed?.file.path !== panel.path) return []
    return this.viewed?.text ?? []
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
      await launch(opener)
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

  /** Read a file into the viewer, at a line if there is one. */
  openFile(path: string, line: number | null = null): void {
    const file = readForView(path)
    this.viewed = {
      file,
      source: sourceLines(file, !this.deps.skin.colour),
      text: textLines(file),
      formatted: null,
    }
    this.wire.put({ ...this.wire.state, panel: filePanel(path, line, formattable(file)) })
    this.wire.draw()
  }

  /** What the viewer draws, with Markdown laid out for the width it has now. */
  viewing(width: number): NonNullable<Frame['panel']>['viewing'] {
    const viewed = this.viewed
    if (!viewed) return null
    if (!formattable(viewed.file))
      return { file: viewed.file, source: viewed.source, text: viewed.text, formatted: null }
    const room = fileViewSize(width, this.deps.size().rows).width - 4
    if (viewed.formatted?.width !== room) {
      viewed.formatted = {
        width: room,
        lines: formattedLines(viewed.file, room, !this.deps.skin.colour),
      }
    }
    return {
      file: viewed.file,
      source: viewed.source,
      text: viewed.text,
      formatted: viewed.formatted.lines,
    }
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
    const viewed = this.viewed
    const edit = panel.edit
    if (!viewed || !edit || viewed.file.path !== panel.path) return
    try {
      const file = saveEdited(viewed.file, editedText(edit, viewed.file))
      this.viewed = {
        file,
        source: sourceLines(file, !this.deps.skin.colour),
        text: textLines(file),
        formatted: null,
      }
      this.wire.put({
        ...this.wire.state,
        panel: savedFile(panel, this.viewed.text, `Saved ${basename(panel.path)}.`),
      })
      this.wire.draw()
      await this.wire.live?.refresh()
    } catch (err) {
      this.wire.put({ ...this.wire.state, panel: { ...panel, said: why(err), warned: true } })
    }
    this.wire.draw()
  }

  async openLink(url: string): Promise<void> {
    try {
      const opener = openerForLink(url)
      if (opener.kind === 'detached') await launch(opener)
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
        if (focused) await this.openDiff(focused.task, path)
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
        if (first) await this.openDiff(focused.task, first.path)
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
      if (process.platform === 'darwin') {
        await launch({ kind: 'detached', command: 'open', args: folder ? [path] : ['-R', path] })
      } else {
        await launch({
          kind: 'detached',
          command: 'xdg-open',
          args: [folder ? path : dirname(path)],
        })
      }
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
    const text = await this.wire.live?.diffOf(task, path).catch(() => null)
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
    if (panel?.kind !== 'file' || !this.viewed) return 0
    const viewing = this.viewing(this.deps.size().columns)
    if (panel.edit) return panel.edit.lines.length
    return panel.formatted && viewing?.formatted
      ? viewing.formatted.length
      : this.viewed.source.length
  }

  /** The size of the viewer's body, for keeping the caret in it and for reading a click. */
  body(panel: FilePanel): { rows: number; columns: number } {
    return fileBodySize(
      this.deps.size().columns,
      this.deps.size().rows,
      this.lines(),
      panel.asking !== null,
    )
  }
}

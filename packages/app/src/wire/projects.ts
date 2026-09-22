import { homedir } from 'node:os'
import { basename } from 'node:path'
import { type Config, expandHome, loadConfig } from '@tade/core'
import type { Frame } from '../frame.ts'
import { notice, selectProject, withProjects } from '../model.ts'
import {
  nameFrom,
  type OpenProjectPanel,
  type OpenRow,
  type OpenRowView,
  openProjectPanel,
} from '../panels/project/state.ts'
import {
  ago,
  branchOf,
  browsing,
  expand,
  initialise,
  isPath,
  isRepo,
  listFolders,
  makeFolder,
  noteRecent,
  readRecents,
  recentProjects,
  whatIsAt,
} from '../projects.ts'
import { addProject } from '../settings.ts'
import {
  type Actions,
  configPathOf,
  type Subject,
  type Submits,
  tilde,
  type Wiring,
  why,
} from './context.ts'

// Opening a project: the folder you are looking in, the folders in it, and the
// projects Tade already knows.
//
// Read from disk once per folder and per query, never once per frame. The list
// is drawn four times a second, and a `readdir` of a home directory per frame
// is how a window stops feeling like one; a typed path is a different folder,
// which is why the key of the cache is the two of them together.
//
// Each row's branch is asked for once and kept by path, because it is a git
// process per folder and the answer cannot change while you are choosing.

/** What this subject needs from the rest of the window. */
export interface ProjectsDeps {
  /** A project added is a config written: everything that holds one reads it back. */
  useConfig(config: Config): void
  /** A project with no agents gets one, so the window opens on something. */
  ensureAgent(project: string): void
}

export class Projects implements Subject {
  private readonly wire: Wiring
  private readonly deps: ProjectsDeps
  /** The list for the last folder and query, and the folder it was read in. */
  private cache: { key: string; rows: OpenRow[]; browsing: string | null } | null = null
  /** Each row's branch, once git has answered for it. */
  private readonly branches = new Map<string, string | null>()

  constructor(wire: Wiring, deps: ProjectsDeps) {
    this.wire = wire
    this.deps = deps
  }

  panel(): Frame['panel'] {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'open-project') return {}
    return { openRows: this.rowsFor(panel), browsing: this.cache?.browsing ?? null }
  }

  inputs() {
    const panel = this.wire.state.panel
    return { rows: panel?.kind === 'open-project' ? this.rowsFor(panel).map((one) => one.row) : [] }
  }

  actions(): Actions {
    return {
      'open-project': () => {
        // A fresh list: the folders on disk may have changed since last time.
        this.cache = null
        this.wire.put({ ...this.wire.state, panel: openProjectPanel(homedir()) })
        this.wire.draw()
      },
    }
  }

  submits(): Submits {
    return { 'open-project': (panel) => this.open(panel) }
  }

  /**
   * The Open project list: the projects Tade already knows, then the folder
   * being looked in and the folders in it — and, where what was typed is a
   * path nothing is at, the offer to make it.
   *
   * The recent ones come first because opening a project you have is what
   * this panel is mostly for. A typed path leaves them out altogether: a
   * query that says where to look is not a query about them, and matching
   * every one of them against it put a dozen rows above the folder asked for.
   */
  private rowsFor(panel: OpenProjectPanel): OpenRowView[] {
    const key = `${panel.dir}\x00${panel.query}`
    if (this.cache?.key !== key) {
      const path = isPath(panel.query)
      const words = path ? [] : panel.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
      const matches = (text: string) => words.every((word) => text.toLowerCase().includes(word))
      const { dir, prefix } = path
        ? browsing(panel.query, panel.dir)
        : { dir: panel.dir, prefix: '' }
      const folders = listFolders(dir, prefix, 500)
        .filter((folder) => matches(folder.name))
        .map((folder) => ({
          kind: 'folder' as const,
          name: folder.name,
          path: folder.path,
          git: folder.git !== null,
        }))
      // The folder being looked in, where it is one: a path typed a character
      // at a time is a folder that does not exist yet for most of the typing.
      const here =
        whatIsAt(dir) === 'folder'
          ? [{ kind: 'here' as const, name: basename(dir) || dir, path: dir, git: isRepo(dir) }]
          : []
      // Somewhere to work that is not there yet. Offered only where nothing at
      // all is at the path — a file in the way is not a folder to create, and
      // nothing here ever writes over what somebody already has.
      const full = path ? expand(panel.query, panel.dir) : ''
      const fresh =
        path && basename(full) !== '' && whatIsAt(full) === 'nothing'
          ? [{ kind: 'new' as const, name: basename(full), path: full, git: false }]
          : []
      const recent = path
        ? []
        : recentProjects(readRecents(this.wire.opts.home), this.wire.opts.config.projects)
            .filter((entry) => matches(`${entry.name} ${entry.root}`))
            .slice(0, 12)
            .map((entry) => ({
              kind: 'recent' as const,
              name: entry.name,
              path: expandHome(entry.root),
              git: true,
            }))
      this.cache = { key, rows: [...recent, ...fresh, ...here, ...folders], browsing: dir }
      for (const row of this.cache.rows) {
        if (row.git && !this.branches.has(row.path)) {
          this.branches.set(row.path, null)
          void branchOf(row.path).then((branch) => {
            this.branches.set(row.path, branch)
            this.wire.draw()
          })
        }
      }
    }
    const recents = readRecents(this.wire.opts.home)
    return this.cache.rows.map((row) => ({
      row,
      branch: this.branches.get(row.path) ?? null,
      tasks:
        row.kind === 'recent'
          ? this.wire.state.panes.filter((pane) => pane.project === row.name).length
          : 0,
      when:
        row.kind === 'recent'
          ? ago(recents.find((entry) => entry.name === row.name)?.at ?? 0, this.wire.now())
          : null,
    }))
  }

  /**
   * Open what was chosen: go to a project Tade knows, or make a folder into
   * one — creating it where it is not there yet, and making it a repository
   * where it is not one.
   *
   * What is true at this moment decides, never what the row said when it was
   * drawn: a folder can appear under us while somebody is typing a name for
   * it, and one that has turned up with git already in it is opened rather
   * than initialised. Nothing here writes over anything — the folder is only
   * made where nothing at all is at the path.
   */
  private async open(panel: OpenProjectPanel): Promise<void> {
    const chosen = this.rowsFor(panel)[panel.index]?.row
    const fail = (error: string) => {
      this.wire.put({ ...this.wire.state, panel: { ...panel, busy: false, error } })
    }
    if (!chosen) return fail('Choose a folder, or a recent project.')
    if (chosen.kind === 'recent') {
      this.wire.put({ ...selectProject(this.wire.state, chosen.name), panel: null })
      noteRecent(this.wire.opts.home, chosen.name, chosen.path, this.wire.now())
      return
    }
    const name = panel.name ?? nameFrom(chosen.path)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
      return fail('A name is lowercase letters, digits and dashes.')
    if (this.wire.opts.config.projects[name])
      return fail(`There is already a project called ${name}. Choose another name.`)
    try {
      const there = whatIsAt(chosen.path)
      if (there === 'something') return fail(`${tilde(chosen.path)} is not a folder.`)
      if (there === 'nothing') makeFolder(chosen.path)
      if (!isRepo(chosen.path)) {
        // The tick box is the choice about a folder that is already there and
        // has things in it. A folder Tade has just made has nothing to commit
        // and no choice to offer: git is what Tade needs to work at all.
        if (there === 'folder' && !panel.init)
          return fail('Tade needs git to start work here. Tick git init, or choose another folder.')
        await initialise(chosen.path)
      }
      const path = configPathOf(this.wire.opts)
      addProject(path, name, tilde(chosen.path))
      const loaded = await loadConfig(path)
      if (!loaded.ok) throw new Error(loaded.issues[0]?.message ?? 'the config would not load')
      this.deps.useConfig(loaded.config)
      noteRecent(this.wire.opts.home, name, tilde(chosen.path), this.wire.now())
      this.wire.put(withProjects(this.wire.state, Object.keys(loaded.config.projects)))
      this.wire.put(
        notice({ ...selectProject(this.wire.state, name), panel: null }, `opened ${name}`),
      )
      await this.wire.live?.refresh()
      this.deps.ensureAgent(name)
    } catch (err) {
      fail(why(err))
    }
  }
}

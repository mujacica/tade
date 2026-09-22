import { homedir } from 'node:os'
import { basename } from 'node:path'
import {
  type Config,
  expandHome,
  LINES_LOOKED_BACK,
  loadConfig,
  namedBy,
  writeSetting,
} from '@tade/core'
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
  neverInitialise,
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
  saidLately,
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

/** What the orchestrator's project tools do, answered from this window. */
export interface ProjectTools {
  openProject(req: { path: string; name?: string; create: boolean }): Promise<string>
  closeProject(req: { project: string; said: string }): Promise<string>
}

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
   * What the orchestrator's project tools do, answered from this window.
   *
   * The same two acts the panel performs, with who asked carried through: a
   * project opened by somebody who was not at the keyboard is a line in the
   * journal saying so.
   */
  tools(): ProjectTools {
    return {
      openProject: (req) => this.openAt({ ...req, by: 'orchestrator' }),
      closeProject: async (req) => {
        // Closing is checked where checking is precise: what somebody would
        // say to ask for it is the project's own name, so a line of theirs
        // with that name in it is a rule rather than a hope. Opening is not
        // checked the same way — what they say there is "my payments repo"
        // and what the tool takes is a path, and a word-match between the two
        // would refuse the ordinary case every time.
        if (req.said.trim() === '') {
          throw new Error(
            `Closing ${req.project} is only done when somebody asks for it. Pass what they said, word for word.`,
          )
        }
        const lines = await saidLately(this.wire, LINES_LOOKED_BACK)
        if (!namedBy({ path: req.project, title: req.project }, lines)) {
          throw new Error(
            `Nothing they have said names ${req.project}, so I will not close it. Ask them plainly, naming the project.`,
          )
        }
        return this.closeProject(req.project, 'orchestrator', req.said)
      },
    }
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
    try {
      await this.openAt({
        path: chosen.path,
        by: 'window',
        ...(panel.name === null ? {} : { name: panel.name }),
        // A row that is the offer to make somewhere is that offer taken: the
        // tick box is about a folder that is already there and has things in
        // it, and one Tade is about to make has no choice to offer.
        create: panel.init || chosen.kind === 'new',
      })
      this.wire.put({ ...this.wire.state, panel: null })
    } catch (err) {
      fail(why(err))
    }
  }

  /**
   * Open a place to work, however it was asked for: a project Tade already
   * has, a folder on disk it does not, or — where `create` says so — a folder
   * that is not there yet, made and turned into a repository.
   *
   * One door for the panel and for the orchestrator's tool, because a folder
   * you found and a folder you made already reached the same git and the same
   * `projects.<name>`, and a second way in is a second set of rules about what
   * is allowed to be written over.
   *
   * What is true at this moment decides, never what a row said when it was
   * drawn: a folder can appear under somebody while they are typing a name for
   * it, and one that has turned up with git already in it is opened rather
   * than initialised. Nothing here writes over anything — the folder is only
   * made where nothing at all is at the path, and a name already in the config
   * is refused rather than repointed.
   */
  async openAt(req: {
    path: string
    name?: string
    create: boolean
    /** Who asked, for the journal: the window, or the orchestrator on somebody's word. */
    by: 'window' | 'orchestrator'
    /** Their words, where it was the orchestrator that was asked. */
    said?: string
  }): Promise<string> {
    const full = expand(req.path, homedir())
    // Somewhere Tade already works: going to it is the whole of what opening
    // it means, and nothing is written.
    const already = Object.entries(this.wire.opts.config.projects).find(
      ([, project]) => expandHome(project.root) === full,
    )
    if (already) {
      const [name, project] = already
      this.wire.put(selectProject(this.wire.state, name))
      noteRecent(this.wire.opts.home, name, project.root, this.wire.now())
      await this.wire.live?.refresh()
      return `${name} is open — Tade already had it at ${tilde(full)}.`
    }
    const name = req.name ?? nameFrom(full)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
      throw new Error('A name is lowercase letters, digits and dashes.')
    if (this.wire.opts.config.projects[name])
      throw new Error(`There is already a project called ${name}. Choose another name.`)
    const there = whatIsAt(full)
    if (there === 'something') throw new Error(`${tilde(full)} is not a folder.`)
    if (there === 'nothing') {
      if (!req.create)
        throw new Error(
          `There is nothing at ${tilde(full)}. Ask for it to be created if that is what they meant.`,
        )
      makeFolder(full)
    }
    const made = !isRepo(full)
    if (made) {
      if (there === 'folder' && !req.create)
        throw new Error(
          `${tilde(full)} is not a git repository, and Tade needs git to start work there. Ask whether to \`git init\` it.`,
        )
      if (neverInitialise(full, homedir()))
        throw new Error(
          `Tade will not make a git repository of ${tilde(full)}. Choose a folder inside it.`,
        )
      await initialise(full)
    }
    const path = configPathOf(this.wire.opts)
    addProject(path, name, tilde(full))
    const loaded = await loadConfig(path)
    if (!loaded.ok) throw new Error(loaded.issues[0]?.message ?? 'the config would not load')
    this.deps.useConfig(loaded.config)
    noteRecent(this.wire.opts.home, name, tilde(full), this.wire.now())
    this.wire.put(withProjects(this.wire.state, Object.keys(loaded.config.projects)))
    // Written down once it is true: a project in the config, where it is, and
    // who put it there. `was` is empty because there was nothing — which is
    // what says this is an opening rather than a move.
    this.journal({
      path: `projects.${name}.root`,
      was: '',
      now: tilde(full),
      by: req.by,
      ...(req.said ? { said: req.said } : {}),
      ...(made ? { made: true } : {}),
    })
    this.wire.put(notice(selectProject(this.wire.state, name), `opened ${name}`))
    await this.wire.live?.refresh()
    this.deps.ensureAgent(name)
    return `Opened ${name} at ${tilde(full)}${made ? ', a new git repository' : ''}.`
  }

  /**
   * Stop working in a project: its entry leaves the config, and nothing else
   * happens at all.
   *
   * Nothing on disk is touched — the folder, every commit, branch and
   * worktree, everything under `.tade/` — and the journal is append-only, so
   * what happened there is still answerable. Opening the same path again
   * brings all of it back, which is what makes this the reversible act and
   * `rm -rf` somebody else's.
   *
   * A project with an agent still running in it is refused. Closing one is
   * about what Tade lists, and an agent at work is not a listing.
   */
  async closeProject(name: string, by: 'window' | 'orchestrator', said = ''): Promise<string> {
    // `hasOwn` rather than a truthy lookup: `projects.__proto__` is truthy on
    // any plain object, and a name that reached here as text should never be
    // able to be one of those.
    const project = Object.hasOwn(this.wire.opts.config.projects, name)
      ? this.wire.opts.config.projects[name]
      : undefined
    if (!project) throw new Error(`There is no project called ${name}.`)
    const working = this.wire.opts.client
      .runs()
      .map((run) => run.task)
      .filter((task) => task === name || task.startsWith(`${name}/`))
    if (working.length > 0) {
      throw new Error(
        `${name} still has ${working.length === 1 ? 'an agent' : 'agents'} running: ${working.join(', ')}. Stop them first if that is what they meant.`,
      )
    }
    const path = configPathOf(this.wire.opts)
    writeSetting(path, `projects.${name}`, undefined)
    const loaded = await loadConfig(path)
    if (!loaded.ok) throw new Error(loaded.issues[0]?.message ?? 'the config would not load')
    this.deps.useConfig(loaded.config)
    // What it was is the whole of what undoing this needs: the path, and that
    // is all that was ever written down about where a project is.
    this.journal({
      path: `projects.${name}.root`,
      was: project.root,
      now: '',
      by,
      ...(said ? { said } : {}),
    })
    const left = Object.keys(loaded.config.projects)
    const state = withProjects({ ...this.wire.state, known: left }, left)
    const elsewhere = this.wire.state.project === name ? (left[0] ?? null) : this.wire.state.project
    this.wire.put(
      notice(
        elsewhere ? selectProject(state, elsewhere) : { ...state, project: null, focused: null },
        `closed ${name}`,
      ),
    )
    await this.wire.live?.refresh()
    return `Closed ${name}. Nothing was deleted: ${tilde(expandHome(project.root))} is untouched — its git history, its branches, every worktree and everything under .tade are exactly as they were, and opening that path again brings it all back.`
  }

  /**
   * One line saying what changed, so a change nobody watched is still a change
   * somebody can find.
   *
   * Not awaited and never thrown out of, like everything the window journals:
   * a line the journal will not take is not a reason to lose the project
   * somebody just opened, or to keep them waiting on a disk while it goes.
   */
  private journal(detail: Record<string, unknown>): void {
    void this.wire.opts.client.log.append({ type: 'config_changed', detail }).catch(() => {})
  }
}

import { homedir } from 'node:os'
import { basename } from 'node:path'
import {
  type Config,
  expandHome,
  LINES_LOOKED_BACK,
  loadConfig,
  namedBy,
  PROJECT_ORDER_REACH,
  titlesOf,
  writeSetting,
} from '@tade/core'
import type { Frame } from '../frame.ts'
import {
  moveProject,
  notice,
  projects,
  selectProject,
  shownProject,
  withProjectOrder,
  withProjects,
} from '../model.ts'
import { projectMenuItems } from '../panels/menu/state.ts'
import {
  nameFrom,
  type OpenProjectPanel,
  type OpenRow,
  type OpenRowView,
  openProjectPanel,
} from '../panels/project/state.ts'
import { PROJECTS } from '../panels/settings/projects.ts'
import { promptPanel } from '../panels/small/state.ts'
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
  type Menus,
  type Prompts,
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
  renameProject(req: { project: string; name: string; said: string }): Promise<string>
  reorderProjects(req: { order: readonly string[] }): Promise<string>
  configureProject(req: {
    project: string
    setting: string
    value: string
    said: string
  }): Promise<string>
}

/** What this subject needs from the rest of the window. */
export interface ProjectsDeps {
  /** A project added is a config written: everything that holds one reads it back. */
  useConfig(config: Config): void
  /**
   * The one path a setting is written by, with its reach checked and its line
   * in the journal: renaming and configuring are settings acts, and a second
   * writer for them would be a second set of rules about what may be written.
   */
  changeSetting(req: { path: string; value: string; said: string }): Promise<string>
  /** The same write, from the window, where nobody has to be asked. */
  writeSetting(path: string, value: string): Promise<string>
  /** Open Settings on a category — on one project of it, or on matching words. */
  openSettings(category: string, search: string, project?: string): Promise<string>
  /** Written down on the way out, so a row somebody arranged survives a close. */
  rememberWindow(): void
}

/**
 * The per-project settings Configure reaches, by the short name the
 * orchestrator's tool takes — and `root` is deliberately not among them.
 *
 * Moving a root moves where every agent in the project works, which is the one
 * thing `settingReach` refuses outright; it is named here with that reason
 * rather than left to fall through as "no such setting", because a refusal
 * that says what to do instead is the difference between a model asking a
 * person and a model trying the next thing.
 */
const CONFIGURABLE = [
  'title',
  'brief',
  'workspace',
  'push',
  'worker',
  'max_parallel',
  'test_command',
  'budget.usd_per_day',
  'budget.tokens_per_day',
  'checks.before',
  'checks.on_red',
  'checks.parallel',
] as const

/** Whether one of those, or an override for a named check, which is any id. */
const configurable = (setting: string): boolean =>
  (CONFIGURABLE as readonly string[]).includes(setting) || /^checks\.run_here\.[^.]+$/.test(setting)

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
      // The `×` on a tab. It asks nothing first, because there is nothing to
      // ask about: closing destroys nothing, and the notice says so. Refused
      // while an agent is running, in its own words, where notices go.
      //
      // The only one of a project's acts with a button of its own — the rest
      // are in the menu beside it, which is where something that needs a name
      // typed, a direction chosen or a page opened belongs.
      'close-project:': (project) => this.closeFromWindow(project),
    }
  }

  submits(): Submits {
    return { 'open-project': (panel) => this.open(panel) }
  }

  menus(): Menus {
    return {
      project: {
        title: (subject) => shownProject(this.wire.state, subject.project),
        items: (subject) => {
          const order = projects(this.wire.state)
          const at = order.indexOf(subject.project)
          return projectMenuItems({
            running: this.agentsIn(subject.project).length,
            first: at <= 0,
            last: at === order.length - 1,
          })
        },
        choose: (subject, item) => this.fromProjectMenu(subject.project, item),
      },
    }
  }

  prompts(): Prompts {
    return {
      'rename-project': async (panel, text) => {
        if (!panel.target) return
        const project = panel.target
        try {
          const name = await this.renameTo(project, text)
          // The short of it on the notice line, where a sentence does not fit.
          // What it did *not* move is still said in full where somebody is
          // reading rather than glancing: the tool's answer, and the setting's
          // own `means` on the page this rename is a shortcut to.
          this.wire.put(
            notice(
              { ...this.wire.state, panel: null },
              name === '' ? `${project} is ${project} again` : `${project} shows as ${name}`,
            ),
          )
        } catch (err) {
          this.wire.put({ ...this.wire.state, panel: { ...panel, busy: false, error: why(err) } })
        }
      },
    }
  }

  /** What a project's menu does: its name here, where its tab sits, its settings, or closing it. */
  private async fromProjectMenu(project: string, item: string): Promise<void> {
    switch (item) {
      case 'rename':
        return this.askName(project)
      case 'move-left':
        return this.move(project, -1)
      case 'move-right':
        return this.move(project, 1)
      case 'configure':
        // The Projects page, on this project: it is one page of that project's
        // own answers, behind a selector that says which. It used to be the
        // project's name typed into the search box, which showed every setting
        // whose words happened to contain it as well.
        await this.deps.openSettings(PROJECTS, '', project)
        return
      case 'close':
        return this.closeFromWindow(project)
    }
  }

  /** Close it from the window, and put the reason where notices go if it will not. */
  private async closeFromWindow(project: string): Promise<void> {
    await this.closeProject(project, 'window').catch((err) => this.wire.note(err))
    this.wire.draw()
  }

  /** The one line asked for, filled in with whatever it is called now. */
  private askName(project: string): void {
    this.wire.put({
      ...this.wire.state,
      panel: {
        ...promptPanel(
          'rename-project',
          `Call ${project}`,
          'NAME',
          this.wire.opts.config.projects[project]?.title ?? '',
        ),
        target: project,
      },
    })
    this.wire.draw()
  }

  /**
   * Move a tab one place, and write the whole row down.
   *
   * Written here and not only on the way out, exactly as hiding the finished
   * agents is: the window you arrange is the window you leave open for days,
   * and one that was killed rather than closed would forget it every time.
   */
  private move(project: string, by: -1 | 1): void {
    const order = moveProject(this.wire.state, project, by)
    this.wire.put(withProjectOrder(this.wire.state, order))
    this.deps.rememberWindow()
    this.wire.draw()
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
      // Through the one writer, so the reach, the person's own words and the
      // line in the journal are the settings page's and not a second set of
      // rules written here. What this adds on top of `tade_setting_change` is
      // the thing that tool has no idea it is looking at: two tabs reading the
      // same word.
      renameProject: async (req) => {
        const project = this.mustHave(req.project)
        const name = this.checkedName(project, req.name)
        await this.deps.changeSetting({
          path: `projects.${project}.title`,
          value: name,
          said: req.said,
        })
        return this.renamed(project, name)
      },
      reorderProjects: async (req) => {
        this.mayReorder()
        const known = projects(this.wire.state)
        const unknown = req.order.filter((name) => !known.includes(name))
        if (unknown.length > 0) {
          throw new Error(
            `Tade has no project called ${unknown.join(', ')}. tade_status says which there are.`,
          )
        }
        // What was left out keeps its place after what was named, rather than
        // being dropped: a tool given three of five projects is somebody
        // saying where those three go, never that the other two are gone.
        const order = [...req.order, ...known.filter((name) => !req.order.includes(name))]
        this.wire.put(withProjectOrder(this.wire.state, order))
        this.deps.rememberWindow()
        this.wire.draw()
        return `The tabs are now ${order.join(', ')}. That is the order along the top of this window and nothing else — no project moved on disk, and nothing about the work changed.`
      },
      configureProject: async (req) => {
        const project = this.mustHave(req.project)
        const setting = req.setting.trim().replace(/^projects\.[a-z0-9-]+\./, '')
        if (setting === 'root') {
          throw new Error(
            `Where ${project} lives is not mine to change: moving a root moves where every agent in it works. A person moves it in Settings (ctrl+,) or with \`tade config\`, or it is closing it and opening it again, which is two acts each asked for.`,
          )
        }
        if (!configurable(setting)) {
          throw new Error(
            `${project} has no setting called ${setting}. It has ${CONFIGURABLE.join(', ')}, and checks.run_here.<check> for one check; tade_settings lists them with what each one is now.`,
          )
        }
        return this.deps.changeSetting({
          path: `projects.${project}.${setting}`,
          value: req.value,
          said: req.said,
        })
      },
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
    this.wire.put(
      withProjects(this.wire.state, Object.keys(loaded.config.projects), titlesOf(loaded.config)),
    )
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
    // Opened, and nothing started. A project with no agents lands on the empty
    // screen, which is a place rather than a gap; an agent comes from a task or
    // from somebody asking for one.
    this.wire.put(notice(selectProject(this.wire.state, name), `opened ${name}`))
    await this.wire.live?.refresh()
    return `Opened ${name} at ${tilde(full)}${made ? ', a new git repository' : ''}.`
  }

  /**
   * What a project is to be called here, checked — or the empty string, which
   * puts its own name back.
   *
   * The one thing a rename can do that is worse than nothing: leave two tabs
   * reading the same word. What a tab says is how somebody knows which project
   * they are in, so a name another project already answers to — as its own
   * name or as the name it was given — is refused rather than drawn.
   */
  private checkedName(project: string, name: string): string {
    const wanted = name.trim()
    // Its own name back is the way to undo one, and is not a collision with
    // itself: it clears the key rather than writing the name in twice.
    if (wanted === '' || wanted === project) return ''
    const same = wanted.toLowerCase()
    for (const [other, config] of Object.entries(this.wire.opts.config.projects)) {
      if (other === project) continue
      if (other.toLowerCase() === same || (config.title ?? '').toLowerCase() === same) {
        throw new Error(
          `${other} is already called ${wanted}, and two tabs with one name is somebody working in the wrong repository. Choose another.`,
        )
      }
    }
    return wanted
  }

  /**
   * Whether the orchestrator may move the tabs.
   *
   * The rule is `PROJECT_ORDER_REACH` in core, beside the one for a watch and
   * for the same reason: the order is not a config key, and answering "how far
   * does its arm reach" anywhere but there is how two answers to it come to
   * exist. It is `open`, which is the whole of the decision and why this asks
   * nothing.
   *
   * Raised to anything else it refuses outright rather than guessing what
   * words would authorise it: nobody has worked out what a person says to ask
   * for this, and a gate that invents the answer is worse than one that says
   * it has not got it. Whoever raises the tier writes the check.
   */
  private mayReorder(): void {
    const { reach, because } = PROJECT_ORDER_REACH
    if (reach === 'open') return
    throw new Error(
      `The order of the tabs is not mine to change: ${because}. A person moves one from its own menu.`,
    )
  }

  /** A project Tade has, by name, or why that name is not one. */
  private mustHave(name: string): string {
    const project = name.trim()
    // `hasOwn` rather than a truthy lookup, for the reason `closeProject`
    // gives: `projects.__proto__` is truthy on any plain object.
    if (!Object.hasOwn(this.wire.opts.config.projects, project))
      throw new Error(`There is no project called ${project}.`)
    return project
  }

  /** The agents running in a project: what closing it is refused for. */
  private agentsIn(name: string): string[] {
    return this.wire.opts.client
      .runs()
      .map((run) => run.task)
      .filter((task) => task === name || task.startsWith(`${name}/`))
  }

  /**
   * Rename from the window: the same write, with nobody to ask, and the state
   * caught up so the tab says it on the next frame.
   */
  private async renameTo(project: string, name: string): Promise<string> {
    const wanted = this.checkedName(this.mustHave(project), name)
    await this.deps.writeSetting(`projects.${project}.title`, wanted)
    this.renamed(project, wanted)
    return wanted
  }

  /**
   * What a rename did, said in full — because what it *didn't* do is the half
   * somebody needs, and they are deciding whether to do it again.
   */
  private renamed(project: string, name: string): string {
    this.wire.put(
      withProjects(
        this.wire.state,
        Object.keys(this.wire.opts.config.projects),
        titlesOf(this.wire.opts.config),
      ),
    )
    this.wire.draw()
    return name === ''
      ? `${project} is called ${project} again.`
      : `${project} is called ${name} on screen. Its name is still ${project} everywhere it is an id — every task in it is still ${project}/<task>, every commit its agents made still carries Tade-Task: ${project}/…, the journal still says ${project}, and nothing on disk moved.`
  }

  /**
   * Stop working in a project: its entry leaves the config, and nothing else
   * happens at all.
   *
   * Nothing on disk is touched — the folder, every commit, branch and
   * worktree, its folder in Tade's home — and the journal is append-only, so
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
    const working = this.agentsIn(name)
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
    const state = withProjects({ ...this.wire.state, known: left }, left, titlesOf(loaded.config))
    const elsewhere = this.wire.state.project === name ? (left[0] ?? null) : this.wire.state.project
    this.wire.put(
      notice(
        elsewhere ? selectProject(state, elsewhere) : { ...state, project: null, focused: null },
        `closed ${name}`,
      ),
    )
    await this.wire.live?.refresh()
    return `Closed ${name}. Nothing was deleted: ${tilde(expandHome(project.root))} is untouched — its git history, its branches and every worktree — and its tasks, notes and check runs are still in Tade's home, so opening that path again brings it all back.`
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

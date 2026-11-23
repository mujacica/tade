import { runningIn, takeRunLock } from '@tade/checks-core'
import {
  FILES_TOLD,
  joinedNames,
  LINES_LOOKED_BACK,
  mergeProposal,
  mergeSlugStem,
  mirrorDir,
  namedBy,
  ORIGIN,
  printable,
  recordsDir,
  type SyncFacts,
  type ProjectSync as SyncMode,
  type SyncVerdict,
  shortSha,
  syncedNews,
  syncFor,
  syncToldSays,
  syncVerdict,
  type TadeEvent,
} from '@tade/core'
import { lookSync, moveSync, type SyncLooked, type SyncLookOptions } from '@tade/status'
import { withTranscript } from '../model.ts'
import { problem } from '../transcript.ts'
import { saidLately, type Wiring } from './context.ts'
import { type Tellable, tellOrKeep } from './handed.ts'
import { putToOrchestrator } from './proposals.ts'

// Keeping each project's branch in step with origin and the person's other
// machines — core's six rules (`sync.ts`), status's git (`sync.ts` there), and
// here the rest: when to look, the checks lock across a move, the journal, the
// agents told, a parted branch made a proposal, and what is said.
//
// **The heart's, not the face's**, so a `tade serve` VPS keeps its own checkout
// in step from what the Mac pushes into its mirror, with nobody at it.
//
// **When.** Every project is looked at every `SYNC_EVERY_MS`, and at once when
// something says a source moved (`poke`: the mirror fetched a machine's new
// heads). Origin is fetched no oftener than `ORIGIN_EVERY_MS`, because that is
// the network. A wait — somebody mid-commit, a checks run — looks again after
// `SOON_MS`. A look that finds the same commits as the last finds nothing new:
// ancestry is kept by commit pair in status, so a quiet project asks git for
// its heads and no more.
//
// **Said once.** A refusal, a parted branch and a fetch that failed are each
// said in the strip once for as long as they stay the same, and a refusal or a
// parted branch is written once as `project_sync_held`. A parted branch is one
// proposal at a time: while the last merge proposed for that branch from that
// source is neither finished nor removed, no other is made.

/** How often a project is looked at, whatever else happens. */
export const SYNC_EVERY_MS = 60_000

/** The least time between two fetches from origin for one project. */
export const ORIGIN_EVERY_MS = 5 * 60_000

/** How soon a look that had to wait looks again. */
export const SOON_MS = 10_000

/** One project as a look needs it: its checkout, and who works where in it. */
export interface SyncProject {
  name: string
  root: string
  tasks: readonly { id: string; dir: string }[]
}

/** What the subject needs of the rest of the window, named so a test can hand it over. */
export interface ProjectSyncDeps {
  home: string
  /** Every project here as status last looked, or null before the first look. */
  projects(): readonly SyncProject[] | null
  /** The project's own answer (`projects.<name>.sync`), read at each look. */
  mode(project: string): SyncMode
  now(): number
  /** One line in the journal. */
  append(line: {
    type: 'project_synced' | 'project_sync_held'
    detail: Record<string, unknown>
  }): Promise<void>
  /** Said to a running agent, into its turn; throws where none is running. */
  steer(task: string, message: string): Promise<void>
  /** A merge for this branch from this source already proposed and still open, by its task id, or null. */
  openProposal(project: string, stem: string): Promise<string | null>
  /** The merge a parted branch needs, made parked and put to the orchestrator: the task's id. */
  propose(req: {
    project: string
    slug: string
    title: string
    prompt: string
    context: string
    base: string
  }): Promise<string>
  /** Told the orchestrator with the next thing somebody says. */
  news(text: string): void
  /** Told the orchestrator now, after its turn. */
  tell(text: string): void
  /** Said in the strip as trouble. */
  say(text: string): void
  /** The person's own lines lately, for the tool's gate: the journal's `said`. */
  saidLately(): Promise<readonly string[]>
  /** The look and the move: status's, or a test's. */
  look?: (opts: SyncLookOptions) => Promise<SyncLooked>
  move?: typeof moveSync
}

/** What one run of the rules came to, in a sentence somebody can act on. */
export interface SyncOutcome {
  verdict: SyncVerdict | null
  said: string
}

export class ProjectSync {
  private readonly deps: ProjectSyncDeps
  /** When each project was last looked at. */
  private readonly looked = new Map<string, number>()
  /** When origin was last fetched for each project. */
  private readonly fetched = new Map<string, number>()
  /** Projects owed a look on the next beat. */
  private readonly owed = new Set<string>()
  /** When a project that had to wait is looked at again. */
  private readonly again = new Map<string, number>()
  /** One run at a time per project, the tool's after the beat's. */
  private readonly turns = new Map<string, Promise<unknown>>()
  /** What each project was last held for, so it is written and said once. */
  private readonly held = new Map<string, string>()
  /** The commit each project was last said to be able to move to, under `ask`. */
  private readonly asked = new Map<string, string>()
  /** What each project's look could not do, said once. */
  private readonly troubled = new Map<string, string>()
  private readonly busy = new Set<string>()

  constructor(deps: ProjectSyncDeps) {
    this.deps = deps
  }

  /** A source of one project moved — or of every project, unnamed: looked at on the next beat. */
  poke(project?: string): void {
    for (const one of project === undefined ? (this.deps.projects() ?? []) : [{ name: project }]) {
      this.owed.add(one.name)
    }
  }

  /** The beat: every project that is due, looked at. The promise is what it started, which nothing that draws waits on. */
  beat(): Promise<void> {
    const now = this.deps.now()
    const started: Promise<unknown>[] = []
    for (const project of this.deps.projects() ?? []) {
      if (this.busy.has(project.name)) continue
      const last = this.looked.get(project.name)
      const again = this.again.get(project.name)
      const due =
        last === undefined ||
        now - last >= SYNC_EVERY_MS ||
        this.owed.has(project.name) ||
        (again !== undefined && now >= again)
      if (!due) continue
      this.owed.delete(project.name)
      this.again.delete(project.name)
      const origin = now - (this.fetched.get(project.name) ?? Number.NEGATIVE_INFINITY)
      // What it came to is said by the run itself; the beat waits only for it to end.
      void this.run(project.name, {
        fetchOrigin: origin >= ORIGIN_EVERY_MS,
        mode: this.deps.mode(project.name),
        asked: false,
      })
      started.push(this.turns.get(project.name) ?? Promise.resolve())
    }
    return Promise.all(started).then(() => {})
  }

  /**
   * The orchestrator's `tade_project_sync`: the rules now, origin fetched
   * first. Where the project says `ask` or `off`, only on a line of the
   * person's naming it — the line is the asking. Under `origin`, nothing said
   * moves it only as far as origin's commits, as a look would; a line of
   * theirs naming it moves it to another machine's too.
   */
  async now(req: { project: string; machine?: string; said?: string }): Promise<string> {
    const project = (this.deps.projects() ?? []).find((one) => one.name === req.project)
    if (!project) {
      throw new Error(
        `There is no project called ${req.project || '(none named)'} open here, or Tade has not looked at it yet.`,
      )
    }
    const mode = this.deps.mode(req.project)
    const said = req.said?.trim() ?? ''
    if (mode === 'origin' && said === '') {
      const outcome = await this.run(req.project, {
        fetchOrigin: true,
        mode,
        asked: true,
        ...(req.machine ? { only: [req.machine] } : {}),
      })
      return outcome.said
    }
    if (mode !== 'ff') {
      if (said === '') {
        throw new Error(
          `projects.${req.project}.sync is ${mode}, so ${req.project} is moved only when somebody asks for it. Pass what they said, word for word.`,
        )
      }
      if (!namedBy({ path: req.project, title: req.project }, await this.deps.saidLately())) {
        throw new Error(
          `Nothing they have said names ${req.project}, and projects.${req.project}.sync is ${mode}, so I will not move it. Ask them plainly, naming the project.`,
        )
      }
    }
    const outcome = await this.run(req.project, {
      fetchOrigin: true,
      mode: 'ff',
      asked: true,
      ...(req.machine ? { only: [req.machine] } : {}),
    })
    return outcome.said
  }

  /** The rules over one project, after any run already going on it. */
  run(
    name: string,
    how: { fetchOrigin: boolean; mode: SyncMode; asked: boolean; only?: readonly string[] },
  ): Promise<SyncOutcome> {
    const next = (this.turns.get(name) ?? Promise.resolve()).then(() => this.once(name, how))
    // The next run goes after this one however it ended; a failure is told to
    // whoever asked for this one, and said in the strip whoever that was.
    this.turns.set(
      name,
      next.then(
        () => {},
        (err: unknown) =>
          this.troubles(
            name,
            `keeping ${name} in step: ${err instanceof Error ? err.message : String(err)}`,
          ),
      ),
    )
    return next
  }

  private async once(
    name: string,
    how: { fetchOrigin: boolean; mode: SyncMode; asked: boolean; only?: readonly string[] },
  ): Promise<SyncOutcome> {
    const project = (this.deps.projects() ?? []).find((one) => one.name === name)
    if (!project) return { verdict: null, said: `${name} is not open here.` }
    this.busy.add(name)
    try {
      if (how.fetchOrigin) this.fetched.set(name, this.deps.now())
      const opts: SyncLookOptions = {
        project: name,
        root: project.root,
        mirror: mirrorDir(this.deps.home, name),
        fetchOrigin: how.fetchOrigin,
        tasks: project.tasks,
        ...(how.only ? { only: how.only } : {}),
      }
      const look = this.deps.look ?? lookSync
      const first = await look(opts)
      this.troubles(name, first.troubles.length === 0 ? null : first.troubles.join('; '))
      const verdict = syncVerdict(first.facts, how.mode)
      if (verdict.kind !== 'move') return await this.decided(project, first.facts, verdict, how)
      if (verdict.byRef) return await this.moved(project, first.facts, verdict)
      return await this.underLock(project, { ...opts, fetchOrigin: false }, how)
    } finally {
      this.looked.set(name, this.deps.now())
      this.busy.delete(name)
    }
  }

  /**
   * Rule 5: the move under the project's checks lock, so no suite sees half
   * of it — and the look taken again under it, because the tree may have
   * changed while it was asked for.
   */
  private async underLock(
    project: SyncProject,
    opts: SyncLookOptions,
    how: { mode: SyncMode; asked: boolean },
  ): Promise<SyncOutcome> {
    const records = recordsDir(this.deps.home, project.name)
    const lock = await takeRunLock(records, `keeping ${project.name}'s branch in step`)
    if ('held' in lock) {
      const since = lock.held.at ? ` since ${lock.held.at}` : ''
      return this.waited(
        project.name,
        `checks are running in ${project.root} (${lock.held.what || 'a run'}${since}), and no suite may see half a move`,
      )
    }
    try {
      const running = await runningIn(records)
      if (running !== null) {
        return this.waited(
          project.name,
          `checks are running in ${project.root} for ${shortSha(running.commit)}, and no suite may see half a move`,
        )
      }
      const again = await (this.deps.look ?? lookSync)(opts)
      const verdict = syncVerdict(again.facts, how.mode)
      if (verdict.kind !== 'move') return await this.decided(project, again.facts, verdict, how)
      return await this.moved(project, again.facts, verdict)
    } finally {
      await lock.release()
    }
  }

  /** Rule 6: the move itself, written down, and every agent in the checkout told. */
  private async moved(
    project: SyncProject,
    facts: SyncFacts,
    verdict: Extract<SyncVerdict, { kind: 'move' }>,
  ): Promise<SyncOutcome> {
    const branch = facts.branch ?? ''
    const was = facts.head ?? ''
    const failed = await (this.deps.move ?? moveSync)(project.root, facts, verdict.target)
    if (failed !== null) {
      const said = `${project.name}'s ${branch} could not be fast-forwarded to ${shortSha(verdict.target)}: ${printable(failed)}`
      this.troubles(project.name, said)
      return { verdict, said: `${said}.` }
    }
    this.held.delete(project.name)
    this.asked.delete(project.name)
    const files = facts.incoming.map((one) => one.path)
    const told: string[] = []
    // Each one that could not be told, and why: most often no agent is running
    // there, and one that starts later reads the tree as it is then.
    const untold: string[] = []
    if (!verdict.byRef && facts.at.kind === 'checkout') {
      const dir = facts.at.dir
      const message = syncToldSays({ branch, from: verdict.from, was, now: verdict.target, files })
      for (const task of project.tasks.filter((one) => one.dir === dir)) {
        await this.deps.steer(task.id, message).then(
          () => told.push(task.id),
          (err: unknown) =>
            untold.push(`${task.id}: ${err instanceof Error ? err.message : String(err)}`),
        )
      }
    }
    await this.deps.append({
      type: 'project_synced',
      detail: {
        project: project.name,
        branch,
        from: verdict.from.join(' '),
        was,
        now: verdict.target,
        files: files.slice(0, FILES_TOLD),
        ...(files.length > FILES_TOLD ? { more: files.length - FILES_TOLD } : {}),
        told,
        ...(untold.length > 0 ? { untold } : {}),
        byRef: verdict.byRef,
      },
    })
    const news = syncedNews({
      project: project.name,
      branch,
      from: verdict.from,
      was,
      now: verdict.target,
      files: files.length,
      told,
      byRef: verdict.byRef,
    })
    this.deps.news(news)
    return { verdict, said: news }
  }

  /** Every verdict but a move: said, written, proposed or put to the orchestrator, each once. */
  private async decided(
    project: SyncProject,
    facts: SyncFacts,
    verdict: SyncVerdict,
    how: { asked: boolean },
  ): Promise<SyncOutcome> {
    const name = project.name
    switch (verdict.kind) {
      case 'still':
        this.held.delete(name)
        return { verdict, said: `${name} was not moved: ${verdict.why}.` }
      case 'wait':
        return this.waited(name, verdict.why)
      case 'ask': {
        const said = `${name}: ${verdict.why}. tade_project_sync moves it when the person asks.`
        if (!how.asked && this.asked.get(name) !== verdict.target) {
          this.asked.set(name, verdict.target)
          this.deps.tell(said)
        }
        return { verdict, said }
      }
      case 'refused':
      case 'apart': {
        const said = `${name}'s ${facts.branch ?? 'branch'} was not moved: ${verdict.why}.`
        await this.holdOnce(
          name,
          `${verdict.kind}:${targetKey(facts)}:${verdict.kind === 'refused' ? verdict.paths.join('\0') : ''}`,
          said,
          {
            project: name,
            branch: facts.branch ?? '',
            held: verdict.kind,
            why: verdict.why,
            ...(verdict.kind === 'refused' ? { paths: verdict.paths } : {}),
          },
        )
        return { verdict, said }
      }
      case 'diverged':
        return this.parted(project, facts, verdict)
      case 'move':
        return { verdict, said: '' }
    }
  }

  /** A parted branch: one merge proposed, worked in a worktree of its own, while none is open. */
  private async parted(
    project: SyncProject,
    facts: SyncFacts,
    verdict: Extract<SyncVerdict, { kind: 'diverged' }>,
  ): Promise<SyncOutcome> {
    const name = project.name
    const branch = facts.branch ?? ''
    // A machine's own branch is the one to merge where it and origin agree: it is the newer word.
    const from = verdict.from.find((one) => one !== ORIGIN) ?? verdict.from[0] ?? ORIGIN
    const stem = mergeSlugStem(from, branch)
    const open = await this.deps.openProposal(name, stem)
    let proposal = open
    if (open === null) {
      const made = mergeProposal({
        project: name,
        branch,
        from,
        head: facts.head ?? '',
        target: verdict.target,
        ahead: verdict.ahead,
        behind: verdict.behind,
      })
      proposal = await this.deps.propose({ project: name, ...made, base: branch })
    }
    const said = `${name}'s ${branch} was not moved: ${verdict.why}. ${open === null ? `Proposed ${proposal}, parked for the orchestrator.` : `${proposal} is already proposed for it.`}`
    await this.holdOnce(name, `diverged:${targetKey(facts)}`, said, {
      project: name,
      branch,
      held: 'diverged',
      why: verdict.why,
      from: joinedNames(verdict.from),
      ...(proposal ? { proposal } : {}),
    })
    return { verdict, said }
  }

  /** A wait: nothing written, looked at again soon. */
  private waited(name: string, why: string): SyncOutcome {
    this.again.set(name, this.deps.now() + SOON_MS)
    return {
      verdict: { kind: 'wait', why },
      said: `${name} was not moved yet: ${why}. Tade looks again in ${SOON_MS / 1000} seconds.`,
    }
  }

  /** Written down and said in the strip once for as long as it stays the same reason. */
  private async holdOnce(
    name: string,
    key: string,
    said: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (this.held.get(name) === key) return
    this.held.set(name, key)
    this.deps.say(said)
    await this.deps.append({ type: 'project_sync_held', detail })
  }

  /** Said once for as long as it stays the same trouble, and forgotten once it has gone. */
  private troubles(name: string, said: string | null): void {
    if (said === null) this.troubled.delete(name)
    else if (this.troubled.get(name) !== said) {
      this.troubled.set(name, said)
      this.deps.say(printable(said))
    }
  }
}

/** The commits a reason was about: the same reason about other commits is news again. */
function targetKey(facts: SyncFacts): string {
  const target = facts.target.kind === 'one' ? facts.target.sha : facts.target.kind
  return `${facts.head ?? ''}..${target}`
}

/**
 * Whether a merge proposed for one branch from one source is still open: the
 * newest task made under its name that has neither finished nor been removed.
 */
export function openProposalIn(
  events: readonly TadeEvent[],
  project: string,
  stem: string,
): string | null {
  const prefix = `${project}/${stem}-`
  const open = new Set<string>()
  for (const event of events) {
    const task = event.task
    if (!task?.startsWith(prefix)) continue
    if (event.type === 'task_created') open.add(task)
    else if (event.type === 'task_removed' || event.type === 'task_done') open.delete(task)
  }
  return [...open].at(-1) ?? null
}

/** The heart's half: the world status last looked at, the journal, the agents and the orchestrator. */
export function projectSyncFor(wire: Wiring, orchestrator: () => Tellable): ProjectSync {
  const client = wire.opts.client
  return new ProjectSync({
    home: wire.opts.home,
    projects: () => {
      const world = wire.live?.world
      if (!world) return null
      return world.projects.map((one) => ({
        name: one.name,
        root: one.root,
        tasks: one.tasks.map((task) => ({ id: task.id, dir: task.worktree })),
      }))
    },
    mode: (project) => syncFor(wire.opts.config.projects, project),
    now: () => wire.now(),
    append: async (line) => {
      await client.log.append({ type: line.type, task: null, detail: line.detail })
    },
    steer: (task, message) => client.steerAgent(task, message),
    openProposal: async (project, stem) =>
      openProposalIn(
        await client.log.read({ types: ['task_created', 'task_removed', 'task_done'] }),
        project,
        stem,
      ),
    propose: async (req) => {
      const task = await client.createTask({
        project: req.project,
        slug: req.slug,
        intent: req.prompt,
        by: 'orchestrator',
        workspace: 'worktree',
        base: req.base,
        context: req.context,
        start: { after: [], prompt: req.prompt, touches: [] },
        proposed: { title: req.title },
      })
      // Through the one door that writes a park, straight after it is made, as a proposed check is.
      await client.parkTask(task.id, true, { by: 'orchestrator' })
      putToOrchestrator(
        wire,
        orchestrator(),
        `${req.title}: ${req.prompt}\n\nProposed as ${task.id}, parked: decide it with tade_proposal_decide, with a sentence why — start it, or leave it if the branches are already being brought together.`,
        [task.id],
      )
      return task.id
    },
    news: (text) => orchestrator().note(text),
    tell: (text) => tellOrKeep(wire, orchestrator(), text, 'that a project could be moved'),
    say: (text) => {
      wire.put(withTranscript(wire.state, problem(wire.state.transcript, text, wire.now())))
      wire.draw()
    },
    saidLately: () => saidLately(wire, LINES_LOOKED_BACK),
  })
}

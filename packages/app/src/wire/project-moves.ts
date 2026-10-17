import { expandHome, machineLabel, printable } from '@tade/core'
import type { Answer, Remote, RemoteLink } from '@tade/remotes-core'
import { repositoryAt } from '@tade/status'
import { OpenAnswerSchema } from '@tade/web'
import type { Machines } from '../machines.ts'
import type { ProjectMove } from '../panels/settings/remotes.ts'
import { type Wiring, why } from './context.ts'
import { cloneUrlAt, projectOf } from './hand-over.ts'

// A whole project moved to another machine of the person's (REMOTE-TADE.md
// §9.2): "closing it on one machine and opening it on the other", made one
// guided flow on Settings › Remotes — a row per project here with the one
// press that is next. **Open it there**: that machine's own door
// (`/api/open`, `web-open.ts` there) finds it among its projects, opens a
// checkout of it already beside them, or clones one with its own credentials
// from origin's URL with any token taken out (`cloneUrlAt`). **Hand its work
// over**: every agent running here in it handed over and every piece of queued
// work that can go started there, through `moves.ts` exactly as one press each
// would. **Close it here**: the window's own door (`Projects.closeProject`),
// which keeps everything — refused while it is not open there, or while
// anything of it still runs here.
//
// The steps are only ever offered in that order, one at a time, and none while
// a press is under way; each says what it did, or why not, on the page.

/** The window's door that closes a project here (`Projects.closeProject`). */
export interface ProjectDoor {
  closeProject(name: string, by: string): Promise<string>
}

/** What moving a project needs of the links, and of the page it is drawn on. */
export interface ProjectMovesDeps {
  reach(machine: string): { link: RemoteLink; remote: Remote; live: boolean } | null
  machines(): Machines
  sameAs(project: string): readonly { machine: string; project: string }[]
  /** Said on the Remotes page: what a press did, or why it did not. */
  told(saved: string | null, error: string | null): void
}

/** What moving a project asks of moving its tasks (`moves.ts`). */
export interface TaskMoves {
  handOver(task: string, machine: string, by: 'you'): Promise<string>
  startThere(task: string, machine: string, by: 'you'): Promise<string>
  /** Whether a running task is being handed over now. */
  handingNow(task: string): boolean
}

export class ProjectMoves {
  private readonly wire: Wiring
  private readonly deps: ProjectMovesDeps
  private readonly moves: TaskMoves
  /** Projects a press is moving now, as `<machine> <project>`. */
  private readonly stepping = new Set<string>()

  constructor(wire: Wiring, deps: ProjectMovesDeps, moves: TaskMoves) {
    this.wire = wire
    this.deps = deps
    this.moves = moves
  }

  /**
   * Each project here, as moving it to that machine stands (REMOTE-TADE.md
   * §9.2: "close it on one machine, open it on the other", as one guided
   * flow): not there yet, so open it there; there, with work still here, so
   * hand that over; nothing of it working here, so close it here. One press
   * each, the next one only, and none while one is under way.
   */
  projectMoves(machine: string): ProjectMove[] {
    const runs = this.wire.opts.client.runs().map((run) => run.task as string)
    const queued = this.wire.live?.queued ?? []
    return Object.keys(this.wire.opts.config.projects).map((project): ProjectMove => {
      if (this.stepping.has(`${machine} ${project}`)) {
        return { project, said: `moving to ${machine}…`, next: null }
      }
      const there = [
        ...new Set(
          this.deps
            .sameAs(project)
            .filter((one) => one.machine === machine)
            .map((one) => one.project),
        ),
      ]
      if (there.length === 0) return { project, said: `not on ${machine} yet`, next: 'open' }
      if (there.length > 1) {
        return {
          project,
          said: `on ${machine} ${there.length} times: ${there.join(', ')}`,
          next: null,
        }
      }
      const mine = runs.filter((task) => projectOf(task) === project)
      const handing = mine.filter((task) => this.moves.handingNow(task))
      const waits = queued.filter((one) => one.project === project)
      const movable = waits.filter((one) => movableQueued(one, queued))
      const stays = waits.length - movable.length
      const parts = [`on ${machine} as ${there[0]}`]
      if (mine.length > handing.length) parts.push(`${mine.length - handing.length} running here`)
      if (handing.length > 0) parts.push(`${handing.length} being handed over`)
      if (movable.length > 0) parts.push(`${movable.length} queued here`)
      if (stays > 0) parts.push(`${stays} queued that wait${stays === 1 ? 's' : ''} and stay here`)
      if (handing.length > 0) return { project, said: parts.join(' · '), next: null }
      const left = mine.length > 0 || movable.length > 0
      if (!left) parts.push('nothing of it is working here')
      return { project, said: parts.join(' · '), next: left ? 'hand' : 'close' }
    })
  }

  /**
   * A press in that flow: `remote:move-<open|hand|close>:<machine>:<project>`.
   * What came of it, or why not, is handed to `told` — the Remotes page's line.
   */
  async step(choice: string, projects: ProjectDoor | undefined): Promise<void> {
    const [, verb = '', machine = '', project = ''] = choice.split(':')
    const key = `${machine} ${project}`
    if (this.stepping.has(key)) return
    this.stepping.add(key)
    this.wire.draw()
    try {
      const said =
        verb === 'move-open'
          ? await this.openThere(machine, project)
          : verb === 'move-hand'
            ? await this.handProject(machine, project)
            : verb === 'move-close'
              ? await this.closeHere(machine, project, projects)
              : null
      if (said !== null) this.deps.told(said, null)
    } catch (err) {
      this.deps.told(null, why(err))
    } finally {
      this.stepping.delete(key)
      this.wire.draw()
    }
  }

  /** Open it there: cloned with that machine's own credentials where it has no checkout of it yet. */
  private async openThere(machine: string, project: string): Promise<string> {
    this.machineNamed(machine)
    const reach = this.deps.reach(machine)
    if (reach === null || !reach.live) throw new Error(`${machine} is not linked now`)
    const root = this.rootOf(project)
    if (root === null) throw new Error(`There is no project called ${project} here.`)
    const repository = await repositoryAt(root)
    const clone = await cloneUrlAt(root)
    if (repository === null || clone === null) {
      throw new Error(
        `${project} has no origin another machine could clone it from: push it somewhere both machines reach, and set that as its origin.`,
      )
    }
    let answer: Answer
    try {
      answer = await reach.link.call(reach.remote, '/api/open', {
        from: machineLabel(),
        name: project,
        repository,
        clone,
      })
    } catch (err) {
      throw new Error(
        `${machine}: ${printable(why(err))} — look at its projects before asking again`,
      )
    }
    if (answer.status === 404) {
      throw new Error(
        `${machine}'s Tade cannot open a project for another machine: update it there (tade update).`,
      )
    }
    const read = OpenAnswerSchema.safeParse(answer.body)
    if (answer.status !== 200 || !read.success) {
      const said = (answer.body as { said?: unknown } | null)?.said
      throw new Error(
        `${machine} refused: ${typeof said === 'string' ? printable(said) : `it answered ${answer.status}`}`,
      )
    }
    if (!read.data.opened) throw new Error(`${machine}: ${printable(read.data.said)}`)
    return `${project} is open on ${machine} as ${printable(read.data.project)}. ${printable(read.data.said)}`
  }

  /** Hand its work over: every agent running here in it, and every piece of queued work that can go. */
  private async handProject(machine: string, project: string): Promise<string> {
    const running = this.wire.opts.client
      .runs()
      .map((run) => run.task as string)
      .filter((task) => projectOf(task) === project && !this.moves.handingNow(task))
    const queued = this.wire.live?.queued ?? []
    const movable = queued.filter((one) => one.project === project && movableQueued(one, queued))
    const done: string[] = []
    const not: string[] = []
    for (const task of running) {
      await this.moves.handOver(task, machine, 'you').then(
        () => done.push(`${task} told to push`),
        (err: unknown) => not.push(`${task}: ${why(err)}`),
      )
    }
    for (const one of movable) {
      await this.moves.startThere(one.task, machine, 'you').then(
        () => done.push(`${one.task} queued there`),
        (err: unknown) => not.push(`${one.task}: ${why(err)}`),
      )
    }
    if (done.length === 0 && not.length === 0)
      return `Nothing of ${project} is left to hand to ${machine}.`
    if (not.length > 0) {
      throw new Error(`${[...done, ...not].join('; ')}. Its conversation stays here in every case.`)
    }
    return `${done.join('; ')}. Their conversations stay here; once each is on ${machine}, close ${project} here.`
  }

  /** Close it here, once it is open there and nothing of it is working here. */
  private async closeHere(
    machine: string,
    project: string,
    projects: ProjectDoor | undefined,
  ): Promise<string> {
    if (projects === undefined) throw new Error('this window cannot close a project from here')
    if (!this.deps.sameAs(project).some((one) => one.machine === machine)) {
      throw new Error(`${project} is not open on ${machine} yet, so it is not closed here.`)
    }
    const running = this.wire.opts.client.runs().filter((run) => projectOf(run.task) === project)
    if (running.length > 0) {
      throw new Error(
        `${running.map((run) => run.task).join(', ')} still ${running.length === 1 ? 'runs' : 'run'} here: hand ${running.length === 1 ? 'it' : 'them'} over first.`,
      )
    }
    return projects.closeProject(project, 'window')
  }

  private rootOf(project: string): string | null {
    const projects = this.wire.opts.config.projects
    const configured = Object.hasOwn(projects, project) ? projects[project] : undefined
    return configured === undefined ? null : expandHome(configured.root)
  }

  /** A machine linked here, by its name, or why that name is not one. */
  private machineNamed(name: string): string {
    if (this.deps.machines().remotes.some((one) => one.name === name)) return name
    throw new Error(`No machine here is called ${name}.`)
  }
}

/**
 * Queued work that can leave this machine: not parked, waiting on nothing,
 * and nothing waiting on it — the rule `startsOnFor` draws by, asked of the
 * last look.
 */
function movableQueued(
  one: { task: string; parked: boolean; start: { after: readonly { task: string }[] } },
  queued: readonly { start: { after: readonly { task: string }[] } }[],
): boolean {
  if (one.parked || one.start.after.length > 0) return false
  return !queued.some((other) => other.start.after.some((dep) => dep.task === one.task))
}

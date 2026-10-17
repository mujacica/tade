import { readFile } from 'node:fs/promises'
import {
  expandHome,
  LINES_LOOKED_BACK,
  machineLabel,
  printable,
  REMOTE_MOVE_REACH,
  remoteNamedBy,
  runProgram,
  type TaskFile,
} from '@tade/core'
import type { Answer, Remote, RemoteLink } from '@tade/remotes-core'
import {
  TAKE_CONTEXT_MOST,
  TAKE_WORDS_MOST,
  type Take,
  type TakeAnswer,
  TakeAnswerSchema,
} from '@tade/web'
import {
  contextDocument,
  readTaskFile,
  TASK_BRANCH_PREFIX,
  taskContextPath,
} from '@tade/workbench/tasks'
import { acknowledge } from '../flash.ts'
import type { Frame } from '../frame.ts'
import type { Machines } from '../machines.ts'
import type { MenuItem } from '../panels/menu/state.ts'
import { type Actions, saidLately, type Wiring, why } from './context.ts'
import {
  branchAt,
  carryOnSays,
  type HandedFrom,
  handedNote,
  handSays,
  pushedTo,
} from './hand-over.ts'

// Work moved to another machine of the person's (REMOTE-TADE.md §9.2): queued
// work started there instead of here — "Start on vps" on its card, or the
// orchestrator's `tade_task_move` — made over the owner channel this window
// holds there (`/api/take`, `@tade/web`'s `taken.ts`), and gone from this
// queue once that machine has it.
//
// **Git is the transport, and the conversation does not move.** What goes is
// what the task is made of: the person's words verbatim, what its agent will
// be told, its context file, its links and done rule, and when it may start.
// Not its harness, model or account, each of which is this machine's.
//
// **Only work that can leave is moved**, and each refusal is a sentence: not
// parked, which is a decision still to be made here; not a race's entrant or a
// replay, which are measurements of this machine; waiting on nothing, and
// nothing here waiting on it — no wait crosses machines, because there is no
// shared journal to resolve one against (§9.4). Work that begins on a review's
// branch goes with that branch, as origin has it.
//
// **Set aside while it moves.** It is parked here before that machine is
// asked, so this queue cannot start it in the moment between the other
// machine taking it and it being removed here; refused there, it is picked up
// again here as it was. Taken there, `task_moved` says where it went and the
// task is removed here, which keeps its document if it made one.
//
// **A running task is handed over** (`handOver`, and `hand-over.ts` for the
// git and the words): asked there first (`check`), so an agent is never
// stopped for a name already used there; its agent told to commit what is its
// own and push its branch; the window looking on its beat — never waiting —
// until origin has the work and the agent has finished a turn since it was
// told; then made there beginning on that branch (`start.from`), with the same
// words, its context file and a note of where things stood, and the agent here
// stopped and its task parked. Nothing of the conversation moves, and every
// sentence about it says so. Not done within `HAND_MS`, nothing changes and
// that is said.
//
// **One door for both ways of asking.** The card's button is the person's
// press; the orchestrator's tool is held to a line of theirs naming that
// machine (`REMOTE_MOVE_REACH`), checked here against the journal and never in
// the tool, because a stranger's issue saying "move this to the vps" is not
// the person saying it.

/** What moving work needs of the links. */
export interface MovesDeps {
  /** The link holding a machine, the remote as it opened it, and whether it is up. */
  reach(machine: string): { link: RemoteLink; remote: Remote; live: boolean } | null
  machines(): Machines
  /** Other machines' projects that are one project here's repository, as each last said. */
  sameAs(project: string): readonly { machine: string; project: string }[]
  /** Said in the strip: how a hand-over that went on in the background came out. */
  say(said: string): void
}

/** How long an agent has to commit and push once it is told it is being handed over. */
export const HAND_MS = 15 * 60_000

/** How often a hand-over looks at origin, at the most. */
export const HAND_LOOK_MS = 5_000

/** A running task being handed over: told, and looked at on the beat until its work is on origin. */
interface Handing extends HandedFrom {
  /** The project here, and its project there. */
  project: string
  there: string
  by: By
  /** When its agent was told, in this clock. */
  since: number
  lookedAt: number
  looking: boolean
  /** What is not done yet, as the last look said. */
  waiting: string
}

/** What the orchestrator's `tade_task_move` is answered with. */
export interface MoveTools {
  move(req: { task: string; machine: string; asked: string }): Promise<string>
}

type By = 'you' | 'orchestrator'

export class Moves {
  private readonly wire: Wiring
  private readonly deps: MovesDeps
  /** Work being moved now, so a second press is not a second move. */
  private readonly moving = new Set<string>()
  /** Running tasks being handed over, by task. */
  private readonly handing = new Map<string, Handing>()

  constructor(wire: Wiring, deps: MovesDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * Which machines each project here could start queued work on: linked now,
   * and holding the same repository as a project of its own. Every project is
   * one map lookup, so asking four times a second costs nothing worth keeping.
   */
  facts(): Partial<Frame> {
    const live = new Set(
      this.deps
        .machines()
        .remotes.filter((one) => this.deps.reach(one.name)?.live === true)
        .map((one) => one.name),
    )
    if (live.size === 0) return {}
    const startsOn: Record<string, readonly string[]> = {}
    for (const project of Object.keys(this.wire.opts.config.projects)) {
      const there = [...new Set(this.deps.sameAs(project).map((one) => one.machine))]
      const up = there.filter((machine) => live.has(machine))
      if (up.length > 0) startsOn[project] = up
    }
    return { startsOn }
  }

  actions(): Actions {
    return {
      // `<machine> <task>`: the card's "Start on <machine>".
      'queue-there:': async (rest) => {
        const [machine = '', task = ''] = rest.split(' ')
        try {
          const said = await this.startThere(task, machine, 'you')
          this.wire.put(acknowledge(this.wire.state, said, this.wire.now()))
        } catch (err) {
          this.wire.note(err)
        }
        this.wire.draw()
      },
    }
  }

  /** The orchestrator's: refused unless a line of the person's names that machine. */
  tools(): MoveTools {
    return {
      move: async (req) => {
        const machine = this.machineNamed(req.machine)
        if (req.asked.trim() === '') {
          throw new Error(
            'Work is moved to another machine only when they ask for it: pass what they said, word for word, in `asked`.',
          )
        }
        if (!remoteNamedBy(machine, await saidLately(this.wire, LINES_LOOKED_BACK))) {
          throw new Error(
            `Nothing they have said names ${machine}, so I will not: ${REMOTE_MOVE_REACH.because}.`,
          )
        }
        const running = this.wire.opts.client.runs().some((run) => run.task === req.task)
        return running
          ? this.handOver(req.task, machine, 'orchestrator')
          : this.startThere(req.task, machine, 'orchestrator')
      },
    }
  }

  /**
   * What a machine's menu along the top offers besides its projects: each
   * agent running here whose project is a repository there, handed over.
   */
  menuItems(machine: string): MenuItem[] {
    const tasks = this.wire.opts.client
      .runs()
      .map((run) => run.task as string)
      .filter((task) => this.deps.sameAs(projectOf(task)).some((one) => one.machine === machine))
    return tasks.map((task, at) => ({
      id: `hand:${task}`,
      label: `Hand ${task} to ${machine}`,
      ...(this.handing.has(task) ? { off: 'being handed over' } : {}),
      ...(at === 0 ? { divider: true } : {}),
    }))
  }

  /** A machine's menu, chosen: `hand:<task>`. False for anything that is not this one's. */
  chose(machine: string, id: string): boolean {
    if (!id.startsWith('hand:')) return false
    const task = id.slice('hand:'.length)
    void this.handOver(task, machine, 'you').then(
      (said) => {
        this.wire.put(acknowledge(this.wire.state, said, this.wire.now()))
        this.wire.draw()
      },
      (err: unknown) => {
        this.wire.note(err)
        this.wire.draw()
      },
    )
    return true
  }

  /** The window's beat: every hand-over due a look, looked at; nothing waits on it. */
  beat(): void {
    const now = this.wire.now()
    for (const handing of this.handing.values()) {
      if (handing.looking || now - handing.lookedAt < HAND_LOOK_MS) continue
      void this.look(handing, now)
    }
  }

  /**
   * A running task, handed to that machine: asked there first, its agent told
   * to commit and push, and looked at on the beat until it has (`look`).
   * Answers what was set going; throws why not.
   */
  async handOver(task: string, machine: string, by: By): Promise<string> {
    this.machineNamed(machine)
    if (this.handing.has(task) || this.moving.has(task)) {
      throw new Error(`${task} is already being moved`)
    }
    this.moving.add(task)
    try {
      return await this.tellToPush(task, machine, by)
    } finally {
      this.moving.delete(task)
    }
  }

  private async tellToPush(task: string, machine: string, by: By): Promise<string> {
    const client = this.wire.opts.client
    if (!client.runs().some((run) => run.task === task)) {
      throw new Error(
        `${task} has no agent running here to hand over: queued work is started there with Start on ${machine}, and a stopped one is opened again first.`,
      )
    }
    const file = await readTaskFile(this.wire.opts.home, task)
    if (file === null) throw new Error(`There is no task called ${task} here.`)
    if (file.race || file.replay) {
      throw new Error(
        `${task} is one entrant in a measurement made on this machine, so it stays here.`,
      )
    }
    const waiting = (this.wire.live?.queued ?? [])
      .filter((one) => one.start.after.some((dep) => dep.task === task))
      .map((one) => one.task)
    if (waiting.length > 0) {
      throw new Error(
        `${waiting.join(', ')} ${waiting.length === 1 ? 'waits' : 'wait'} on ${task} here, and no wait crosses machines: change ${waiting.length === 1 ? 'that wait' : 'those waits'} first, or let ${task} finish here.`,
      )
    }
    const project = projectOf(task)
    const there = this.projectThere(project, machine)
    const reach = this.deps.reach(machine)
    if (reach === null || !reach.live) {
      throw new Error(`${machine} is not linked now, so nothing was moved.`)
    }
    const [made] = await client.log.read({ task, types: ['task_created'] })
    const cwd = typeof made?.detail.worktree === 'string' ? made.detail.worktree : null
    if (cwd === null) throw new Error(`The journal does not say where ${task} works.`)
    const workspace = made?.detail.workspace === 'checkout' ? 'checkout' : 'worktree'
    const slug = task.slice(task.indexOf('/') + 1)
    const own = `${TASK_BRANCH_PREFIX}${slug}`
    const branch = workspace === 'worktree' ? ((await branchAt(cwd)) ?? own) : own
    const head = await runProgram('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })
    if (head.code !== 0) throw new Error(`${task}'s work has no commit to begin from.`)
    // Asked first, so an agent is never stopped for a name already used there.
    const asked = await this.ask(reach.link, machine, {
      from: machineLabel(),
      was: task,
      project: there,
      name: slug,
      intent: file.intent_spoken.slice(0, TAKE_WORDS_MOST),
      prompt: '',
      context: '',
      links: [],
      begins: { branch, head: head.stdout.trim() },
      check: true,
    })
    if (!asked.took) throw new Error(`${machine} would not take ${task}: ${printable(asked.said)}`)
    const from: HandedFrom = { task, machine, branch, cwd, workspace }
    await client.steerAgent(task, handSays(from))
    const now = this.wire.now()
    this.handing.set(task, {
      ...from,
      project,
      there,
      by,
      since: now,
      lookedAt: now,
      looking: false,
      waiting: 'it has not pushed yet',
    })
    return `Told ${task} to commit and push to ${branch} for ${machine}. Once its work is on origin and its turn is over, ${machine} begins on it as ${there}/${slug} and the agent here stops — its conversation does not move. If that has not happened within ${HAND_MS / 60_000} minutes, nothing changes and I say so.`
  }

  /** One look at a hand-over: given up, still waiting, or handed. */
  private async look(handing: Handing, now: number): Promise<void> {
    handing.looking = true
    handing.lookedAt = now
    const { task, machine } = handing
    try {
      if (now - handing.since > HAND_MS) {
        this.handing.delete(task)
        this.deps.say(
          `${task} was told to commit and push for ${machine} ${HAND_MS / 60_000} minutes ago, and ${handing.waiting}: nothing was started on ${machine}, and it goes on here.`,
        )
        return
      }
      const client = this.wire.opts.client
      const run = client.runs().find((one) => one.task === task)
      if (run !== undefined) {
        // Not part way through a turn, which may be part way through the push;
        // and not before it has finished one since it was told.
        if (client.turnOf(run.run) === 'running') {
          handing.waiting = 'it is still in its turn'
          return
        }
        const turned = (await client.log.read({ task, types: ['turn_done'] })).some(
          (line) => Date.parse(line.ts) >= handing.since,
        )
        if (!turned) {
          handing.waiting = 'it has not finished a turn since it was told'
          return
        }
      }
      const pushed = await pushedTo(handing)
      if ('not' in pushed) {
        handing.waiting = pushed.not
        return
      }
      const reach = this.deps.reach(machine)
      if (reach === null || !reach.live) {
        handing.waiting = `its work is on origin, and ${machine} is not linked now`
        return
      }
      this.handing.delete(task)
      this.deps.say(await this.handed(handing, reach.link, pushed.head))
    } catch (err) {
      this.handing.delete(task)
      this.deps.say(`${task} was not handed to ${machine}: ${why(err)}. Its agent goes on here.`)
    } finally {
      handing.looking = false
    }
  }

  /** Its work is on origin: made there, and the agent here stopped. What happened, in a sentence. */
  private async handed(handing: Handing, link: RemoteLink, head: string): Promise<string> {
    const { task, machine, branch } = handing
    const client = this.wire.opts.client
    const file = await readTaskFile(this.wire.opts.home, task)
    if (file === null) throw new Error('its task file is gone')
    const context = await this.contextOf(task, file)
    const here = machineLabel()
    const note = handedNote({ machine: here, task, branch, head, told: file.start?.prompt ?? '' })
    const take: Take = {
      from: here,
      was: task,
      project: handing.there,
      name: task.slice(task.indexOf('/') + 1),
      intent: file.intent_spoken,
      prompt: carryOnSays({ machine: here, branch }),
      context: [context.context.trim(), note].filter((part) => part !== '').join('\n\n'),
      links: context.links,
      ...(file.done ? { done: file.done } : {}),
      begins: { branch, head },
      check: false,
    }
    if (take.context.length > TAKE_CONTEXT_MOST || take.intent.length > TAKE_WORDS_MOST) {
      throw new Error(`its context is longer than one request to ${machine} carries`)
    }
    const answer = await this.ask(link, machine, take)
    if (!answer.took) {
      return `${machine} did not take ${task}: ${printable(answer.said)}. Its work is on origin at ${branch}, and its agent goes on here.`
    }
    const as = printable(answer.task)
    const after: string[] = []
    try {
      await client.stopAgent(task)
    } catch (err) {
      after.push(`its agent here could not be stopped (${why(err)}): stop it`)
    }
    try {
      await client.parkTask(task, true, { by: handing.by })
    } catch (err) {
      after.push(`it could not be parked here (${why(err)})`)
    }
    await client.log.append({
      type: 'task_moved',
      task,
      detail: { to: machine, as, how: 'running', branch, head, by: handing.by },
    })
    void this.wire.live?.refresh()
    const pushes =
      answer.pushes === false
        ? ` ${machine} cannot push to ${branch} with its own credentials yet, so its agent's work stays there until it can.`
        : ''
    const went = `${task} went to ${machine} as ${as}, on ${branch} at ${head.slice(0, 12)}: its agent here is stopped and parked, and its conversation stays here.`
    return `${went}${pushes}${after.length > 0 ? ` But ${after.join(', and ')}.` : ''}`
  }

  /**
   * Queued work, started on that machine instead of here: asked there, and
   * removed here once it is taken. Answers what happened; throws why not.
   */
  async startThere(task: string, machine: string, by: By): Promise<string> {
    this.machineNamed(machine)
    if (this.moving.has(task)) throw new Error(`${task} is already being moved`)
    this.moving.add(task)
    try {
      return await this.moveQueued(task, machine, by)
    } finally {
      this.moving.delete(task)
    }
  }

  private async moveQueued(task: string, machine: string, by: By): Promise<string> {
    const home = this.wire.opts.home
    // Asked of the task file and the journal, never of the last look, which
    // may be a moment behind work planned just now.
    const file = await readTaskFile(home, task)
    const client = this.wire.opts.client
    const started =
      client.runs().some((run) => run.task === task) ||
      (await client.log.read({ task, types: ['queue_started'] })).length > 0
    if (file === null || !file.start || started) {
      throw new Error(`There is no queued work called ${task} here.`)
    }
    if (file.parked) {
      throw new Error(
        `${task} is parked here, which is a decision still to be made on this machine: pick it up, or decide about it, before it goes anywhere.`,
      )
    }
    if (file.race || file.replay) {
      throw new Error(
        `${task} is one entrant in a measurement made on this machine, so it stays here.`,
      )
    }
    if (file.start.after.length > 0) {
      const on = file.start.after.map((one) => one.task).join(', ')
      throw new Error(
        `${task} waits on ${on} here, and no wait crosses machines: take the wait off (Wait on… none) to start it on ${machine}, or let it start here.`,
      )
    }
    const waiting = (this.wire.live?.queued ?? [])
      .filter((one) => one.start.after.some((dep) => dep.task === task))
      .map((one) => one.task)
    if (waiting.length > 0) {
      throw new Error(
        `${waiting.join(', ')} ${waiting.length === 1 ? 'waits' : 'wait'} on ${task} here, and no wait crosses machines: move ${waiting.length === 1 ? 'it' : 'them'} first, or let ${task} start here.`,
      )
    }
    const project = projectOf(task)
    const there = this.projectThere(project, machine)
    const reach = this.deps.reach(machine)
    if (reach === null || !reach.live)
      throw new Error(`${machine} is not linked now, so nothing was moved.`)
    const take: Take = {
      from: machineLabel(),
      was: task,
      project: there,
      name: task.slice(task.indexOf('/') + 1),
      intent: file.intent_spoken,
      prompt: file.start.prompt,
      ...(await this.contextOf(task, file)),
      ...(file.done ? { done: file.done } : {}),
      ...(file.start.at ? { at: file.start.at } : {}),
      ...(file.start.from ? { begins: await this.beginsOf(task, project, file.start.from) } : {}),
      check: false,
    }
    if (take.intent.length > TAKE_WORDS_MOST || take.prompt.length > TAKE_WORDS_MOST) {
      throw new Error(`${task}'s words are longer than one request to ${machine} carries.`)
    }
    // Set aside while it moves, so this queue cannot start it meanwhile —
    // against what was read, so a park somebody made since is not undone.
    try {
      await this.wire.opts.client.parkTask(task, true, { by, was: false })
    } catch (err) {
      throw new Error(`${task} could not be set aside to move: ${why(err)}`)
    }
    let answer: TakeAnswer
    try {
      answer = await this.ask(reach.link, machine, take)
    } catch (err) {
      throw new Error(`${why(err)}${await this.pickUp(task, by)}`)
    }
    if (!answer.took) {
      throw new Error(
        `${machine} did not take ${task}: ${printable(answer.said)}${await this.pickUp(task, by)}`,
      )
    }
    const as = printable(answer.task)
    await this.wire.opts.client.log.append({
      type: 'task_moved',
      task,
      detail: { to: machine, as, how: 'queued', by },
    })
    const removed = await this.removeHere(task, project)
    void this.wire.live?.refresh()
    const went = `${task} went to ${machine} as ${as}: ${printable(answer.said)}`
    return removed === null
      ? `${went} It is no longer queued here.`
      : `${went} It could not be removed here (${removed}), so it stays parked here: remove it.`
  }

  /** Over the link already up, as this machine's owner there. Throws what to say where it was not taken. */
  private async ask(link: RemoteLink, machine: string, take: Take): Promise<TakeAnswer> {
    let answer: Answer
    try {
      answer = await link.request(machine, '/api/take', take)
    } catch (err) {
      throw new Error(
        `${machine}: ${printable(why(err))} — it may not have been taken there; look at its queue before moving it again`,
      )
    }
    if (answer.status === 404) {
      throw new Error(
        `${machine}'s Tade cannot take work from another machine: it is older than this one. Update it there (tade update), then try again.`,
      )
    }
    const read = TakeAnswerSchema.safeParse(answer.body)
    if (answer.status !== 200 || !read.success) {
      const said = (answer.body as { said?: unknown } | null)?.said
      throw new Error(
        `${machine} refused it: ${typeof said === 'string' ? printable(said) : `it answered ${answer.status}`}`,
      )
    }
    return read.data
  }

  /** The project there that is this one's repository: exactly one, or why not. */
  private projectThere(project: string, machine: string): string {
    const there = this.deps.sameAs(project).filter((one) => one.machine === machine)
    if (there.length === 1 && there[0]) return there[0].project
    if (there.length === 0) {
      throw new Error(
        `${machine} has no project that is ${project}'s repository — or has not said yet which of its projects are which: open it there first, or move the whole project.`,
      )
    }
    throw new Error(
      `${machine} has ${there.map((one) => one.project).join(' and ')}, each ${project}'s repository, and which one is not mine to guess: move it there by talking to ${machine}'s orchestrator.`,
    )
  }

  /** Its context file's text, with the links it ends in handed over as links. */
  private async contextOf(
    task: string,
    file: TaskFile,
  ): Promise<{ context: string; links: { title: string; url: string }[] }> {
    const links = file.links.map(({ title, url }) => ({ title, url }))
    let text = ''
    try {
      text = await readFile(taskContextPath(this.wire.opts.home, task), 'utf8')
    } catch (err) {
      // No context file is a task made with nothing to say beyond its words;
      // one that is there and will not read is not that.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`${task}'s context file could not be read: ${why(err)}`)
      }
    }
    // What `contextDocument` wrote is the context and then its links: handed
    // over as two, so the other machine writes the same file rather than the
    // links twice. A file somebody edited since is handed over whole.
    const block = contextDocument('', links)
    const own = block !== '' && text.endsWith(block) ? text.slice(0, -block.length).trim() : text
    if (own.length > TAKE_CONTEXT_MOST) {
      throw new Error(
        `${task}'s context file is ${Math.round(own.length / 1000)} kB, more than one request to another machine carries (${TAKE_CONTEXT_MOST / 1000} kB): shorten it first.`,
      )
    }
    return { context: own, links: block !== '' && own !== text ? links : [] }
  }

  /** Work that begins on a review's branch begins there on the same branch, as origin has it. */
  private async beginsOf(
    task: string,
    project: string,
    from: string,
  ): Promise<NonNullable<Take['begins']>> {
    const branch = from.startsWith('origin/') ? from.slice('origin/'.length) : null
    const root = this.rootOf(project)
    if (branch === null || root === null) {
      throw new Error(
        `${task} begins on ${from}, which is not a branch on origin, so another machine could not begin there.`,
      )
    }
    const head = await runProgram(
      'git',
      ['-C', root, 'rev-parse', '--verify', `${from}^{commit}`],
      {
        timeoutMs: 10_000,
      },
    )
    if (head.code !== 0) throw new Error(`${task} begins on ${from}, which is not here to read.`)
    return { branch, head: head.stdout.trim() }
  }

  /** Picked up again here, as it was before it was set aside to move: what to add where it could not be. */
  private async pickUp(task: string, by: By): Promise<string> {
    try {
      await this.wire.opts.client.parkTask(task, false, { by, was: true })
      return ''
    } catch (err) {
      return `. It is still parked here (${why(err)}): pick it up to start it here`
    }
  }

  /**
   * Removed here once the other machine has it: null, or why it could not be.
   * Where it is, as the journal said when it was made — it has not started, so
   * nothing has moved it since.
   */
  private async removeHere(task: string, project: string): Promise<string | null> {
    const client = this.wire.opts.client
    const [made] = await client.log.read({ task, types: ['task_created'] })
    const worktree = typeof made?.detail.worktree === 'string' ? made.detail.worktree : null
    const branch = typeof made?.detail.branch === 'string' ? made.detail.branch : ''
    const root = this.rootOf(project)
    if (worktree === null || root === null) return 'the journal does not say where it is'
    try {
      const result = await client.removeTask({ root, worktree, branch, task, force: true })
      return result.removed ? null : result.reason
    } catch (err) {
      return why(err)
    }
  }

  private rootOf(project: string): string | null {
    const projects = this.wire.opts.config.projects
    const configured = Object.hasOwn(projects, project) ? projects[project] : undefined
    return configured === undefined ? null : expandHome(configured.root)
  }

  /** A machine linked here, by its name, or why that name is not one. */
  private machineNamed(name: string): string {
    const machines = this.deps.machines().remotes
    if (machines.some((one) => one.name === name)) return name
    const names = machines.map((one) => one.name).join(', ')
    throw new Error(
      `No machine here is called ${name}: ${names === '' ? 'none is linked (tade remote add)' : `the ones linked are ${names}`}.`,
    )
  }
}

/** The project half of a task's id. */
function projectOf(task: string): string {
  return task.slice(0, Math.max(0, task.indexOf('/')))
}

import { randomUUID } from 'node:crypto'
import {
  LINES_LOOKED_BACK,
  machineLabel,
  printable,
  REMOTE_MOVE_REACH,
  remoteNamedBy,
  runProgram,
} from '@tade/core'
import type { Remote, RemoteLink } from '@tade/remotes-core'
import { TAKE_CONTEXT_MOST, TAKE_WORDS_MOST, type Take, type TakeAnswer } from '@tade/web'
import { readTaskFile, TASK_BRANCH_PREFIX } from '@tade/workbench/tasks'
import { acknowledge } from '../flash.ts'
import type { Frame } from '../frame.ts'
import type { Machines } from '../machines.ts'
import type { MenuItem } from '../panels/menu/state.ts'
import { type Actions, saidLately, type Wiring, why } from './context.ts'
import {
  branchAt,
  carryOnSays,
  type HandedFrom,
  type HandOverAsked,
  handAgainSays,
  handedNote,
  handOversOpen,
  handSays,
  projectOf,
  pushedTo,
} from './hand-over.ts'
import { ProjectMoves } from './project-moves.ts'
import { askHanding, askThere, beginsOf, contextOf, removeHere } from './take-parts.ts'

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
// **A hand-over in flight is written down**, because it is asked just before
// a lid closes: `task_handing` when its agent is told — who to, its project
// there, which branch, who asked — and again with `ended` when it is let go
// of without moving, where `task_moved` ends the rest. The next window picks
// up what is still open (`handOversOpen`, once, on its first beat), says so,
// and looks on from there; the time it has is counted from that moment, and a
// sleep with the window open is not counted either (`beat`'s `slept`),
// because nothing could look and the agent could not work. An agent whose
// lanes died with the window is opened again having been told nothing
// (`reopenAgent`), part way through what it was asked: one with no turn
// ended since and opened since it was told is told again once, in the same
// words (`retell`) — finishing a request, never starting one; an agent that
// went on running is never opened again, so never told twice. Each hand-over
// has an id (`task_handing`'s `id`, the take's `handOver`), so a window asking
// again after one that closed before it heard the answer is told `already`
// and finishes it; a no from a machine too old to read the id, to a hand-over
// an earlier window may have asked, is said as not known, never as handed.
//
// **The Mac finishes it; the machine there never takes it unasked.** Whether
// the work is all on origin is only answerable here — its worktree's
// uncommitted changes, its commits in a shared checkout, whether its turn is
// over — and only this machine can stop the agent here. A remote that began on
// a branch it saw pushed could not know the push was the last, and the agent
// here would wake and go on beside it on the same branch. With the lid closed
// that agent is asleep too, so nothing waits that the remote could have done.
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
  /** Said on the Remotes page: what a press in moving a project did, or why it did not. */
  told(saved: string | null, error: string | null): void
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
  /** When its agent was told: what a turn it has finished since is compared with. */
  since: number
  /** When this window began counting `HAND_MS`, moved on by any sleep since. */
  from: number
  lookedAt: number
  looking: boolean
  /** What is not done yet, as the last look said. */
  waiting: string
  /** What the machine there knows it by once taken; null where an older window wrote none. */
  id: string | null
  /** Picked up from the journal, so an earlier window may have asked there already. */
  resumed: boolean
  /** Told again since it was opened part way through (`retell`). */
  retold: boolean
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
  /** The hand-overs an earlier window left open, picked up from the journal once. */
  private resuming: Promise<void> | null = null
  /** A whole project moved there, a press at a time (`project-moves.ts`). */
  readonly projects: ProjectMoves

  constructor(wire: Wiring, deps: MovesDeps) {
    this.wire = wire
    this.deps = deps
    this.projects = new ProjectMoves(wire, deps, this)
  }

  /** Whether a running task is being handed over now. */
  handingNow(task: string): boolean {
    return this.handing.has(task)
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
    this.hand(id.slice('hand:'.length), machine)
    return true
  }

  /**
   * What an agent's own menu offers, where a person looks before closing the
   * lid: handed to each machine that holds its project's repository, off
   * with why where it cannot go now (`hand`).
   */
  handItems(task: string): MenuItem[] {
    const running = this.wire.opts.client.runs().some((run) => run.task === task)
    const there = [...new Set(this.deps.sameAs(projectOf(task)).map((one) => one.machine))]
    return there.map((machine) => {
      const off = this.handing.has(task)
        ? 'being handed over'
        : !running
          ? 'not running'
          : this.deps.reach(machine)?.live !== true
            ? 'not linked now'
            : null
      return { id: `hand:${machine}`, label: `Hand to ${machine}`, ...(off ? { off } : {}) }
    })
  }

  /** A running task handed to a machine, as a press: what was set going flashed, or why not said. */
  hand(task: string, machine: string): void {
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
  }

  /**
   * The window's beat: every hand-over due a look, looked at; nothing waits on
   * it. `slept` is how long the machine was away, on the beat that noticed.
   */
  beat(slept: number | null = null): void {
    void this.resume()
    const now = this.wire.now()
    for (const handing of this.handing.values()) {
      // Away is not waiting: nothing looked, and its agent did no work.
      if (slept !== null) handing.from += slept
      if (handing.looking || now - handing.lookedAt < HAND_LOOK_MS) continue
      void this.look(handing, now)
    }
  }

  /** The hand-overs an earlier window asked and did not finish, picked up once. Never rejects. */
  private resume(): Promise<void> {
    if (this.resuming === null) this.resuming = this.pickUpAsked()
    return this.resuming
  }

  private async pickUpAsked(): Promise<void> {
    let asked: HandOverAsked[]
    try {
      const types = ['task_handing', 'task_moved', 'task_removed'] as const
      asked = handOversOpen(await this.wire.opts.client.log.read({ types }))
    } catch (err) {
      this.deps.say(
        `What was being handed to another machine could not be read from the journal (${why(err)}), so nothing an earlier window began is finished here.`,
      )
      return
    }
    for (const one of asked) {
      const { task, machine } = one
      // Asked again in this window since: that one stands.
      if (this.handing.has(task)) continue
      try {
        this.machineNamed(machine)
        const now = this.wire.now()
        this.handing.set(task, {
          task,
          machine,
          branch: one.branch,
          ...(await this.whereItWorks(task)),
          project: projectOf(task),
          there: one.there,
          by: one.by,
          since: one.at,
          from: now,
          lookedAt: now - HAND_LOOK_MS,
          looking: false,
          waiting: 'it has not pushed yet',
          id: one.id,
          resumed: true,
          retold: false,
        })
        this.deps.say(
          `${task} was being handed to ${machine} when Tade last closed, so I am looking again: once its work is on origin, ${machine} begins on it and the agent here stops. If that has not happened within ${HAND_MS / 60_000} minutes, nothing changes and I say so.`,
        )
      } catch (err) {
        await this.letGo(
          task,
          machine,
          `${task} was being handed to ${machine} when Tade last closed, and it cannot go on: ${why(err)} Its agent goes on here.`,
        )
      }
    }
  }

  /** A hand-over let go of without moving: forgotten, written down so no window picks it up, and said. */
  private async letGo(task: string, machine: string, said: string): Promise<void> {
    this.handing.delete(task)
    let unwritten = ''
    try {
      await this.wire.opts.client.log.append({
        type: 'task_handing',
        task,
        detail: { to: machine, ended: said },
      })
    } catch (err) {
      unwritten = ` That could not be written down (${why(err)}), so the next window looks at it again.`
    }
    this.deps.say(`${said}${unwritten}`)
  }

  /** Where a task's agent works, as the journal said when it was made. Throws where it does not say. */
  private async whereItWorks(task: string): Promise<Pick<HandedFrom, 'cwd' | 'workspace'>> {
    const [made] = await this.wire.opts.client.log.read({ task, types: ['task_created'] })
    const cwd = typeof made?.detail.worktree === 'string' ? made.detail.worktree : null
    if (cwd === null) throw new Error(`The journal does not say where ${task} works.`)
    return { cwd, workspace: made?.detail.workspace === 'checkout' ? 'checkout' : 'worktree' }
  }

  /**
   * A running task, handed to that machine: asked there first, its agent told
   * to commit and push, and looked at on the beat until it has (`look`).
   * Answers what was set going; throws why not.
   */
  async handOver(task: string, machine: string, by: By): Promise<string> {
    this.machineNamed(machine)
    // What an earlier window left open first, so one is never asked twice.
    await this.resume()
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
    const { cwd, workspace } = await this.whereItWorks(task)
    const slug = task.slice(task.indexOf('/') + 1)
    const own = `${TASK_BRANCH_PREFIX}${slug}`
    const branch = workspace === 'worktree' ? ((await branchAt(cwd)) ?? own) : own
    const head = await runProgram('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })
    if (head.code !== 0) throw new Error(`${task}'s work has no commit to begin from.`)
    // Asked first, so an agent is never stopped for a name already used there.
    const asked = await askThere(reach, machine, {
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
    const id = randomUUID()
    // Written down, so Tade closing before the push lands is not the end of
    // it — and before anything can look, so its end is always written after it.
    let kept =
      ' Closing the lid or Tade before then is fine: it is written down, and finished once Tade is open and awake here again.'
    try {
      await client.log.append({
        type: 'task_handing',
        task,
        detail: { to: machine, there, branch, by, id },
      })
    } catch (err) {
      kept = ` It could not be written down (${why(err)}), so if Tade closes before then, nothing finishes it.`
    }
    this.handing.set(task, {
      ...from,
      project,
      there,
      by,
      since: now,
      from: now,
      lookedAt: now,
      looking: false,
      waiting: 'it has not pushed yet',
      id,
      resumed: false,
      retold: false,
    })
    return `Told ${task} to commit and push to ${branch} for ${machine}. Once its work is on origin and its turn is over, ${machine} begins on it as ${there}/${slug} and the agent here stops — its conversation does not move. If that has not happened within ${HAND_MS / 60_000} minutes, nothing changes and I say so.${kept}`
  }

  /** One look at a hand-over: given up, still waiting, or handed. */
  private async look(handing: Handing, now: number): Promise<void> {
    handing.looking = true
    handing.lookedAt = now
    const { task, machine } = handing
    try {
      if (now - handing.from > HAND_MS) {
        await this.letGo(
          task,
          machine,
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
        const since = (await client.log.read({ task, types: ['turn_done', 'lane_opened'] })).filter(
          (line) => Date.parse(line.ts) >= handing.since,
        )
        if (!since.some((line) => line.type === 'turn_done')) {
          handing.waiting = 'it has not finished a turn since it was told'
          // Opened again since, and idle — said so by pi, so it is up to be told.
          const opened = since.some(
            (line) => line.type === 'lane_opened' && line.lane === `${task}/agent`,
          )
          if (opened && client.turnOf(run.run) === 'idle') await this.retell(handing)
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
      const handed = await this.handed(handing, reach, pushed.head)
      if (handed.went) this.deps.say(handed.said)
      else await this.letGo(task, machine, handed.said)
    } catch (err) {
      await this.letGo(
        task,
        machine,
        `${task} was not handed to ${machine}: ${why(err)}. Its agent goes on here.`,
      )
    } finally {
      handing.looking = false
    }
  }

  /**
   * An agent opened again part way through being handed over, told nothing by
   * the opening: told once more what it was asked, in its own lane and here.
   */
  private async retell(handing: Handing): Promise<void> {
    if (handing.retold) return
    // Before it is sent: one that throws is not sent again on the next look.
    handing.retold = true
    const { task, machine } = handing
    try {
      await this.wire.opts.client.steerAgent(task, handAgainSays(handing))
      this.deps.say(
        `${task} was opened again part way through being handed to ${machine}, and had not finished what it was asked, so I told it again to commit and push.`,
      )
    } catch (err) {
      this.deps.say(
        `${task} was opened again part way through being handed to ${machine}, and could not be told again to commit and push (${why(err)}): tell it, or it is let go of when its time is up.`,
      )
    }
  }

  /** Its work is on origin: made there, and the agent here stopped. Whether it went, and what happened in a sentence. */
  private async handed(
    handing: Handing,
    reach: { link: RemoteLink; remote: Remote },
    head: string,
  ): Promise<{ went: boolean; said: string }> {
    const { task, machine, branch } = handing
    const client = this.wire.opts.client
    const file = await readTaskFile(this.wire.opts.home, task)
    if (file === null) throw new Error('its task file is gone')
    const context = await contextOf(this.wire, task, file)
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
      ...(handing.id === null ? {} : { handOver: handing.id }),
    }
    if (take.context.length > TAKE_CONTEXT_MOST || take.intent.length > TAKE_WORDS_MOST) {
      throw new Error(`its context is longer than one request to ${machine} carries`)
    }
    const { answer, readId } = await askHanding(reach, machine, take)
    if (!answer.took) {
      const left = `Its work is on origin at ${branch}, and its agent goes on here.`
      // Asked by an earlier window too, of a machine that could not say which
      // hand-over it was: the name it refuses may be the one it was given then.
      return {
        went: false,
        said:
          handing.resumed && !readId
            ? `Whether ${machine} has ${task} cannot be told: it said ${printable(answer.said)}, which may be the name it was given when a window here asked before Tade closed — look at its queue. ${left}`
            : `${machine} did not take ${task}: ${printable(answer.said)}. ${left}`,
      }
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
    const gone = answer.already ? `had gone to ${machine} already` : `went to ${machine}`
    const went = `${task} ${gone} as ${as}, on ${branch} at ${head.slice(0, 12)}: its agent here is stopped and parked, and its conversation stays here.`
    return {
      went: true,
      said: `${went}${pushes}${after.length > 0 ? ` But ${after.join(', and ')}.` : ''}`,
    }
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
      ...(await contextOf(this.wire, task, file)),
      ...(file.done ? { done: file.done } : {}),
      ...(file.start.at ? { at: file.start.at } : {}),
      ...(file.start.from
        ? { begins: await beginsOf(this.wire, task, project, file.start.from) }
        : {}),
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
      answer = await askThere(reach, machine, take)
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
    const removed = await removeHere(this.wire, task, project)
    void this.wire.live?.refresh()
    const went = `${task} went to ${machine} as ${as}: ${printable(answer.said)}`
    return removed === null
      ? `${went} It is no longer queued here.`
      : `${went} It could not be removed here (${removed}), so it stays parked here: remove it.`
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

  /** Picked up again here, as it was before it was set aside to move: what to add where it could not be. */
  private async pickUp(task: string, by: By): Promise<string> {
    try {
      await this.wire.opts.client.parkTask(task, false, { by, was: true })
      return ''
    } catch (err) {
      return `. It is still parked here (${why(err)}): pick it up to start it here`
    }
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

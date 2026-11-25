import { randomBytes } from 'node:crypto'
import { printable, TaskId } from '@tade/core'
import type { Answer, Held, Remote, RemoteLink } from '@tade/remotes-core'
import { attachedFrom, attachedTo } from '@tade/workbench/attached'
import type { Frame } from '../frame.ts'
import {
  elsewhereOf,
  type Machine,
  type Machines,
  type Place,
  placeIn,
  type RemoteAgent,
  type RemoteProject,
  type RemoteScreen,
  screenOf,
} from '../machines.ts'
import { laneThere, leaveLine, ORCHESTRATOR_TAB, type ScheduleView } from '../model.ts'
import type { MenuItem } from '../panels/menu/state.ts'
import { confirmRemovePanel, promptPanel } from '../panels/small/state.ts'
import { refOf, scheduleThere, there, thereItems, thereScheduleItems } from '../there.ts'
import {
  type Actions,
  flash,
  notify,
  type Prompts,
  type Subject,
  type Wiring,
  why,
} from './context.ts'
import { RemoteTerminals } from './remote-terminals.ts'

// An agent on another machine, opened from this window:
// looked at, typed into, told something, and stopped, parked, answered
// or started — every one of them that machine's own act, asked over the link
// this machine holds as its owner.
//
// **Looking is reading.** Its screen is the away view's agent read
// (`/api/agent/<project>/<task>`), asked again every `LOOK_MS` while you look
// and never otherwise — asking is what keeps that machine reading the lane —
// over the link already up (`request`), so a remote that is down is asked
// nothing and its last screen stays with its age. Every row is text by the
// time it is drawn (`screenOf`).
//
// **Typing is a terminal here** (enter): that machine's own line for the
// agent's lane (`/api/attach`, its driver's), run there over `ssh -t` or mosh
// in a lane of this machine's (`workbench/src/attached.ts`), and drawn in the
// pane in place of the screen read (`Place.lane`, `laneThere`) — sized to it,
// read on every look and typed into there, as an agent here is its own lane,
// with the window's whole pacing, scrolling and selection. Pressing an agent
// there that already has one is looking at it live, and nothing is read over
// the link while it is. The SSH key is the authority, so nothing types into a
// lane from away: this never goes through the away view's verbs at all.
// Opening one, running it again once its connection is back and moving it off
// a way that does not get through are `remote-terminals.ts`'s.
//
// **Everything else is a verb** (`/api/act/<verb>`), with the target and
// what this window last saw of it (`was`, `rev`), so a press against a screen
// that is out of date is that machine saying so rather than doing the wrong
// thing. Only what that machine says may be asked of it now (`can`) is
// offered, and what it answers is said as text.

/** How often the screen of an agent there is asked for again while you look at it. */
export const LOOK_MS = 2_000

/** What looking at, typing into and acting on an agent there needs of the links. */
export interface RemoteAgentDeps {
  /** The link holding a machine, and the remote as it opened it, or null where none does. */
  reach(machine: string): { link: RemoteLink; remote: Remote; live: boolean } | null
  /** The machines as folded now. */
  machines(): Machines
  /** How far this clock is ahead of a machine's, as its projection last said. */
  skew(machine: string): number
  /**
   * One of that machine's own tool calls, through its own gate with a key of
   * its own (`MachineActs.pressed`): what no verb of its away view reaches —
   * its schedules, and what queued work is told.
   */
  pressed?(req: {
    machine: string
    key: string
    method: string
    params: Record<string, unknown>
  }): Promise<string>
}

/**
 * What every subject that answers a press on a row hands a row of another
 * machine's to (`there.ts`'s ids): the agent's, the queue's and the
 * schedules' own handlers ask `refOf` and come here, so a row there answers
 * every control a row here has — or says, in words, why one cannot cross.
 */
export interface ThereDoor {
  /** What its menu is called. */
  title(id: string): string
  /** Its menu: an agent's or queued work's, as here (`thereItems`). */
  taskItems(id: string): readonly MenuItem[]
  /** An item of that menu, or a control on its row (`queue-start`, `remove`…), carried there. */
  fromTaskMenu(id: string, item: string): Promise<void>
  /** Pressed: looked at, as an agent here is focused by a press. */
  look(id: string): void
  /** Removed there, once asked: an error to put back in the panel, or null. */
  remove(id: string): Promise<string | null>
  /** Renamed there (`rename-agent`'s prompt). */
  rename(id: string, title: string): Promise<string>
  /** Told what to do when it starts, there (`queue-retell`'s prompt). */
  retell(id: string, prompt: string): Promise<string>
  /** A schedule there, as this machine's views are, or null where it has gone. */
  schedule(id: string): ScheduleView | null
  /** Its menu. */
  scheduleItems(id: string): readonly MenuItem[]
  /** A change to it — open, run, pause, resume, rename, remove — carried there. */
  onSchedule(id: string, change: string): Promise<void>
  /** Renamed there (`rename-schedule`'s prompt). */
  renameSchedule(id: string, name: string): Promise<string>
}

/** The agent being looked at, with the machine it is on, as the frame has them now. */
interface Looked {
  place: Place & { agent: string }
  machine: Machine
  agent: RemoteAgent | null
}

export class RemoteAgents implements Subject, ThereDoor {
  private readonly wire: Wiring
  private readonly deps: RemoteAgentDeps
  /** The screen last read, and which machine and task it was read of. */
  private screen: { of: string; screen: RemoteScreen } | null = null
  /** The look on its way, by machine and task, so a late answer about another is dropped. */
  private asking: string | null = null
  private askedAt = 0
  /** The terminals here that are agents there. */
  private readonly terminals: RemoteTerminals

  constructor(wire: Wiring, deps: RemoteAgentDeps) {
    this.wire = wire
    this.deps = deps
    this.terminals = new RemoteTerminals(wire, { reach: (machine) => deps.reach(machine) })
  }

  facts(): Partial<Frame> {
    const looked = this.looked()
    if (looked === null || this.screen?.of !== keyOf(looked.place)) return {}
    return { remoteScreen: this.screen.screen }
  }

  /** A shell in one of that machine's projects, in a lane here (`RemoteTerminals.shell`). */
  shell(machine: string, project: string): Promise<void> {
    return this.terminals.shell(machine, project)
  }

  /** What a link holds moved: a terminal there that lost its connection may be run again. */
  moved(name: string, held: Held): void {
    this.terminals.moved(name, held)
  }

  /** The window's beat: the screen asked for again, while somebody looks at one. */
  beat(): void {
    this.terminals.beat()
    const looked = this.looked()
    if (looked === null || this.asking !== null) return
    // Its lane is in the pane, live: there is nothing to read over the link.
    if (laneThere(this.wire.state) !== null) return
    if (this.wire.now() - this.askedAt < LOOK_MS && this.screen?.of === keyOf(looked.place)) return
    void this.read(looked)
  }

  actions(): Actions {
    return {
      // A row of an agent there, pressed: looked at, as a row here is focused.
      'remote-look:': (task) => this.look(task),
      'remote-attach': () => this.attach(),
      'remote-steer': () => {
        const looked = this.looked()
        if (looked?.agent == null) return
        const name = looked.agent.title ?? looked.agent.name
        this.wire.put({
          ...this.wire.state,
          panel: {
            ...promptPanel('remote-steer', `Tell ${name} on ${looked.machine.name}`, 'Say'),
            target: `${looked.machine.name}\0${looked.agent.id}`,
          },
        })
        this.wire.draw()
      },
      'remote-stop': () => this.act('stop', { confirm: true }),
      'remote-park': () => this.act('park', { parked: true }),
      'remote-unpark': () => this.act('park', { parked: false }),
      'remote-start': () => this.act('queue', { change: 'start' }),
      'remote-reopen': () => this.act('reopen', {}),
      'remote-allow': () => this.answer(true),
      'remote-deny': () => this.answer(false),
    }
  }

  prompts(): Prompts {
    return {
      'model-there': async (panel, text) => {
        await this.named(panel.target ?? '', 'model', { model: text })
      },
      'account-there': async (panel, text) => {
        await this.named(panel.target ?? '', 'account', { account: text })
      },
      'remote-steer': async (panel, text) => {
        const [machine = '', task = ''] = (panel.target ?? '').split('\0')
        const looked = this.looked()
        // The agent the panel was opened on, and nobody else: a window that moved
        // on while somebody typed does not send their words somewhere new.
        if (looked === null || looked.machine.name !== machine || looked.agent?.id !== task) {
          throw new Error(`${task} on ${machine} is not the agent in front any more`)
        }
        if (text === '') throw new Error('say something')
        const said = await this.carry(looked, 'steer', { said: text })
        this.wire.put({ ...this.wire.state, panel: null })
        flash(this.wire, said)
        this.wire.draw()
      },
    }
  }

  // ── The door every row of another machine's comes through ──────────────

  title(id: string): string {
    const found = this.found(id)
    return found?.agent ? (found.agent.title ?? found.agent.name) : refOf(id).id
  }

  taskItems(id: string): readonly MenuItem[] {
    const found = this.found(id)
    if (found?.agent == null || found.project === null) return []
    return thereItems(found.agent, found.project, found.machine)
  }

  look(id: string): void {
    const place = elsewhereOf(this.wire.state)
    const task = refOf(id).id
    if (place === null || task === '') return
    // Pressed again, it is let go of: the project there as it was, which is the
    // only other thing that pane draws.
    const agent = place.agent === task ? undefined : task
    // A terminal here already that is it: its lane, live, in the pane.
    const open = agent ? attachedTo(this.wire.opts.client.lanes(), place.machine, agent) : null
    this.wire.put({
      ...this.wire.state,
      schedule: null,
      paneScroll: 0,
      elsewhere: {
        ...withoutAgent(place),
        ...(agent ? { agent } : {}),
        ...(open ? { lane: open.id } : {}),
      },
    })
    if (open !== null) {
      this.inPane(open.id)
      return
    }
    this.wire.draw()
    const looked = this.looked()
    if (looked !== null) void this.read(looked)
  }

  async fromTaskMenu(id: string, item: string): Promise<void> {
    const found = this.found(id)
    if (found?.agent == null) return this.say(`${refOf(id).id} is not there any more`)
    const { machine, agent } = found
    // The same menu, so an item that cannot be done is off and never pressed;
    // a control on the row is checked here against the same rule.
    const off = this.taskItems(id).find((one) => one.id === item)?.off
    if (off) return this.say(`${agent.title ?? agent.name}: ${off}`)
    const name = agent.title ?? agent.name
    switch (item) {
      case 'open':
        if (elsewhereOf(this.wire.state)?.agent !== agent.id) this.look(id)
        // Typing into it is a terminal here: opened at once where its agent runs.
        if (agent.lane === 'running') await this.attach()
        return
      case 'start':
        return this.on(id, 'start', {})
      case 'stop':
        return this.on(id, 'stop', { confirm: true })
      case 'mark-done':
        return this.on(id, 'done', { confirm: true })
      case 'park':
        return this.on(id, 'park', { parked: !(agent.parked || agent.mark === 'parked') })
      case 'rename':
        return this.prompt(
          promptPanel('rename-agent', `Rename ${name} on ${machine.name}`, 'NAME', name),
          id,
        )
      case 'model':
        return this.prompt(promptPanel('model-there', `Model for ${name}`, 'MODEL'), id)
      case 'account':
        return this.prompt(promptPanel('account-there', `Account for ${name}`, 'ACCOUNT'), id)
      case 'remove':
      case 'queue-remove':
        this.wire.put({ ...this.wire.state, panel: confirmRemovePanel(id) })
        this.wire.draw()
        return
      case 'queue-retell':
        return this.prompt(
          promptPanel('queue-retell', `What ${name} is told on ${machine.name}`, 'PROMPT'),
          id,
        )
      default:
        if (item.startsWith('queue-')) return this.on(id, 'queue', { change: item.slice(6) })
        return this.say(`${name} on ${machine.name}: ${item} is not something done from here`)
    }
  }

  async remove(id: string): Promise<string | null> {
    try {
      flash(this.wire, await this.carryTo(id, 'remove', { confirm: true }))
      this.wire.draw()
      return null
    } catch (err) {
      return why(err)
    }
  }

  rename(id: string, title: string): Promise<string> {
    return this.carryTo(id, 'rename', { title })
  }

  retell(id: string, prompt: string): Promise<string> {
    const { machine, id: task } = refOf(id)
    return this.pressedOn(machine ?? '', 'queue/change', { task, change: 'retell', prompt })
  }

  schedule(id: string): ScheduleView | null {
    const { machine } = refOf(id)
    const found = this.deps.machines().remotes.find((one) => one.name === machine)
    if (!found) return null
    const all = (found.detail.about?.schedules ?? []).map((one) => scheduleThere(one, found.name))
    return all.find((one) => one.id === id) ?? null
  }

  scheduleItems(id: string): readonly MenuItem[] {
    const one = this.schedule(id)
    const machine = this.deps.machines().remotes.find((each) => each.name === refOf(id).machine)
    return one && machine ? thereScheduleItems(one, machine) : []
  }

  async onSchedule(id: string, change: string): Promise<void> {
    const one = this.schedule(id)
    const { machine, id: schedule } = refOf(id)
    if (one === null || machine === null) return this.say(`${schedule} is not there any more`)
    if (change === 'open') {
      const place = elsewhereOf(this.wire.state)
      this.wire.put({
        ...this.wire.state,
        schedule: id,
        ...(place ? { elsewhere: withoutAgent(place) } : {}),
      })
      this.wire.draw()
      return
    }
    const off = this.scheduleItems(id).find((item) => item.id === `schedule-${change}`)?.off
    if (off) return this.say(`${one.name}: ${off}`)
    if (change === 'rename') {
      return this.prompt(
        promptPanel('rename-schedule', `Rename ${one.name} on ${machine}`, 'NAME', one.name),
        id,
      )
    }
    // Run now is the queue's `start` of a schedule there, as it is here.
    const asked = change === 'run' ? 'start' : change
    try {
      flash(this.wire, await this.pressedOn(machine, 'queue/change', { schedule, change: asked }))
    } catch (err) {
      notify(this.wire, why(err))
    }
    this.wire.draw()
  }

  renameSchedule(id: string, name: string): Promise<string> {
    const { machine, id: schedule } = refOf(id)
    return this.pressedOn(machine ?? '', 'queue/change', { schedule, change: 'rename', name })
  }

  /** The machine, its project and the agent an id there names, as the frame has them now. */
  private found(id: string): {
    machine: Machine
    project: RemoteProject | null
    agent: RemoteAgent | null
  } | null {
    const { machine: name, id: task } = refOf(id)
    const machine = this.deps.machines().remotes.find((one) => one.name === name)
    if (!machine) return null
    for (const project of machine.projects) {
      const agent = project.agents.find((one) => one.id === task)
      if (agent) return { machine, project, agent }
    }
    return { machine, project: null, agent: null }
  }

  /** One verb on an agent there, said in the strip however it went. */
  private async on(id: string, verb: string, extra: Record<string, unknown>): Promise<void> {
    try {
      flash(this.wire, await this.carryTo(id, verb, extra))
    } catch (err) {
      notify(this.wire, why(err))
    }
    this.wire.draw()
  }

  /** A model or an account, named on a prompt: carried, and the panel closed. */
  private async named(id: string, verb: string, extra: Record<string, unknown>): Promise<void> {
    const said = await this.carryTo(id, verb, extra)
    this.wire.put({ ...this.wire.state, panel: null })
    flash(this.wire, said)
    this.wire.draw()
  }

  /** A one-line panel about something there: its id is the panel's target. */
  private prompt(panel: ReturnType<typeof promptPanel>, id: string): void {
    this.wire.put({ ...this.wire.state, panel: { ...panel, target: id } })
    this.wire.draw()
  }

  /** One of that machine's tool calls, through its own gate, with a key of its own. */
  private async pressedOn(
    machine: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    const pressed = this.deps.pressed
    if (!pressed) throw new Error(`this window cannot act on ${machine}`)
    const reach = this.deps.reach(machine)
    if (reach === null || !reach.live) throw new Error(`${machine} is not linked right now`)
    const said = await pressed({
      machine,
      key: randomBytes(12).toString('base64url'),
      method,
      params,
    })
    return `${machine}: ${printable(said).split('\n')[0] || 'done'}`
  }

  /** What is being looked at, or null: an agent on another machine, as the frame has it now. */
  private looked(): Looked | null {
    const place = elsewhereOf(this.wire.state)
    if (place?.agent === undefined) return null
    const found = placeIn(this.deps.machines(), place)
    if (found === null) return null
    const agent = found.project?.agents.find((one) => one.id === place.agent) ?? null
    return { place: { ...place, agent: place.agent }, machine: found.machine, agent }
  }

  /** Ask that machine for the agent's screen, and hold what it answers. */
  private async read(looked: Looked): Promise<void> {
    const key = keyOf(looked.place)
    const reach = this.deps.reach(looked.machine.name)
    const task = looked.place.agent
    if (reach === null || !reach.live || !TaskId.safeParse(task).success) return
    const [project = '', name = ''] = task.split('/')
    this.asking = key
    this.askedAt = this.wire.now()
    try {
      const answer = await reach.link.request(
        looked.machine.name,
        `/api/agent/${encodeURIComponent(project)}/${encodeURIComponent(name)}`,
      )
      if (keyOf(this.looked()?.place) !== key) return
      const screen =
        answer.status === 200
          ? screenOf(task, answer.body, this.deps.skew(looked.machine.name))
          : screenOf(task, null, 0)
      this.screen = { of: key, screen }
    } catch (err) {
      // What was read stays, with when it was read; only an empty pane says why.
      if (this.screen?.of !== key) {
        this.screen = {
          of: key,
          screen: { task, lines: [], at: null, above: 0, why: printable(why(err)) },
        }
      }
    } finally {
      if (this.asking === key) this.asking = null
      this.wire.draw()
    }
  }

  /**
   * Enter: a terminal here that is the agent there, in the pane. The one
   * already open to it is put there; otherwise one is opened
   * (`remote-terminals.ts`) and put there once it runs.
   */
  private async attach(): Promise<void> {
    const looked = this.looked()
    if (looked === null) return
    const machine = looked.machine.name
    const task = looked.place.agent
    const open = attachedTo(this.wire.opts.client.lanes(), machine, task)
    if (open !== null) return this.inPane(open.id)
    await this.terminals.open(machine, task, (id) => this.inPane(id))
  }

  /**
   * A terminal here that is the agent there in front, put in the pane with the
   * keyboard in it — and out of the lower pane's front, since one lane is drawn
   * in one place (`laneThere`). Only while that agent is still the one in
   * front: a terminal that took a while to open does not move a window that
   * went somewhere else meanwhile.
   */
  private inPane(id: string): void {
    const looked = this.looked()
    const lane = attachedFrom(this.wire.opts.client.lanes()).find((one) => one.id === id)
    if (looked === null || lane?.machine !== looked.machine.name) return
    if (lane.task !== looked.place.agent) return
    this.wire.live?.tabsNow()
    const state = this.wire.state
    this.wire.put({
      ...leaveLine(state),
      elsewhere: { ...looked.place, lane: id },
      keyboard: 'pane',
      paneScroll: 0,
      ...(state.bottom === id ? { bottom: ORCHESTRATOR_TAB } : {}),
    })
    this.wire.draw()
  }

  /** Allow or deny what the agent there is held on, by the approval's own id. */
  private async answer(allow: boolean): Promise<void> {
    const approval = this.looked()?.agent?.approval
    if (!approval) return this.say('nothing there is waiting on an answer any more')
    await this.act('answer', { approval: approval.id, allow })
  }

  /** One verb, said in the strip however it went. */
  private async act(verb: string, extra: Record<string, unknown>): Promise<void> {
    const looked = this.looked()
    if (looked === null) return
    try {
      flash(this.wire, await this.carry(looked, verb, extra))
    } catch (err) {
      notify(this.wire, why(err))
    }
    this.wire.draw()
  }

  /**
   * One verb carried to the machine the agent is on, as its owner: its target,
   * what this window last saw of it, and a key of its own. What came of it, in
   * that machine's words as text; throws with the sentence where it did not.
   */
  private carry(looked: Looked, verb: string, extra: Record<string, unknown>): Promise<string> {
    return this.carryTo(there(looked.machine.name, looked.place.agent), verb, extra)
  }

  /** The same, for an agent there named by the id its row carries (`there.ts`). */
  private async carryTo(id: string, verb: string, extra: Record<string, unknown>): Promise<string> {
    const found = this.found(id)
    const { machine: name, id: task } = refOf(id)
    if (found === null) throw new Error(`${name ?? 'that machine'} is not a remote here any more`)
    const machine = found.machine.name
    const agent = found.agent
    if (agent === null) throw new Error(`${task} is not on ${machine} any more`)
    const looked = { machine: found.machine }
    const reach = this.deps.reach(machine)
    if (reach === null || !reach.live) throw new Error(`${machine} is not linked right now`)
    if (agent.rev === null || looked.machine.rev === null) {
      throw new Error(`${machine} has not said enough about ${agent.name} to act on it yet`)
    }
    const answer = await reach.link.request(machine, `/api/act/${verb}`, {
      task: agent.id,
      was: agent.rev,
      key: randomBytes(12).toString('base64url'),
      rev: looked.machine.rev,
      ...extra,
    })
    return saidOf(answer, machine, verb)
  }

  private say(said: string): void {
    notify(this.wire, said)
    this.wire.draw()
  }
}

/** Machine and task, as one key, or empty for nothing looked at. */
function keyOf(place: Place | undefined | null): string {
  return place?.agent === undefined ? '' : `${place.machine}\0${place.agent}`
}

/** The project there, with no agent in front and so no lane of one. */
function withoutAgent(place: Place): Place {
  return { machine: place.machine, project: place.project }
}

/** What an act answered, as the sentence to say — or thrown, where it was refused. */
export function saidOf(answer: Answer, machine: string, verb: string): string {
  const body = typeof answer.body === 'object' && answer.body !== null ? answer.body : {}
  const said = 'said' in body && typeof body.said === 'string' ? printable(body.said) : ''
  if (answer.status === 200) return `${machine}: ${said || 'done'}`
  const error = 'error' in body ? body.error : null
  // No route by that name: the routes that act are built only where acting
  // from another screen is on there (`surfaces.web.acting`).
  if (answer.status === 404 && error === 'no_such') {
    throw new Error(
      `${machine} takes no ${verb} from another screen — turn on acting from away there (surfaces.web.acting)`,
    )
  }
  throw new Error(`${machine}: ${said || `it answered ${answer.status}`}`)
}

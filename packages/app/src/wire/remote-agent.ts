import { randomBytes } from 'node:crypto'
import { type LaneId, printable, TaskId } from '@tade/core'
import type { Answer, Held, Remote, RemoteLink } from '@tade/remotes-core'
import type { AgentMenuOut } from '@tade/web'
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
import {
  doneTasks,
  laneThere,
  leaveLine,
  notice,
  ORCHESTRATOR_TAB,
  type ScheduleView,
  showQueue,
} from '../model.ts'
import { type MenuItem, menuPanel } from '../panels/menu/state.ts'
import { closeDonePanel, confirmRemovePanel, promptPanel } from '../panels/small/state.ts'
import { QUEUE_SCOPES } from '../queue-view.ts'
import type { SideThere } from '../side.ts'
import {
  paneOf,
  queuedOf,
  refOf,
  scheduleThere,
  there,
  thereItems,
  thereScheduleItems,
} from '../there.ts'
import {
  type Actions,
  flash,
  type Menus,
  notify,
  type Prompts,
  type Subject,
  type Submits,
  type Wiring,
  why,
} from './context.ts'
import { RemoteDisk, type RemoteDiskDeps } from './remote-disk.ts'
import { RemoteSide } from './remote-side.ts'
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
// whose lane runs there opens it, as a press on an agent here opens it: the
// terminal already open to it is put in the pane, or one is opened (the screen
// read shows until it runs), and nothing is read over the link while it is
// live. The SSH key is the authority, so nothing types into a
// lane from away: this never goes through the away view's verbs at all.
// Opening one, running it again once its connection is back and moving it off
// a way that does not get through are `remote-terminals.ts`'s.
//
// Telling it something is typing into that terminal, as it is for an agent
// here: there is no prompt of the window's own for it. Another of its lanes —
// the shell its pane has a tab for — is a terminal here in the same way
// (`/api/attach` with that lane's id), put in the pane under that tab
// (`Place.tab`), and its ACTIONS tab is what that machine's window draws
// there (`/api/side`'s `actions`).
//
// **Everything else is a verb** (`/api/act/<verb>`), with the target and
// what this window last saw of it (`was`, `rev`), so a press against a screen
// that is out of date is that machine saying so rather than doing the wrong
// thing. What is on its disk is read (`remote-disk.ts`), and what it answers
// is said as text.

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
  /** The viewer and the branch panel, which what is read from that machine's disk opens in. */
  files?(): ReturnType<RemoteDiskDeps['files']>
  /** Something put on the clipboard, said in the strip. */
  copy?(text: string): Promise<void>
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
  /**
   * What the header of an agent there says it runs on, as that machine's
   * window does (`/api/side`): its route, its vitals and what its harness
   * offers — or null where that machine has not said.
   */
  header(id: string): SideThere['agent']
  /** One of that machine's own tool calls about an agent there (`worker/thinking`…), said in the strip. */
  pressThere(id: string, method: string, params: Record<string, unknown>): Promise<void>
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
  /**
   * The models an agent there may be switched to, as that machine's own menu
   * for it listed them (`modelsThere`), for the picker open on it: `items`
   * null while it is asked.
   */
  private picking: { id: string; items: MenuItem[] | null; why: string | null } | null = null
  /** The look on its way, by machine and task, so a late answer about another is dropped. */
  private asking: string | null = null
  private askedAt = 0
  /** The terminals here that are agents there. */
  private readonly terminals: RemoteTerminals
  /** The agents there a terminal here is being opened to, by machine and task. */
  private readonly opening = new Set<string>()
  /** The project there you stand in, as that machine's window draws it. */
  private readonly side: RemoteSide
  /** What is on its disk: a file, a change, its branches, read there and opened here. */
  private readonly disk: RemoteDisk

  constructor(wire: Wiring, deps: RemoteAgentDeps) {
    this.wire = wire
    this.deps = deps
    this.terminals = new RemoteTerminals(wire, { reach: (machine) => deps.reach(machine) })
    this.side = new RemoteSide(wire, {
      reach: (machine) => deps.reach(machine),
      actions: () => this.showingActions(),
    })
    this.disk = new RemoteDisk(wire, {
      reach: (machine) => deps.reach(machine),
      shown: (place) => this.side.shownFor(place),
      files: () => {
        const files = deps.files?.()
        if (!files) throw new Error('this window has no viewer to open it in')
        return files
      },
      copy: (text) => deps.copy?.(text) ?? Promise.resolve(),
      shell: (machine, project) => this.shellSaid(machine, project),
      tell: (place, text) => this.tell(place, text),
      soon: () => this.side.soon(),
    })
  }

  facts(): Partial<Frame> {
    const side = this.side.facts()
    const looked = this.looked()
    if (looked === null || this.screen?.of !== keyOf(looked.place)) return side
    return { ...side, remoteScreen: this.screen.screen }
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
    this.side.beat()
    const looked = this.looked()
    if (looked === null || this.asking !== null) return
    // Its lane is in the pane, live: there is nothing to read over the link.
    if (laneThere(this.wire.state) !== null) return
    if (this.wire.now() - this.askedAt < LOOK_MS && this.screen?.of === keyOf(looked.place)) return
    void this.read(looked)
  }

  actions(): Actions {
    return {
      // A row of an agent there, pressed: looked at, as a row here is focused,
      // and opened where its lane runs, as a row here is opened by a click.
      'remote-look:': (task) => this.press(task),
      // A tab of an agent there's pane: its own lane, or another of its lanes.
      'remote-lane:': (said) => {
        const [task = '', lane = ''] = said.split('\0')
        return this.lane(task, lane)
      },
      // Its ACTIONS tab, which that machine's window draws (`/api/side`).
      'remote-actions:': (task) => this.actionsTab(task),
      'remote-attach': () => this.attach(),
      'remote-allow': () => this.answer(true),
      'remote-deny': () => this.answer(false),
    }
  }

  /**
   * What the side and the pane's controls do while you stand in a project
   * there: the same controls as here, done to that project on that machine —
   * a new agent, a note, a shell, the finished ones closed, how much of the
   * queue is shown — and what is on its disk said rather than opened here.
   */
  elsewhere(): Actions {
    const place = elsewhereOf(this.wire.state)
    if (place === null) return {}
    const { machine, project } = place
    return {
      'new-agent-where': () => {
        this.wire.put({
          ...this.wire.state,
          panel: {
            ...promptPanel('new-there', `New agent on ${machine} in ${project}`, 'For'),
            target: `${machine}\0${project}`,
          },
        })
        this.wire.draw()
      },
      'add-note': () => {
        this.wire.put({
          ...this.wire.state,
          panel: {
            ...promptPanel('note-there', 'New note', `NOTE ABOUT ${project.toUpperCase()}`),
            target: `${machine}\0${project}`,
          },
        })
        this.wire.draw()
      },
      'new-shell': () => this.shellSaid(machine, project),
      'close-done': () => {
        // The panes the side is drawn from: that machine's answer, or — from a
        // Tade there too old to give one — its projection, as `seenThere` draws it.
        const side = this.side.shownFor(place)
        const found = side === null ? placeIn(this.deps.machines(), place) : null
        const projected = found?.project
        const panes =
          side?.panes ??
          (projected
            ? projected.agents.map((agent) =>
                agent.queued ? queuedOf(agent, projected) : paneOf(agent, projected),
              )
            : [])
        const done = doneTasks({ ...this.wire.state, panes: [...panes], project })
        this.wire.put(
          done.length === 0
            ? notice(
                this.wire.state,
                `no agent in ${project} on ${machine} has finished yet`,
                this.wire.now(),
              )
            : {
                ...this.wire.state,
                panel: closeDonePanel(done.map((pane) => there(machine, pane.task))),
              },
        )
        this.wire.draw()
      },
      // How much of its queue is shown is this window's to remember, for the project there.
      'queue-scope:': (name) => {
        const scope = QUEUE_SCOPES.find((one) => one === name)
        const state = this.wire.state
        if (scope) {
          const shown = showQueue({ ...state, project }, { scope })
          this.wire.put({ ...shown, project: state.project })
        }
        this.wire.draw()
      },
      // Its ACTIONS tab's Run checks: that machine's own `checks_run`, as here.
      'checks-run:': (id) => this.checksThere(id),
      ...this.disk.elsewhere(),
    }
  }

  /** A shell in that project there, in a terminal here; why not, said. */
  private async shellSaid(machine: string, project: string): Promise<void> {
    try {
      await this.shell(machine, project)
    } catch (err) {
      notify(this.wire, `${machine}: ${why(err)}`)
      this.wire.draw()
    }
  }

  /** The panels that are that machine's — a save, a discard, a switch — carried out there. */
  submitsThere(): Submits {
    return this.disk.submitsThere()
  }

  /** A branch made or renamed on that machine's checkout. */
  promptsThere(): Prompts {
    return this.disk.promptsThere()
  }

  prompts(): Prompts {
    return {
      'note-there': async (panel, text) => {
        const [machine = '', project = ''] = (panel.target ?? '').split('\0')
        if (text === '') throw new Error('say what to note')
        const said = await this.pressedOn(machine, 'memory/remember', {
          text,
          scope: project,
          by: 'window',
        })
        this.wire.put({ ...this.wire.state, panel: null })
        this.side.soon()
        flash(this.wire, said)
        this.wire.draw()
      },
      'model-there': async (panel, text) => {
        await this.named(panel.target ?? '', 'model', { model: text })
      },
      'account-there': async (panel, text) => {
        await this.named(panel.target ?? '', 'account', { account: text })
      },
    }
  }

  /**
   * Change model… on an agent there: the models that machine's own menu for it
   * lists, the one it is on marked, as an agent's picker here is — and a name
   * typed, for a model that list does not have or a machine that lists none.
   */
  menus(): Menus {
    return {
      ...this.disk.menus(),
      'model-there': {
        title: (subject) => `Model for ${this.title(subject.id)}`,
        items: (subject) => {
          const typed: MenuItem = { id: 'type', label: 'Type a name…' }
          const picking = this.picking?.id === subject.id ? this.picking : null
          const machine = refOf(subject.id).machine ?? 'that machine'
          if (picking?.items == null) {
            return [{ id: '', label: `asking ${machine} which models it runs…`, off: 'asking' }]
          }
          if (picking.items.length === 0) {
            const said = picking.why ?? `${machine} listed no models for it`
            return [{ id: '', label: said, off: 'none listed' }, typed]
          }
          return [...picking.items, { ...typed, divider: true }]
        },
        choose: (subject, item) => {
          if (item === 'type') {
            const name = this.title(subject.id)
            return this.prompt(promptPanel('model-there', `Model for ${name}`, 'MODEL'), subject.id)
          }
          if (item.startsWith('model:'))
            return this.on(subject.id, 'model', { model: item.slice(6) })
        },
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

  /** Whether the agent there in front has its ACTIONS tab shown: what the side then asks for. */
  private showingActions(): boolean {
    const place = elsewhereOf(this.wire.state)
    if (place?.agent === undefined) return false
    return this.wire.state.paneTab[there(place.machine, place.agent)] === 'actions'
  }

  /**
   * Its ACTIONS tab pressed: shown in the pane, as here (`viewActions`), kept
   * under its id carried to that machine, and asked of that machine now.
   */
  private actionsTab(id: string): void {
    const place = elsewhereOf(this.wire.state)
    const { machine, id: task } = refOf(id)
    if (place === null || place.machine !== machine || place.agent !== task) return
    const state = this.wire.state
    this.wire.put({
      ...state,
      paneTab: { ...state.paneTab, [id]: 'actions' },
      actionsScroll: 0,
    })
    this.side.soon()
    this.wire.draw()
  }

  /**
   * A tab of the agent there's pane pressed: its own lane brought back in
   * front — opened where it is not yet — or another of its lanes, its shell,
   * a terminal here to that lane there (`/api/attach` with the lane), put in
   * the pane under its tab (`Place.tab`), as a press on a shell's tab here
   * shows it there.
   */
  private async lane(id: string, lane: string): Promise<void> {
    const place = elsewhereOf(this.wire.state)
    const { machine, id: task } = refOf(id)
    if (place === null || machine === null || place.machine !== machine) return
    if (place.agent !== task) return this.look(id)
    const state = this.wire.state
    const { [id]: _actions, ...paneTab } = state.paneTab
    if (!lane.startsWith(`${task}/`)) {
      this.wire.put({ ...state, paneTab, elsewhere: withoutTab(place) })
      this.wire.draw()
      if (place.lane === undefined && this.looked()?.agent?.lane === 'running') await this.attach()
      return
    }
    this.wire.put({ ...state, paneTab })
    const open = attachedTo(this.wire.opts.client.lanes(), machine, lane)
    if (open !== null) return this.inTab(task, lane, open.id)
    const key = `${machine}\0${lane}`
    if (this.opening.has(key)) return
    this.opening.add(key)
    try {
      await this.terminals.open(machine, lane, (opened) => this.inTab(task, lane, opened))
    } finally {
      this.opening.delete(key)
    }
  }

  /**
   * A terminal here that is another lane of the agent there in front, put in
   * the pane under that lane's tab — only while that agent is still in front.
   */
  private inTab(task: string, lane: string, id: string): void {
    const place = elsewhereOf(this.wire.state)
    if (place?.agent !== task) return
    this.wire.live?.tabsNow()
    const state = this.wire.state
    this.wire.put({
      ...leaveLine(state),
      elsewhere: { ...place, tab: { there: lane, lane: id } },
      keyboard: 'pane',
      paneScroll: 0,
      ...(state.bottom === id ? { bottom: ORCHESTRATOR_TAB } : {}),
    })
    this.wire.draw()
  }

  /**
   * Run checks on its ACTIONS tab: that machine's own `checks_run` for the
   * project, through its gate as any press there is — said at once, since a
   * suite takes minutes, and again with what it came to.
   */
  private async checksThere(id: string): Promise<void> {
    const { machine, id: task } = refOf(id)
    if (machine === null) return
    const project = task.split('/')[0] ?? task
    flash(this.wire, `running ${project}'s checks on ${machine}`)
    this.side.soon()
    this.wire.draw()
    try {
      flash(
        this.wire,
        await this.pressedOn(machine, 'extension/call', {
          tool: 'checks_run',
          input: { project },
          callId: randomBytes(8).toString('hex'),
        }),
      )
    } catch (err) {
      notify(this.wire, why(err))
    }
    this.side.soon()
    this.wire.draw()
  }

  /**
   * A row pressed: looked at and, where its agent's lane runs there, a terminal
   * here that is it put in the pane (`attach`) — what enter on it does, as a
   * click on an agent here opens it. Pressed again it is let go of, and opens
   * nothing.
   */
  private press(id: string): void {
    this.look(id)
    const looked = this.looked()
    if (looked?.agent?.lane !== 'running' || looked.place.lane) return
    void this.attach()
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
        return this.pickModel(id, name)
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

  header(id: string): SideThere['agent'] {
    const { machine, id: task } = refOf(id)
    const place = elsewhereOf(this.wire.state)
    if (place === null || place.machine !== machine) return null
    const agent = this.side.shownFor(place)?.agent ?? null
    return agent?.task === task ? agent : null
  }

  async pressThere(id: string, method: string, params: Record<string, unknown>): Promise<void> {
    const { machine, id: task } = refOf(id)
    try {
      const where =
        this.header(id) === null ? null : this.side.worktreeFor(elsewhereOf(this.wire.state))
      flash(
        this.wire,
        await this.pressedOn(machine ?? '', method, {
          task,
          ...(where === null ? {} : { worktree: where }),
          ...params,
        }),
      )
      this.side.soon()
    } catch (err) {
      notify(this.wire, why(err))
    }
    this.wire.draw()
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

  /**
   * The models picker on an agent there, opened at once and saying it is
   * asking — a list is a question to that machine's harness, and a menu that
   * appears seconds after the press is a press that seemed to miss — then
   * filled with what that machine answered, the keyboard on the one in use.
   */
  private async pickModel(id: string, name: string): Promise<void> {
    const picking = { id, items: null, why: null }
    this.picking = picking
    this.wire.put({
      ...this.wire.state,
      panel: menuPanel({ kind: 'model-there', id }, `Model for ${name}`),
    })
    this.wire.draw()
    const read = await this.modelsThere(id).catch((err: unknown) => ({
      items: [],
      why: printable(why(err)),
    }))
    // Asked again, or closed for another, meanwhile: nothing on screen is about it.
    if (this.picking !== picking) return
    this.picking = { id, ...read }
    const panel = this.wire.state.panel
    if (panel?.kind === 'menu' && panel.subject.kind === 'model-there' && panel.subject.id === id) {
      const index = Math.max(
        0,
        read.items.findIndex((one) => one.label.startsWith('● ')),
      )
      this.wire.put({ ...this.wire.state, panel: { ...panel, index } })
    }
    this.wire.draw()
  }

  /**
   * What `Change model…` lists in that machine's own menu for its agent
   * (`GET /api/agent/:project/:task/menu`, the phone's list) — read when the
   * picker opens, never on a beat, since it is a question to its harness.
   */
  private async modelsThere(id: string): Promise<{ items: MenuItem[]; why: string | null }> {
    const { machine, id: task } = refOf(id)
    const name = machine ?? 'that machine'
    const reach = machine === null ? null : this.deps.reach(machine)
    if (reach === null || !reach.live) throw new Error(`${name} is not linked right now`)
    if (!TaskId.safeParse(task).success) throw new Error(`${task} is not an agent's name`)
    const [project = '', short = ''] = task.split('/')
    const answer = await reach.link.request(
      name,
      `/api/agent/${encodeURIComponent(project)}/${encodeURIComponent(short)}/menu`,
    )
    if (answer.status !== 200) return { items: [], why: `${name} did not say which models it runs` }
    return modelsOfMenu(answer.body, name)
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
   * (`remote-terminals.ts`) and put there once it runs. `typed` is written
   * into it once it is in the pane — unsent, as a question about a file is
   * typed into an agent here (`Files.askAbout`).
   */
  private async attach(typed?: string): Promise<void> {
    const looked = this.looked()
    if (looked === null) return
    const machine = looked.machine.name
    const task = looked.place.agent
    const put = (id: string) => {
      this.inPane(id)
      if (typed !== undefined) void this.typeInto(id, typed)
    }
    const open = attachedTo(this.wire.opts.client.lanes(), machine, task)
    if (open !== null) return put(open.id)
    // One on its way is that one: a second press, or enter after a press,
    // while it is asked for or starts, opens no second terminal.
    const key = keyOf(looked.place)
    if (this.opening.has(key)) {
      if (typed !== undefined)
        this.say(`a terminal to ${task} on ${machine} is opening: ask again once it is`)
      return
    }
    this.opening.add(key)
    try {
      await this.terminals.open(machine, task, put)
    } finally {
      this.opening.delete(key)
    }
  }

  /**
   * Something typed into the agent there, unsent: into the terminal here that
   * is its lane, put in the pane, or opened where none is yet. Only the agent in
   * front, whose menu it was asked from, and only one whose lane runs there.
   */
  private async tell(place: Place & { agent: string }, text: string): Promise<void> {
    const looked = this.looked()
    if (looked === null || keyOf(looked.place) !== keyOf(place)) {
      return this.say(`${place.agent} on ${place.machine} is not in front any more`)
    }
    const open = attachedTo(this.wire.opts.client.lanes(), place.machine, place.agent)
    if (open === null && looked.agent?.lane !== 'running') {
      return this.say(`${place.agent} is not running on ${place.machine}: start it, then ask`)
    }
    await this.attach(text)
  }

  /** Typed into a terminal here, while it is the one in the pane; why not, said. */
  private async typeInto(id: string, text: string): Promise<void> {
    if (elsewhereOf(this.wire.state)?.lane !== id) return
    try {
      await this.wire.opts.client.write(id as LaneId, new TextEncoder().encode(text))
    } catch (err) {
      this.say(`could not type into it: ${why(err)}`)
    }
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
      elsewhere: { ...withoutTab(looked.place), lane: id },
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

  /**
   * Words said to an agent there, as that machine's own `steer` — the line
   * comments on its change (`Comments`) — what it answered, or thrown with why.
   */
  steerThere(machine: string, agent: string, said: string): Promise<string> {
    return this.carryTo(there(machine, agent), 'steer', { said })
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

/** The agent there with its own lane in front, and no other of its lanes. */
function withoutTab(place: Place): Place {
  const { tab: _tab, ...rest } = place
  return rest
}

/** The project there, with no agent in front and so no lane of one. */
function withoutAgent(place: Place): Place {
  return { machine: place.machine, project: place.project }
}

/**
 * The models under `Change model…` in an agent's menu as its machine answered
 * it (`AgentMenuOut`), as this window's picker rows — the one it is on marked
 * as a picker here marks it — or, where it lists none, why in its words.
 * Another machine's answer, so nothing in it is trusted to be the shape it says.
 */
export function modelsOfMenu(
  body: unknown,
  machine: string,
): { items: MenuItem[]; why: string | null } {
  const menu = (typeof body === 'object' && body !== null ? body : {}) as Partial<AgentMenuOut>
  const said = (text: unknown) => (typeof text === 'string' && text !== '' ? printable(text) : null)
  const item = Array.isArray(menu.items) ? menu.items.find((one) => one?.id === 'model') : undefined
  if (item === undefined) {
    return { items: [], why: said(menu.why) ?? `${machine} offers no model list for it here` }
  }
  if (said(item.off) !== null) return { items: [], why: said(item.off) }
  const act = item.act
  if (act?.kind !== 'choose' || !Array.isArray(act.choices)) {
    return { items: [], why: `${machine} offers no model list for it here` }
  }
  const items = act.choices
    .filter((one) => typeof one?.id === 'string' && one.id !== '')
    .map((one): MenuItem => {
      const off = said(one.off)
      const note = said(one.note)
      return {
        id: `model:${one.id}`,
        label: `${one.current === true ? '● ' : '  '}${said(one.label) ?? printable(one.id)}`,
        ...(one.current === true ? { note: 'now' } : note === null ? {} : { note }),
        ...(off === null ? {} : { off }),
      }
    })
  return { items, why: said(act.why) }
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

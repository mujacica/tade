import { randomBytes } from 'node:crypto'
import { printable, TaskId } from '@tade/core'
import type { Answer, Held, Remote, RemoteLink } from '@tade/remotes-core'
import { attachedTo } from '@tade/workbench/attached'
import type { Frame } from '../frame.ts'
import {
  elsewhereOf,
  type Machine,
  type Machines,
  type Place,
  placeIn,
  type RemoteAgent,
  type RemoteScreen,
  screenOf,
} from '../machines.ts'
import { promptPanel } from '../panels/small/state.ts'
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

// An agent on another machine, opened from this window (REMOTE-TADE.md §3.4,
// §9.4): looked at, typed into, told something, and stopped, parked, answered
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
// in a lane of this machine's (`workbench/src/attached.ts`), put in front in
// the lower pane, which is the one place a lane is typed into — the window's
// whole pacing, scrolling and selection come with it. The SSH key is the
// authority, so nothing types into a lane from away: this never goes through
// the away view's verbs at all. Opening one, running it again once its
// connection is back and moving it off a way that does not get through are
// `remote-terminals.ts`'s.
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
}

/** The agent being looked at, with the machine it is on, as the frame has them now. */
interface Looked {
  place: Place & { agent: string }
  machine: Machine
  agent: RemoteAgent | null
}

export class RemoteAgents implements Subject {
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

  /** What a link holds moved: a terminal there that lost its connection may be run again. */
  moved(name: string, held: Held): void {
    this.terminals.moved(name, held)
  }

  /** The window's beat: the screen asked for again, while somebody looks at one. */
  beat(): void {
    this.terminals.beat()
    const looked = this.looked()
    if (looked === null || this.asking !== null) return
    if (this.wire.now() - this.askedAt < LOOK_MS && this.screen?.of === keyOf(looked.place)) return
    void this.look(looked)
  }

  actions(): Actions {
    return {
      // A row of an agent there, pressed: looked at, or let go of when it already was.
      'remote-look:': (task) => {
        const place = elsewhereOf(this.wire.state)
        if (place === null || task === '') return
        const agent = place.agent === task ? undefined : task
        this.wire.put({
          ...this.wire.state,
          elsewhere: { ...withoutAgent(place), ...(agent ? { agent } : {}) },
        })
        this.wire.draw()
        const looked = this.looked()
        if (looked !== null) void this.look(looked)
      },
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

  /**
   * A sentence to an agent on another machine, wherever you are standing —
   * the comments written on its change in the patch reader — as a `steer`
   * there: that machine's answer in its words, or thrown where it would not.
   */
  async tell(machine: string, task: string, said: string): Promise<string> {
    const place = { machine, project: task.split('/')[0] ?? task, agent: task }
    const found = placeIn(this.deps.machines(), place)
    if (found === null) throw new Error(`${machine} is not a machine this window links to`)
    const agent = found.project?.agents.find((one) => one.id === task) ?? null
    return this.carry({ place, machine: found.machine, agent }, 'steer', { said })
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
  private async look(looked: Looked): Promise<void> {
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
   * Enter: a terminal here that is the agent there. The one already open to
   * it is put in front; otherwise one is opened (`remote-terminals.ts`).
   */
  private async attach(): Promise<void> {
    const looked = this.looked()
    if (looked === null) return
    const machine = looked.machine.name
    const task = looked.place.agent
    const open = attachedTo(this.wire.opts.client.lanes(), machine, task)
    if (open !== null) return this.terminals.front(open.id)
    await this.terminals.open(machine, task)
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
  private async carry(
    looked: Looked,
    verb: string,
    extra: Record<string, unknown>,
  ): Promise<string> {
    const machine = looked.machine.name
    const agent = looked.agent
    if (agent === null) throw new Error(`${looked.place.agent} is not on ${machine} any more`)
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

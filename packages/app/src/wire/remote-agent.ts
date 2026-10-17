import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { type LaneId, printable, TaskId } from '@tade/core'
import type { Answer, Remote, RemoteLink } from '@tade/remotes-core'
import { ATTACHED, attachedTo, nextAttached } from '@tade/workbench/attached'
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
import { showTerminal } from '../model.ts'
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
// the away view's verbs at all.
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

  constructor(wire: Wiring, deps: RemoteAgentDeps) {
    this.wire = wire
    this.deps = deps
  }

  facts(): Partial<Frame> {
    const looked = this.looked()
    if (looked === null || this.screen?.of !== keyOf(looked.place)) return {}
    return { remoteScreen: this.screen.screen }
  }

  /** The window's beat: the screen asked for again, while somebody looks at one. */
  beat(): void {
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
   * it is put in front; otherwise that machine is asked for its line, and the
   * link for how to run it there.
   */
  private async attach(): Promise<void> {
    const looked = this.looked()
    if (looked === null) return
    const machine = looked.machine.name
    const task = looked.place.agent
    const client = this.wire.opts.client
    const open = attachedTo(client.lanes(), machine, task)
    if (open !== null) return this.front(open.id)
    const reach = this.deps.reach(machine)
    if (reach === null || !reach.live) {
      return this.say(`${machine} is not linked right now, so no terminal to it can be opened`)
    }
    let terminal: Awaited<ReturnType<RemoteLink['attach']>>
    try {
      const asked = await reach.link.request(machine, '/api/attach', { task })
      const line = lineIn(asked, machine)
      if (line.why !== null) return this.say(line.why)
      terminal = await reach.link.attach(reach.remote, line.command)
    } catch (err) {
      return this.say(`${machine}: ${printable(why(err))}`)
    }
    if (terminal === null) {
      return this.say(`the link to ${machine} cannot open a terminal there`)
    }
    const id = nextAttached(machine, client.lanes()) as LaneId
    try {
      await client.spawn({
        id,
        task: `${ATTACHED}/${machine}`,
        kind: 'terminal',
        cwd: homedir(),
        command: '/bin/sh',
        args: ['-c', HOLD, 'tade', terminal.command, ...terminal.args],
        title: task,
      })
    } catch (err) {
      return this.say(`a terminal to ${machine} could not start here: ${why(err)}`)
    }
    this.front(id)
    if (terminal.by) flash(this.wire, `${task} on ${machine}, over ${terminal.by}`)
    this.wire.draw()
  }

  /**
   * A terminal in front of the lower pane, with the keyboard in it and the
   * window's room to read it: an agent's own screen is a whole screen, which
   * the pane's third of the window cuts to its last few rows. The pane's own
   * control puts it back.
   */
  private front(id: string): void {
    this.wire.live?.tabsNow()
    this.wire.put({ ...showTerminal(this.wire.state, id), bottomMode: 'max' })
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

/**
 * What a terminal there is run inside: the link's command as it was handed
 * over (`"$@"`, never through a shell's reading of it), and where it ends with
 * a failure — ssh refused, tmux there found no session, the connection dropped
 * — the terminal stays with what it printed and says so until enter is
 * pressed. A lane gone is a tab gone, and a tab that vanished says nothing.
 * One that ends cleanly, let go there, closes as it ends.
 */
export const HOLD =
  '"$@"; ended=$?; [ "$ended" -eq 0 ] && exit 0; ' +
  'printf \'\\r\\n[it ended (%s): press enter to close]\' "$ended"; read -r _; exit "$ended"'

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

/** That machine's line for the agent, or why there is none, from what `/api/attach` answered. */
export function lineIn(
  answer: Answer,
  machine: string,
): { command: string; why: null } | { command: null; why: string } {
  const body = typeof answer.body === 'object' && answer.body !== null ? answer.body : {}
  if (answer.status === 404) {
    return {
      command: null,
      why: `${machine}'s Tade cannot be asked for a terminal to its agents — update it there`,
    }
  }
  if (answer.status !== 200) {
    const said = 'said' in body && typeof body.said === 'string' ? printable(body.said) : ''
    return { command: null, why: `${machine}: ${said || `it answered ${answer.status}`}` }
  }
  const command = 'command' in body ? body.command : null
  if (typeof command === 'string') return { command, why: null }
  const said = 'why' in body && typeof body.why === 'string' ? printable(body.why) : ''
  return { command: null, why: `${machine}: ${said || 'it gave no terminal for that agent'}` }
}

import { randomBytes } from 'node:crypto'
import { slugify } from '@tade/voice-core'
import type { Machine, Machines, Place } from '../machines.ts'
import { type MenuItem, menuPanel } from '../panels/menu/state.ts'
import { promptPanel } from '../panels/small/state.ts'
import {
  type Actions,
  flash,
  type Menus,
  notify,
  type Pressed,
  type Prompts,
  type Subject,
  type Wiring,
  why,
} from './context.ts'

// Where a new agent or a new terminal goes, once there is more than one
// machine: the `+` asks, and this machine is the first answer, so enter does
// what the `+` did before there was a second.
//
// **This machine's answer is the door it always was** — a new agent is
// `newAgent`, the lower pane's items are the `bottom-new` menu's own — so
// nothing about opening one here changed but the question in front of it.
//
// **Another machine's is that machine's own act**, asked over the link:
// - an agent there is its `task/create` and its `worker/start`, run by its own
//   tool host through its gate (`acts.ts`, `pressed`), in a project of that
//   machine. That machine never starts an agent told nothing, so the words come
//   first, on a line (`new-there`): they are its task's intent, verbatim, and
//   what its agent is told first.
// - a terminal there is a shell in that project's checkout on that machine,
//   in a lane here over the link (`remote-terminals.ts`, `shell`) — the pacing,
//   scrolling and selection of a terminal come with it.
//
// A machine that cannot take either now is in the list all the same, off,
// with why: down, or with no project open there.

/** What the `+` was pressed for: a new agent, or something in the lower pane. */
export type NewWhat = 'agent' | 'below'

export interface NewWhereDeps {
  /** The machines as folded now. */
  machines(): Machines
  /** A new agent here, as the `+` always made one. */
  newHere(): Promise<void>
  /** What the lower pane's `+` offers here, and what choosing one does (`bottom-new`). */
  belowItems(): readonly MenuItem[]
  belowHere(item: string): Promise<void>
  /** One of that machine's own tool methods, run there through its gate; its answer as text. */
  actThere(machine: string, method: string, params: Record<string, unknown>): Promise<string>
  /** A shell in that machine's project, in a lane here. */
  shellThere(machine: string, project: string): Promise<void>
  /** Stand in a project there, looking at one of its agents. */
  go(place: Place): void
}

/** Where a dropdown opens: at the control pressed, or the middle where it was typed (`routes.ts`). */
function atControl(from: Pressed | undefined): { row: number; col: number; control: true } | null {
  return from ? { row: from.row, col: from.col, control: true } : null
}

/** Why a machine takes nothing new now, or null where it does. */
function notNow(machine: Machine): string | null {
  if (machine.link !== 'live') return machine.said ?? `${machine.name} is not linked right now`
  if (machine.projects.length === 0) {
    return machine.heard ? 'no project is open there' : 'nothing heard from it yet'
  }
  return null
}

/**
 * The places the `+` offers, this machine first: `here`, then a row per
 * project on each machine — `there:<machine> <project>` — or one row for a
 * machine that takes nothing now, off with why. `item` is what a row there
 * opens, said in its label.
 */
export function placesOffered(
  machines: Machines,
  here: { label: string; note?: string },
  item: string,
  prefix: string,
): MenuItem[] {
  const rows: MenuItem[] = []
  for (const machine of machines.remotes) {
    const off = notNow(machine)
    if (off !== null) {
      rows.push({ id: '', label: `${item} on ${machine.name}`, off, divider: rows.length === 0 })
      continue
    }
    for (const project of machine.projects) {
      rows.push({
        id: `${prefix}${machine.name} ${project.name}`,
        label: `${item} on ${machine.name}`,
        note: project.title ?? project.name,
        divider: rows.length === 0,
      })
    }
  }
  return [{ id: 'here', ...here }, ...rows]
}

/**
 * Start an agent on another machine: a task there named for the words, the
 * first free name, and its agent told them. The task id there, or a throw
 * with that machine's reason.
 */
export async function startThere(
  act: NewWhereDeps['actThere'],
  machine: string,
  project: string,
  said: string,
): Promise<string> {
  const stem = slugify(said) || 'agent'
  for (let n = 1; n <= 20; n++) {
    const slug = n === 1 ? stem : `${stem}-${n}`
    let made: string
    try {
      made = await act(machine, 'task/create', { project, slug, intent: said })
    } catch (err) {
      // A name used there before is never used again: the next one.
      if (/already exists|used before/.test(why(err))) continue
      throw err
    }
    const task = createdIn(made)
    if (task === null) throw new Error(`${machine} made the task but did not say where it works`)
    await act(machine, 'worker/start', { task: task.id, cwd: task.worktree, prompt: said })
    return task.id
  }
  throw new Error(`every name like ${stem} is taken in ${project} on ${machine}`)
}

/** The task a `task/create` there answered, as text: its id and where it works, or null. */
export function createdIn(text: string): { id: string; worktree: string } | null {
  try {
    const task = JSON.parse(text) as unknown
    if (typeof task !== 'object' || task === null) return null
    const { id, worktree } = task as Record<string, unknown>
    return typeof id === 'string' && typeof worktree === 'string' ? { id, worktree } : null
  } catch (err) {
    // An answer that is not JSON is not a task; anything else is a fault here.
    if (err instanceof SyntaxError) return null
    throw err
  }
}

export class NewWhere implements Subject {
  private readonly wire: Wiring
  private readonly deps: NewWhereDeps

  constructor(wire: Wiring, deps: NewWhereDeps) {
    this.wire = wire
    this.deps = deps
  }

  actions(): Actions {
    return {
      // The `+` beside AGENTS and on a project with none: where, once there is
      // a second machine to ask about, and a new agent here at once until then.
      'new-agent-where': (_rest, from) => {
        if (this.deps.machines().remotes.length === 0) return this.deps.newHere()
        this.wire.put({
          ...this.wire.state,
          panel: menuPanel({ kind: 'new-where', what: 'agent' }, 'New agent', atControl(from)),
        })
        this.wire.draw()
      },
    }
  }

  menus(): Menus {
    return {
      'new-where': {
        title: (subject) => (subject.what === 'agent' ? 'New agent' : 'Open below'),
        items: (subject) => {
          const machines = this.deps.machines()
          if (subject.what === 'agent') {
            const project = this.wire.state.project
            return placesOffered(
              machines,
              { label: `New agent on ${machines.here}`, ...(project ? { note: project } : {}) },
              'New agent',
              'there:',
            )
          }
          const here = this.deps.belowItems().map((one) => ({
            ...one,
            ...(one.id === '' ? {} : { id: `here:${one.id}` }),
          }))
          const there = placesOffered(machines, { label: '' }, 'Terminal', 'shell:').slice(1)
          return [...here, ...there]
        },
        choose: (_subject, item) => this.choose(item),
      },
    }
  }

  prompts(): Prompts {
    return {
      'new-there': async (panel, text) => {
        const [machine = '', project = ''] = (panel.target ?? '').split('\0')
        if (text === '') {
          throw new Error(`say what it is for: ${machine} starts an agent on your words`)
        }
        const task = await startThere(this.deps.actThere, machine, project, text)
        this.wire.put({ ...this.wire.state, panel: null })
        this.deps.go({ machine, project, agent: task })
        flash(this.wire, `${task} is starting on ${machine}`)
        this.wire.draw()
      },
    }
  }

  private async choose(item: string): Promise<void> {
    if (item === 'here') return this.deps.newHere()
    if (item.startsWith('here:')) return this.deps.belowHere(item.slice('here:'.length))
    const [machine = '', project = ''] = item.slice(item.indexOf(':') + 1).split(' ')
    if (item.startsWith('there:')) {
      this.wire.put({
        ...this.wire.state,
        panel: {
          ...promptPanel('new-there', `New agent on ${machine} in ${project}`, 'For'),
          target: `${machine}\0${project}`,
        },
      })
      this.wire.draw()
      return
    }
    if (item.startsWith('shell:')) {
      try {
        await this.deps.shellThere(machine, project)
      } catch (err) {
        notify(this.wire, `${machine}: ${why(err)}`)
        this.wire.draw()
      }
    }
  }
}

/** The menus the lower pane's `+` already answers here, which this asks rather than copies. */
interface BelowHere {
  menus(): Menus
}

/** The acts that reach another machine's tool host (`acts.ts`). */
interface PressesThere {
  pressed(req: {
    machine: string
    key: string
    method: string
    params: Record<string, unknown>
  }): Promise<string>
}

/** The subject, over the window's own doors: its agents, its lower pane, the links and their acts. */
export function newWhereFor(
  wire: Wiring,
  doors: {
    machines: () => Machines
    newHere: () => Promise<void>
    lanes: () => BelowHere
    acts: () => PressesThere
    shellThere: (machine: string, project: string) => Promise<void>
    go: (place: Place) => void
  },
): NewWhere {
  const below = () => doors.lanes().menus()['bottom-new']
  return new NewWhere(wire, {
    machines: doors.machines,
    newHere: doors.newHere,
    belowItems: () => below()?.items({ kind: 'bottom-new' }) ?? [],
    belowHere: async (item) => {
      await below()?.choose({ kind: 'bottom-new' }, item)
    },
    actThere: (machine, method, params) =>
      doors.acts().pressed({ machine, key: randomBytes(12).toString('base64url'), method, params }),
    shellThere: doors.shellThere,
    go: doors.go,
  })
}

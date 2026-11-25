import { printable } from '@tade/core'
import type { RemoteLink } from '@tade/remotes-core'
import { type DiskAnswer, DiskAnswerSchema, type DiskAsk } from '@tade/web'
import { type ParsedDiff, parseDiff } from '../diff.ts'
import { languageOf } from '../highlight.ts'
import { elsewhereOf, type Place } from '../machines.ts'
import { toggleFolder } from '../model.ts'
import {
  branchMenuItems,
  changeMenuItems,
  fileMenuItems,
  type MenuItem,
  type MenuSubject,
} from '../panels/menu/state.ts'
import type { BranchRow } from '../panels/small/state.ts'
import type { SideThere } from '../side.ts'
import type { ViewedFile } from '../viewer.ts'
import { type Actions, type Menus, notify, type Subject, type Wiring, why } from './context.ts'

// What is on another machine's disk, opened from this window while you stand
// in one of its projects: a file in its FILES, a change in its CHANGES and the
// branch under its GIT — read over the link already up (`/api/disk`,
// `@tade/web`'s `disk.ts`) and opened in the very panels a project here opens
// them in: the viewer, with git's answer drawn into a change and opened on its
// first one, and the Switch branch panel with that machine's branches.
//
// **The paths are that machine's**, as its side named them, and they are only
// ever sent back to it: nothing here is looked up on this machine's disk, and
// the panels they open are marked as that machine's (`FilePanel.there`,
// `BranchPanel.there`), so a save, an editor, a comment or a switch never
// lands on a file or a checkout here that happens to have the same path.
//
// **Its menus are the menus here** (`fileMenuItems`, `changeMenuItems`,
// `branchMenuItems`), with what would change that machine's disk or need this
// one's desktop turned off and said: reading is carried, and nothing else is.

type What = Extract<MenuSubject, { kind: 'disk-there' }>['what']

/** The items here that change that machine's disk, or open what only this machine's desktop can. */
const NOT_FROM_HERE: ReadonlySet<string> = new Set([
  'editor',
  'reveal',
  'ask',
  'search',
  'discard',
  'patch',
  'new',
  'rename',
  'pull',
])

/** Said beside an item that is not carried to that machine. */
export const ON_IT_ONLY = 'not from here'

export interface RemoteDiskDeps {
  /** The link holding a machine, or null where none does. */
  reach(machine: string): { link: RemoteLink; live: boolean } | null
  /** What that machine last said of the project you stand in there (`RemoteSide`). */
  shown(place: Place): SideThere | null
  /** The viewer and the branch panel, which a read from there opens in as one here does. */
  files(): {
    openThere(
      file: ViewedFile,
      machine: string,
      opened: {
        line: number | null
        diff: ParsedDiff | null
        task: string | null
        inline: boolean
      },
    ): void
    branchesThere(machine: string, rows: readonly BranchRow[]): void
  }
  /** Something put on the clipboard, said in the strip. */
  copy(text: string): Promise<void>
  /** A terminal in that project there: where the folder under GIT opens, as one here opens in its app. */
  shell(machine: string, project: string): Promise<void>
}

export class RemoteDisk implements Subject {
  private readonly wire: Wiring
  private readonly deps: RemoteDiskDeps

  constructor(wire: Wiring, deps: RemoteDiskDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * What the side's own controls do there: a press on a file, a place in a
   * screen or a change (`remote-there:<kind>␀<path>␀<line>`, from the mouse),
   * and the path under GIT copied or opened.
   */
  elsewhere(): Actions {
    const place = elsewhereOf(this.wire.state)
    if (place === null) return {}
    return {
      'remote-there:': (said) => {
        const [kind = '', path = '', line = ''] = said.split('\0')
        if (path === '') return
        const at = Number(line)
        return this.open(place, path, {
          change: kind === 'change',
          line: line !== '' && Number.isInteger(at) && at > 0 ? at : null,
        })
      },
      'copy-path': async () => {
        const path = this.deps.shown(place)?.where?.path
        if (path) await this.deps.copy(path)
      },
      'open-path': () => this.deps.shell(place.machine, place.project),
    }
  }

  menus(): Menus {
    return {
      'disk-there': {
        title: (subject) =>
          subject.what === 'branch'
            ? this.branchOf(subject.machine) || 'branch'
            : (subject.path.split('/').at(-1) ?? subject.path),
        items: (subject) => this.items(subject.machine, subject.what, subject.path),
        choose: (subject, item) => this.choose(subject.machine, subject.what, subject.path, item),
      },
    }
  }

  /** The place you stand in, where it is still on that machine. */
  private placeOn(machine: string): Place | null {
    const place = elsewhereOf(this.wire.state)
    return place?.machine === machine ? place : null
  }

  private branchOf(machine: string): string {
    const place = this.placeOn(machine)
    return (place && this.deps.shown(place)?.where?.branch) ?? ''
  }

  /** The menu here for the same thing, with what is not carried there turned off. */
  private items(machine: string, what: What, path: string): MenuItem[] {
    const place = this.placeOn(machine)
    const side = place ? this.deps.shown(place) : null
    const agent = place?.agent !== undefined
    const changed =
      side !== null &&
      (side.marks[path] !== undefined || (side.changes ?? []).some((one) => one.path === path))
    const items =
      what === 'branch'
        ? branchMenuItems({ agent, name: side?.where?.branch ?? '' })
        : what === 'change'
          ? changeMenuItems({
              uncommitted: side?.marks[path] !== undefined,
              agent,
              diffable: agent,
            })
          : fileMenuItems({
              folder: what === 'folder',
              open: this.wire.state.expanded.includes(path),
              changed,
              agent,
              platform: process.platform,
            })
    return items.map((item) =>
      NOT_FROM_HERE.has(item.id) && item.off === undefined ? { ...item, off: ON_IT_ONLY } : item,
    )
  }

  private async choose(machine: string, what: What, path: string, item: string): Promise<void> {
    const place = this.placeOn(machine)
    if (place === null) return this.say(`${path || 'that'} is on ${machine}, and you have left it`)
    const off = this.items(machine, what, path).find((one) => one.id === item)?.off
    if (off) return this.say(`${off}: ${machine} does that itself`)
    const side = this.deps.shown(place)
    const root = side?.where?.path ?? ''
    switch (item) {
      case 'open':
        return this.open(place, path, { change: false, line: null })
      case 'diff':
      case 'changes':
        if (what === 'branch') return this.firstChange(place)
        return this.open(place, path, { change: true, line: null })
      case 'toggle':
        this.wire.put(toggleFolder(this.wire.state, path))
        this.wire.draw()
        return
      case 'switch':
        return this.branches(place)
      case 'copy':
        if (side?.where?.branch) await this.deps.copy(side.where.branch)
        return
      case 'copy-path':
        if (what === 'branch') {
          if (root) await this.deps.copy(root)
          return
        }
        return this.deps.copy(root ? `${root.replace(/\/$/, '')}/${path}` : path)
      case 'copy-relative':
        return this.deps.copy(path)
      default:
        return this.say(`${item} on ${machine}'s ${what}: ${ON_IT_ONLY}`)
    }
  }

  /** The first change the agent there made, opened as one here is from GIT's Show changes. */
  private firstChange(place: Place): Promise<void> {
    const first = this.deps.shown(place)?.changes?.[0]
    if (!first) {
      this.say(`nothing in ${place.project} on ${place.machine} has changed yet`)
      return Promise.resolve()
    }
    return this.open(place, first.path, { change: true, line: null })
  }

  /** A file there, read and opened in the viewer — as a change, with what git there says of it. */
  private async open(
    place: Place,
    path: string,
    how: { change: boolean; line: number | null },
  ): Promise<void> {
    let read: DiskAnswer
    try {
      read = await this.ask(place, { what: 'file', path, diff: true })
    } catch (err) {
      return this.say(printable(why(err)))
    }
    // You went somewhere else while it was read: nothing on screen is about it.
    if (!samePlace(this.placeOn(place.machine), place) || read.what !== 'file') return
    const file = viewedThere(read)
    this.deps.files().openThere(file, place.machine, {
      line: how.line,
      diff: read.diff === null ? null : parseDiff(read.diff),
      task: place.agent ?? null,
      inline: how.change,
    })
  }

  /** That machine's branches, in the Switch branch panel. */
  private async branches(place: Place): Promise<void> {
    let read: DiskAnswer
    try {
      read = await this.ask(place, { what: 'branches' })
    } catch (err) {
      return this.say(printable(why(err)))
    }
    if (!samePlace(this.placeOn(place.machine), place) || read.what !== 'branches') return
    this.deps.files().branchesThere(
      place.machine,
      read.branches.map((one) => ({
        name: printable(one.name),
        current: one.current,
        when: printable(one.when),
      })),
    )
  }

  /** One read of that machine's disk, as it answered; throws with the sentence where it did not. */
  private async ask(place: Place, ask: Omit<DiskAsk, 'project' | 'agent'>): Promise<DiskAnswer> {
    const reach = this.deps.reach(place.machine)
    if (reach === null || !reach.live) throw new Error(`${place.machine} is not linked right now`)
    const answer = await reach.link.request(place.machine, '/api/disk', {
      project: place.project,
      agent: place.agent ?? null,
      ...ask,
    })
    // The project not open there and a Tade there with no such route answer alike.
    if (answer.status === 404) {
      throw new Error(
        `${place.machine} did not open ${place.project}'s files for this machine — update Tade there if it is older than this one`,
      )
    }
    if (answer.status !== 200) throw new Error(`${place.machine} answered ${answer.status}`)
    const read = DiskAnswerSchema.safeParse(answer.body)
    if (!read.success) throw new Error(`${place.machine} answered with what this Tade cannot read`)
    return read.data
  }

  private say(said: string): void {
    notify(this.wire, said)
    this.wire.draw()
  }
}

/**
 * A file as that machine read it, as the viewer here holds one it read itself:
 * its path and its error reduced to text, and its language worked out here
 * from its name rather than taken from what that machine said.
 */
export function viewedThere(read: Extract<DiskAnswer, { what: 'file' }>): ViewedFile {
  const path = printable(read.path)
  return {
    path,
    size: read.size,
    binary: read.binary,
    truncated: read.truncated,
    language: languageOf(path),
    text: read.text,
    mtimeMs: 0,
    error: read.error === null ? null : printable(read.error),
  }
}

function samePlace(one: Place | null, other: Place): boolean {
  return one !== null && one.project === other.project && one.agent === other.agent
}

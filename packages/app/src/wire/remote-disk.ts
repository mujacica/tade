import { printable } from '@tade/core'
import type { RemoteLink } from '@tade/remotes-core'
import { DISK_MOST, type DiskAnswer, DiskAnswerSchema, type DiskAsk } from '@tade/web'
import { type ParsedDiff, parseDiff } from '../diff.ts'
import { acknowledge } from '../flash.ts'
import { languageOf } from '../highlight.ts'
import { elsewhereOf, type Place } from '../machines.ts'
import { toggleFolder } from '../model.ts'
import type { DiffPanel } from '../panels/diff/state.ts'
import type { FilePanel } from '../panels/file/state.ts'
import {
  branchMenuItems,
  changeMenuItems,
  fileMenuItems,
  type MenuItem,
  type MenuSubject,
} from '../panels/menu/state.ts'
import { type BranchRow, promptPanel } from '../panels/small/state.ts'
import type { SideThere } from '../side.ts'
import type { ViewedFile } from '../viewer.ts'
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
// `branchMenuItems`), and what they change is changed there: a file typed into
// in the viewer is saved there, a change discarded there, its checkout switched
// to a branch, given a new one or pulled there, and the agent's branch renamed
// there — each one ask of that machine's own half (`/api/disk`), which does
// what the same press does here, in the same tree. The panels that ask are
// marked as that machine's and carried out by this file alone
// (`submitsThere`, `promptsThere`), so none of them can reach this machine's
// checkout. A change read as a patch is the patch reader here, marked as that
// machine's (`DiffPanel.there`), each file's diff read there as Show changes
// reads it; asking the agent about a file is typed into the terminal here that
// is that agent's lane there (`RemoteAgents.attach`), unsent, as it is typed
// into an agent here, and a comment on a line of it, or of an agent's file
// opened in the viewer, is kept as one here is and sent to that agent as that
// machine's `steer` (`Comments`). What needs this machine's desktop — an
// editor, a file manager, search — is turned off and said.

type What = Extract<MenuSubject, { kind: 'disk-there' }>['what']

/** The items here that open what only this machine's desktop can. */
const NOT_FROM_HERE: ReadonlySet<string> = new Set(['editor', 'reveal', 'search'])

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An ask of that machine's disk, without where: the place you stand in says that. */
type Asked = DistributiveOmit<DiskAsk, 'project' | 'agent'>

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
        relative: string
      },
    ): void
    branchesThere(machine: string, rows: readonly BranchRow[]): void
    /** The patch reader on that machine's change, each file's diff read there by `read`. */
    patchThere(
      machine: string,
      task: string,
      files: readonly string[],
      at: number,
      read: (path: string) => Promise<ParsedDiff | null>,
    ): void
    /** A comment kept, or a review's sent, from the patch reader or the viewer on a change there (`Comments`). */
    commentThere(panel: FilePanel | DiffPanel, choice: 'comment' | 'send'): Promise<void>
    /** What a file there typed into would hold, and what it was when read: null where nothing is. */
    editedThere(panel: FilePanel): { text: string; size: number; mtimeMs: number } | null
    /** A file there saved and read again, held as what is on that disk now. */
    savedThere(panel: FilePanel, file: ViewedFile, diff: ParsedDiff | null): void
  }
  /** What a write there changed, asked of that machine's side again now rather than on its beat. */
  soon(): void
  /** Something put on the clipboard, said in the strip. */
  copy(text: string): Promise<void>
  /** A terminal in that project there: where the folder under GIT opens, as one here opens in its app. */
  shell(machine: string, project: string): Promise<void>
  /** Typed into the agent there, unsent, in the terminal here that is its lane: opened where none is. */
  tell(place: Place & { agent: string }, text: string): Promise<void>
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
      case 'patch':
        return this.patch(place, path)
      case 'ask':
        return this.askAbout(place, path)
      case 'switch':
        return this.branches(place)
      case 'new':
        return this.prompt(place, 'new-branch', 'New branch', '')
      case 'rename': {
        const branch = side?.where?.branch ?? ''
        return this.prompt(
          place,
          'rename-branch',
          branch ? 'Rename branch' : 'Name the branch',
          branch.replace(/^tade\//, ''),
        )
      }
      case 'pull': {
        const done = await this.write(place, { what: 'pull' })
        if (done.ok) flash(this.wire, `pulled ${side?.where?.branch || 'the branch'} on ${machine}`)
        else notify(this.wire, `pull failed on ${machine}: ${done.said}`)
        this.wire.draw()
        return
      }
      case 'discard':
        this.wire.put({
          ...this.wire.state,
          panel: {
            kind: 'confirm',
            purpose: 'discard',
            task: place.agent ?? null,
            path,
            field: 'keep',
            busy: false,
            error: null,
            there: machine,
          },
        })
        this.wire.draw()
        return
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

  /**
   * The panels that are that machine's, carried out there: a branch switched
   * to or made from Switch branch, a file's changes discarded, a file saved.
   * Only these: the router hands a panel marked `there` to nothing else.
   */
  submitsThere(): Submits {
    return {
      branch: async (panel, choice) => {
        const [verb, ...rest] = (choice ?? '').split(':')
        const name = rest.join(':')
        const place = this.placeOn(panel.there ?? '')
        if (!name) return
        if (place === null) return this.left(panel.there ?? '')
        const done = await this.write(place, { what: 'switch', name, create: verb === 'create' })
        const now = this.wire.state.panel
        if (now?.kind !== 'branch') return
        if (!done.ok) {
          this.wire.put({ ...this.wire.state, panel: { ...now, busy: false, error: done.said } })
          return
        }
        this.wire.put(
          acknowledge(
            { ...this.wire.state, panel: null },
            `${done.said} on ${place.machine}`,
            this.wire.now(),
          ),
        )
      },
      confirm: async (panel) => {
        const place = this.placeOn(panel.there ?? '')
        if (place === null) return this.left(panel.there ?? '')
        const done = await this.write(place, { what: 'discard', path: panel.path })
        const now = this.wire.state.panel
        if (now?.kind !== 'confirm') return
        if (!done.ok) {
          this.wire.put({ ...this.wire.state, panel: { ...now, busy: false, error: done.said } })
          return
        }
        this.wire.put(
          acknowledge(
            { ...this.wire.state, panel: null },
            `${done.said} on ${place.machine}`,
            this.wire.now(),
          ),
        )
      },
      // The patch reader on a change there: commenting for its agent there, and asking it.
      diff: async (panel, choice) => {
        if (choice === 'comment' || choice === 'send') {
          return this.deps.files().commentThere(panel, choice)
        }
        const place = this.placeOn(panel.there ?? '')
        const path = panel.files[panel.file]
        if (choice !== 'ask' || !path) return
        if (place === null || place.agent !== panel.task) return this.left(panel.there ?? '')
        return this.askAbout(place, path)
      },
      file: async (panel, choice) => {
        if (choice === 'save') return this.save(panel)
        // A comment on it, for the agent there whose change it is.
        if (choice === 'comment' || choice === 'send') {
          return this.deps.files().commentThere(panel, choice)
        }
        // Its path is that machine's: copying it is all this window does with it.
        if (choice === 'copy-path') await this.deps.copy(panel.path)
      },
    }
  }

  /** A branch made or renamed on that machine's checkout, from a one-line panel marked as its. */
  promptsThere(): Prompts {
    return {
      'new-branch': async (panel, text) => {
        const done = await this.named(panel.there ?? '', {
          what: 'switch',
          name: text,
          create: true,
        })
        this.wire.put(acknowledge({ ...this.wire.state, panel: null }, done, this.wire.now()))
      },
      'rename-branch': async (panel, text) => {
        const place = this.placeOn(panel.there ?? '')
        const from = (place && this.deps.shown(place)?.where?.branch) ?? ''
        const done = await this.named(panel.there ?? '', { what: 'rename', name: text, from })
        this.wire.put(acknowledge({ ...this.wire.state, panel: null }, done, this.wire.now()))
      },
    }
  }

  /** A one-line panel for a branch there, marked as that machine's. */
  private prompt(
    place: Place,
    purpose: 'new-branch' | 'rename-branch',
    title: string,
    text: string,
  ): void {
    this.wire.put({
      ...this.wire.state,
      panel: {
        ...promptPanel(purpose, `${title} on ${place.machine}`, 'BRANCH NAME', text),
        there: place.machine,
      },
    })
    this.wire.draw()
  }

  /**
   * A branch switched to, made or renamed there, from a one-line panel: what it
   * is on now, or a throw with why not, which the router leaves in the panel.
   */
  private async named(machine: string, ask: Extract<Asked, { name: string }>): Promise<string> {
    const place = this.placeOn(machine)
    if (place === null) throw new Error(`That is on ${machine}, and you have left it.`)
    if (ask.name === '') throw new Error('Name the branch.')
    if (ask.name.startsWith('-')) throw new Error('A branch name does not start with -.')
    const done = await this.ask(place, ask)
    this.deps.soon()
    if (done.what !== 'wrote')
      throw new Error(`${machine} answered with what this Tade cannot read`)
    if (!done.ok) throw new Error(printable(done.said))
    return `${printable(done.said)} on ${machine}`
  }

  /**
   * One write there, as that machine answered it, or why it could not be
   * asked. The side is asked again now, so what it changed is drawn without
   * waiting for the beat.
   */
  private async write(
    place: Place,
    ask: Exclude<Asked, { what: 'file' | 'branches' | 'save' }>,
  ): Promise<{ ok: boolean; said: string }> {
    if ('name' in ask && ask.name.startsWith('-')) {
      return { ok: false, said: 'A branch name does not start with -.' }
    }
    let read: DiskAnswer
    try {
      read = await this.ask(place, ask)
    } catch (err) {
      return { ok: false, said: printable(why(err)) }
    }
    this.deps.soon()
    if (read.what !== 'wrote') {
      return { ok: false, said: `${place.machine} answered with what this Tade cannot read` }
    }
    return { ok: read.ok, said: printable(read.said) }
  }

  /**
   * What was typed into a file there, saved there — over the file as it was
   * read, which that machine checks — and the file read again. Refused, the
   * panel keeps everything typed and says why, as a save here does.
   */
  private async save(panel: FilePanel): Promise<void> {
    const place = this.placeOn(panel.there ?? '')
    if (place === null) return this.left(panel.there ?? '')
    const files = this.deps.files()
    const edited = files.editedThere(panel)
    if (edited === null) return
    const refuse = (said: string) => {
      const now = this.wire.state.panel
      if (now?.kind !== 'file' || now.path !== panel.path) return this.say(said)
      this.wire.put({ ...this.wire.state, panel: { ...now, said, warned: true } })
      this.wire.draw()
    }
    if (edited.text.length > DISK_MOST.file) {
      return refuse(`It is too long to save on ${place.machine} from here.`)
    }
    let read: DiskAnswer
    try {
      read = await this.ask(place, {
        what: 'save',
        path: panel.path,
        text: edited.text,
        was: { size: edited.size, mtimeMs: edited.mtimeMs },
      })
    } catch (err) {
      return refuse(printable(why(err)))
    }
    this.deps.soon()
    if (read.what === 'wrote') return refuse(printable(read.said))
    if (read.what !== 'file') {
      return refuse(`${place.machine} answered with what this Tade cannot read`)
    }
    files.savedThere(panel, viewedThere(read), read.diff === null ? null : parseDiff(read.diff))
  }

  /** Said where a panel of that machine's outlived standing in it. */
  private left(machine: string): void {
    this.say(`That is on ${machine || 'another machine'}, and you have left it.`)
  }

  /**
   * A change there in the patch reader, among every file the agent there has
   * changed, as Read as a patch steps through a task's here. Each file's diff
   * is read there when the reader comes to it.
   */
  private patch(place: Place, path: string): void {
    const task = place.agent
    if (task === undefined) {
      this.say(`no agent on ${place.machine} has that change`)
      return
    }
    const files = (this.deps.shown(place)?.changes ?? []).map((one) => one.path)
    const at = Math.max(0, files.indexOf(path))
    this.deps
      .files()
      .patchThere(place.machine, task, files.length > 0 ? files : [path], at, (one) =>
        this.readPatch(place, one),
      )
  }

  /** What git there says changed in one file, or null with why said. */
  private async readPatch(place: Place, path: string): Promise<ParsedDiff | null> {
    let read: DiskAnswer
    try {
      read = await this.ask(place, { what: 'file', path, diff: true })
    } catch (err) {
      this.say(printable(why(err)))
      return null
    }
    if (read.what !== 'file') {
      this.say(`${place.machine} answered with what this Tade cannot read`)
      return null
    }
    if (read.diff === null) {
      this.say(`git on ${place.machine} could not say what changed in ${printable(path)}`)
      return null
    }
    return parseDiff(read.diff)
  }

  /**
   * A question about a file put in front of the agent there, unsent — typed,
   * as it is into an agent here, because asking costs money and you are the
   * one who presses enter. Its path is that machine's, as text.
   */
  private async askAbout(place: Place, path: string): Promise<void> {
    const agent = place.agent
    if (agent === undefined) return this.say(`no agent on ${place.machine} to ask`)
    this.wire.put({ ...this.wire.state, panel: null })
    await this.deps.tell({ ...place, agent }, `Look at ${printable(path)}: `)
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
      relative: printable(read.relative),
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
  private async ask(place: Place, ask: Asked): Promise<DiskAnswer> {
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
    // A Tade there from before it took writes reads one as an ask it does not know.
    if (answer.status === 400 && ask.what !== 'file' && ask.what !== 'branches') {
      throw new Error(
        `${place.machine} did not take that — update Tade there if it is older than this one`,
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
    // What a save there hands back, for that machine to refuse one over a file
    // that moved since; a Tade there too old to say is one that cannot be saved to.
    mtimeMs: read.mtimeMs ?? 0,
    error: read.error === null ? null : printable(read.error),
  }
}

function samePlace(one: Place | null, other: Place): boolean {
  return one !== null && one.project === other.project && one.agent === other.agent
}

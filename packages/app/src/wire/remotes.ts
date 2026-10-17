import { stat } from 'node:fs/promises'
import {
  AWAKE,
  beat,
  type Config,
  loadConfig,
  machineLabel,
  printable,
  type RemoteConfig,
  type Waking,
} from '@tade/core'
import type { Held, MakeRemoteLink, RemoteLink } from '@tade/remotes-core'
import {
  type LinkWord,
  lineFor,
  linkOf,
  REMOTE_LINKS,
  remoteOf,
  wordOf,
} from '@tade/workbench/remotes'
import type { Frame } from '../frame.ts'
import { goElsewhere, type Machines, machineOf, type Place, skewOf, unheard } from '../machines.ts'
import { notice } from '../model.ts'
import { projectsMenuItems } from '../panels/menu/state.ts'
import { type RemoteShown, remoteActions } from '../panels/settings/remotes.ts'
import type { Ui } from '../screen.ts'
import { remoteStanding } from '../view/standing.ts'
import { projectSays } from '../view/top.ts'
import { Carries, type CarriesDeps } from './carry.ts'
import { configPathOf, type Menus, type Subject, type Wiring } from './context.ts'
import { MACHINE } from './web-panel.ts'

// The window's links to other machines' Tades it is an owner of: one link per
// `remotes.<name>`, held while the window is open (REMOTE-TADE.md §2.5, §5.4).
//
// What it does on the window's beat, and nothing waits on any of it: carry the
// person's last keypress (so the remote does not buzz a phone at them), let the
// links dial what is due and drop what went quiet, and — when the gap between
// two beats says the machine was asleep (`core/src/sleep.ts`'s rule, the one
// the agents are woken by) — tell every link to let go and dial again now.
//
// **What it writes down is transitions** (`remote_linked`, `remote_unlinked`):
// up, down, ended, each once, never a line per redial. A remote that signed
// this machine out is also said in the strip, because that is the one thing
// about a link a person has to do something about.
//
// **It follows `remotes` in the file as well as in memory.** `tade remote add`
// writes the config from a shell, and a remote added with a window open should
// link without anybody restarting it, so each beat asks the file's modified
// time — one `stat` — and reads it again only when it moved. Nothing else in
// the config is taken from that read: every other key is still the window's
// own to apply (`Settings.use`), and this is the one reader of this one.
//
// **And it keeps this machine's setup in step there** (`carry.ts`): a carry
// when a link comes up, when the config moves, and hourly, and the presses on
// Settings › Remotes — which is the page this subject draws.
//
// **What each remote holds is drawn as its projects** (`facts`, folded by
// `machines.ts`, which is where everything another machine wrote is reduced
// to text): a tab per project under the machine's name, its agents down the
// side, and a row on the Spend page. Folded again only when a link's held
// value moved, because the frame asks four times a second.

/** What the links need of the window, named once so a test can hand it over. */
export interface RemotesDeps {
  home: string
  /** The remotes as the window's config has them now. */
  remotes: () => Readonly<Record<string, RemoteConfig>>
  /** Where the config is, so a remote added from a shell is seen. */
  configPath: string
  /** When somebody last pressed a key in this window. */
  lastInputAt: () => number | null
  now: () => number
  /** One line for the journal. */
  log: (told: {
    type: 'remote_linked' | 'remote_unlinked' | 'remote_carried'
    detail: Record<string, string | number>
  }) => Promise<void>
  /** Said in the strip, where somebody has to act. */
  say: (said: string) => void
  /** The registry, or a test's. */
  links?: Readonly<Record<string, MakeRemoteLink>>
  /** What carrying this machine's setup there needs beyond the links. */
  carrying: Pick<CarriesDeps, 'config' | 'secrets' | 'from' | 'onScreenWith' | 'said' | 'draw'>
  /** Whether Settings is open, so its Remotes page is drawn. */
  settingsOpen: () => boolean
  /** What this machine is called in a sentence: `this Mac`. */
  here: string
  /** Stand in a project on another machine. */
  go: (place: Place) => void
  /** Something a remote holds moved: a frame, to draw it. */
  draw: () => void
}

export class Remotes implements Subject {
  private readonly deps: RemotesDeps
  /** One link per kind in use, made the first time a remote needs it. */
  private readonly links = new Map<string, RemoteLink>()
  /** Which kind of link holds each remote, by its name in the registry. */
  private readonly holder = new Map<string, string>()
  /** The word each remote was last written down as, so a line goes only on a change. */
  private readonly words = new Map<string, LinkWord>()
  /** The remotes read out of the file, once it has moved since the window opened. */
  private fromFile: Readonly<Record<string, RemoteConfig>> | null = null
  private fileAt: number | null = null
  private reading = false
  private waking: Waking = AWAKE
  /** The remotes no registered link reaches, each said once. */
  private readonly unreachable = new Set<string>()
  /** What reading the file last said went wrong, so it is said once and not every beat. */
  private trouble: string | null = null
  private stopped = false
  /** This machine's setup, kept in step on each remote (`carry.ts`). */
  private readonly carries: Carries
  /** The machines as last folded, and the held values they were folded from. */
  private folded: {
    names: readonly string[]
    helds: readonly (Held | null)[]
    machines: Machines
  } | null = null
  /** How far this clock is ahead of each remote's, as of the projection it was told with. */
  private readonly skews = new Map<string, { projection: object; skew: number }>()

  constructor(deps: RemotesDeps) {
    this.deps = deps
    this.carries = new Carries({
      ...deps.carrying,
      home: deps.home,
      configPath: deps.configPath,
      reach: (name) => this.reach(name),
      log: (line) => deps.log(line),
      say: (said) => deps.say(said),
      now: deps.now,
    })
  }

  /** Every remote's projects, for the top row, the side and Spend — and nothing where there are none. */
  facts(): Partial<Frame> {
    const machines = this.machines()
    return machines.remotes.length === 0 ? {} : { machines }
  }

  /** A machine's name along the top opens its projects; choosing one stands in it. */
  menus(): Menus {
    return {
      machine: {
        title: (subject) => subject.machine,
        items: (subject) => {
          const machine = this.machines().remotes.find((one) => one.name === subject.machine)
          if (machine === undefined) return []
          if (machine.projects.length === 0) {
            const why = machine.heard ? 'no project is open there' : 'nothing heard from it yet'
            return [{ id: '', label: machine.said ?? why, off: why }]
          }
          const now = this.deps.now()
          return projectsMenuItems(
            machine.projects.map((project) => ({
              project: project.name,
              label: project.title ?? project.name,
              says: projectSays(remoteStanding(project), now),
            })),
          )
        },
        choose: (subject, project) => {
          if (project !== '') this.deps.go({ machine: subject.machine, project })
        },
      },
    }
  }

  /** What every remote holds, folded, in the order the config names them. */
  machines(): Machines {
    const names = Object.keys(this.fromFile ?? this.deps.remotes())
    const helds = names.map(
      (name) => this.links.get(this.holder.get(name) ?? '')?.held(name) ?? null,
    )
    const was = this.folded
    if (
      was !== null &&
      was.names.length === names.length &&
      was.names.every((name, at) => name === names[at]) &&
      was.helds.every((held, at) => held === helds[at])
    )
      return was.machines
    const machines: Machines = {
      here: this.deps.here,
      remotes: names.map((name, at) => {
        const held = helds[at] ?? null
        if (held !== null) return machineOf(held, this.skewFor(name, held))
        return unheard(name, this.unreachable.has(name) ? 'no link here can reach it' : null)
      }),
    }
    this.folded = { names, helds, machines }
    return machines
  }

  /** How far apart the two clocks are, asked once per projection (`skewOf`). */
  private skewFor(name: string, held: Held): number {
    const kept = this.skews.get(name)
    if (held.projection === null || kept?.projection === held.projection) return kept?.skew ?? 0
    const skew = skewOf(held) ?? kept?.skew ?? 0
    this.skews.set(name, { projection: held.projection, skew })
    return skew
  }

  /** What the Remotes page draws, while Settings is open. */
  panel(): Frame['panel'] {
    return this.deps.settingsOpen() ? { remotes: this.shown() } : {}
  }

  inputs() {
    return this.deps.settingsOpen() ? { remoteActions: remoteActions(this.shown()) } : {}
  }

  /** A press on the Remotes page. */
  action(choice: string): Promise<void> {
    return this.carries.action(choice)
  }

  private shown(): RemoteShown[] {
    const remotes = this.fromFile ?? this.deps.remotes()
    return this.carries.shown(
      Object.entries(remotes).map(([name, one]) => {
        const held = this.reach(name)
        return {
          name,
          address: one.ssh,
          link: linkSaid(
            held === null
              ? null
              : (this.links.get(this.holder.get(name) ?? '')?.held(name) ?? null),
          ),
          live: held?.live === true,
        }
      }),
    )
  }

  /** The link holding one remote, the remote as opened, and whether it is up. */
  private reach(name: string) {
    const kind = this.holder.get(name)
    const link = kind === undefined ? undefined : this.links.get(kind)
    const config = (this.fromFile ?? this.deps.remotes())[name]
    if (link === undefined || config === undefined) return null
    return {
      link,
      remote: remoteOf(name, config),
      live: link.held(name)?.link.kind === 'live',
    }
  }

  /** The window's beat. Returns at once. */
  beat(): void {
    if (this.stopped) return
    const now = this.deps.now()
    this.follow(this.fromFile ?? this.deps.remotes())
    this.waking = beat(this.waking, now)
    const woke = this.waking.slept !== null
    for (const link of this.links.values()) {
      link.present(this.deps.lastInputAt())
      if (woke) link.wake(now)
      link.beat(now)
    }
    this.carries.beat([...this.holder.keys()])
    void this.reread()
  }

  /** What is held for every remote, in the order they were opened. */
  held(): Held[] {
    const all: Held[] = []
    for (const link of this.links.values()) {
      for (const name of link.names()) {
        const held = link.held(name)
        if (held !== null) all.push(held)
      }
    }
    return all
  }

  /** Every link closed. Safe twice. */
  async stop(): Promise<void> {
    this.stopped = true
    await Promise.all([...this.links.values()].map((link) => link.shutdown()))
  }

  /** Open what the config names, and close what it no longer does. */
  private follow(remotes: Readonly<Record<string, RemoteConfig>>): void {
    for (const [name, kind] of this.holder) {
      const still = remotes[name]
      if (still !== undefined && linkOf(still) === kind) continue
      this.holder.delete(name)
      this.words.delete(name)
      this.skews.delete(name)
      this.carries.forget(name)
      void this.links.get(kind)?.close(name)
    }
    for (const [name, config] of Object.entries(remotes)) {
      const kind = linkOf(config)
      const link = this.linkFor(kind)
      if (link === null) {
        // Named once, never skipped in silence: a remote nothing here can reach.
        if (!this.unreachable.has(name))
          this.deps.say(`${name} is reached by a link this Tade does not have (${kind})`)
        this.unreachable.add(name)
        continue
      }
      this.unreachable.delete(name)
      this.holder.set(name, kind)
      link.open(remoteOf(name, config))
    }
  }

  private linkFor(kind: string): RemoteLink | null {
    const held = this.links.get(kind)
    if (held !== undefined) return held
    const make = (this.deps.links ?? REMOTE_LINKS)[kind]
    if (make === undefined) return null
    const link = make({ home: this.deps.home, now: this.deps.now })
    link.watch((name) => this.changed(link, name))
    this.links.set(kind, link)
    return link
  }

  private changed(link: RemoteLink, name: string): void {
    const held = link.held(name)
    this.deps.draw()
    if (held !== null) {
      const word = wordOf(held)
      if (word !== null && word !== this.words.get(name)) {
        this.words.set(name, word)
        const line = lineFor(held, word)
        this.deps.log(line).catch((err: unknown) => {
          this.deps.say(`the link to ${name} could not write ${line.type} down: ${String(err)}`)
        })
        if (word === 'ended' && held.link.kind === 'ended') {
          // The remote's own words, as text: nothing it wrote reaches the terminal as it came.
          this.deps.say(`${name} signed this machine out: ${printable(held.link.said)}`)
        }
        if (word === 'up') this.carries.up(name)
      }
    }
  }

  /** The file's remotes, read again only when the file moved. */
  private async reread(): Promise<void> {
    if (this.reading) return
    this.reading = true
    try {
      const at = (await stat(this.deps.configPath)).mtimeMs
      if (this.fileAt === null) this.fileAt = at
      if (at === this.fileAt) return
      this.fileAt = at
      const loaded = await loadConfig(this.deps.configPath)
      // A file that does not load keeps the remotes as they were, and says so.
      if (loaded.ok) this.fromFile = loaded.config.remotes
      // Edited by hand is changed all the same: carried on the next beat.
      if (loaded.ok) this.carries.moved()
      this.troubled(
        loaded.ok
          ? null
          : `the config would not load (${loaded.issues[0]?.message ?? 'no reason given'}), so the remotes stay as they were`,
      )
    } catch (err) {
      // No file is no change: the window's own config stands. Anything else is said.
      const code = (err as NodeJS.ErrnoException).code
      this.troubled(
        code === 'ENOENT'
          ? null
          : `the remotes could not be read again from the config: ${String(err)}`,
      )
    } finally {
      this.reading = false
    }
  }

  /** Said once for as long as it stays the same trouble, and forgotten once it has gone. */
  private troubled(said: string | null): void {
    if (said !== null && said !== this.trouble) this.deps.say(said)
    this.trouble = said
  }
}

/**
 * How a link stands, in the few words the Remotes page has for it. Why it is
 * down can be the remote's own words — a `notice` frame's, or a parser's quote
 * of what it sent — so it is drawn as text and nothing else (`printable`).
 */
function linkSaid(held: Held | null): string {
  if (held === null) return 'not linked'
  const link = held.link
  if (link.kind === 'live') return '● linked'
  if (link.kind === 'down') return `○ down · ${printable(link.said)}`
  if (link.kind === 'ended') return `○ signed out there · ${printable(link.said)}`
  return '· linking…'
}

/** The window's remotes, read off its wiring. */
export function remotesFor(
  wire: Wiring,
  onScreenWith: (flow: (ui: Ui) => Promise<void>) => Promise<void>,
): Remotes {
  return new Remotes({
    carrying: {
      config: (): Config => wire.opts.config,
      secrets: () => new Set((wire.opts.extensions?.secrets() ?? []).map((one) => one.path)),
      from: () => machineLabel(),
      onScreenWith,
      said: (saved, error) => {
        const panel = wire.state.panel
        if (panel?.kind === 'settings')
          wire.put({ ...wire.state, panel: { ...panel, saved, error } })
        else if (error !== null) wire.put(notice(wire.state, error, wire.now()))
        wire.draw()
      },
      draw: () => wire.draw(),
    },
    settingsOpen: () => wire.state.panel?.kind === 'settings',
    here: MACHINE,
    go: (place) => {
      wire.put(goElsewhere(wire.state, place))
      wire.draw()
    },
    draw: () => wire.draw(),
    home: wire.opts.home,
    remotes: () => wire.opts.config.remotes,
    configPath: configPathOf(wire.opts),
    lastInputAt: () => wire.state.lastInputAt,
    now: () => wire.now(),
    log: async (told) => {
      await wire.opts.client.log.append(told)
    },
    say: (said) => {
      wire.put(notice(wire.state, said, wire.now()))
      wire.draw()
    },
  })
}

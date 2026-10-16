import { stat } from 'node:fs/promises'
import { AWAKE, beat, loadConfig, type RemoteConfig, type Waking } from '@tade/core'
import type { Held, MakeRemoteLink, RemoteLink } from '@tade/remotes-core'
import {
  type LinkWord,
  lineFor,
  linkOf,
  REMOTE_LINKS,
  remoteOf,
  wordOf,
} from '@tade/workbench/remotes'
import { notice } from '../model.ts'
import { configPathOf, type Wiring } from './context.ts'

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
    type: 'remote_linked' | 'remote_unlinked'
    detail: Record<string, string>
  }) => Promise<void>
  /** Said in the strip, where somebody has to act. */
  say: (said: string) => void
  /** The registry, or a test's. */
  links?: Readonly<Record<string, MakeRemoteLink>>
}

export class Remotes {
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

  constructor(deps: RemotesDeps) {
    this.deps = deps
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
    if (held !== null) {
      const word = wordOf(held)
      if (word !== null && word !== this.words.get(name)) {
        this.words.set(name, word)
        const line = lineFor(held, word)
        this.deps.log(line).catch((err: unknown) => {
          this.deps.say(`the link to ${name} could not write ${line.type} down: ${String(err)}`)
        })
        if (word === 'ended' && held.link.kind === 'ended') {
          this.deps.say(`${name} signed this machine out: ${held.link.said}`)
        }
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

/** The window's remotes, read off its wiring. */
export function remotesFor(wire: Wiring): Remotes {
  return new Remotes({
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

import { readFile } from 'node:fs/promises'
import {
  type CarryLine,
  changesIn,
  machineLabel,
  pinnedIn,
  registersHere,
  type SyncState,
  type SyncSummary,
  settingDigest,
  syncSaid,
  syncStateOf,
  textOf,
} from '@tade/core'
import { LinkError, type Remote, type RemoteLink } from '@tade/remotes-core'
import type { WebFeeds } from '@tade/web'
import {
  answerFeeds,
  Feeds as FeedStore,
  type FeedsAsk,
  FeedsRefused,
  type FeedsShared,
  type Forked,
  type MachineNamed,
  shareFeeds,
} from '@tade/workbench/feeds'
import { sumOf } from '@tade/workbench/notes-shared'
import { parse as parseYaml } from 'yaml'
import { configPathOf, type Wiring } from './context.ts'
import { seenName } from './machines-seen.ts'

// Every machine's journal kept on every machine of the person's, from the
// window (`@tade/workbench`'s `feeds.ts` is the store and the exchange): the
// far half answered by the heart, so a `tade serve` hub with no screen keeps
// the Mac's journal and hands it on; the near half run for each machine this
// window links to.
//
// **When it shares, by itself**: when a link comes up; when this machine's
// own journal grew a line that travels, at most every `MOVED_EVERY_MS`; and
// every `AGAIN_MS` while a link is up, which is what brings another machine's
// lines here — and a third machine's, relayed through it. Where both sides
// already hold the same lines that is one request and its close.
//
// **Where two machines stand is the state hash** over feeds, notes and kept
// settings (`syncStateOf`): kept beside the other machine's copy
// (`sync.json`) for `tade machines`, drawn on Settings › Machines and the
// phone's Machines page, and written down (`remote_synced`) only when the word
// changes. A fork is written down (`feed_forked`) and said once.
//
// **Nothing waits on it.** One exchange at a time per remote, from the beat,
// never awaited by anything that draws.

/** How long a linked machine goes before its journal is looked at again anyway. */
const AGAIN_MS = 60_000

/** How soon after this machine's own journal moved it is offered again, at most. */
const MOVED_EVERY_MS = 15_000

/** The far side's door for it (`@tade/web`'s `shared-feeds.ts`). */
const DOOR = '/api/feeds/share'

/** Where this machine and another last stood, as every screen draws it. */
export interface FleetSync {
  /** Its name here, or what it calls itself for a machine that links here. */
  name: string
  id: string
  way: 'to' | 'from'
  state: SyncState
  /** In words: `in step`, `behind by 3 lines`, `1 conflict`. */
  said: string
}

export interface FleetFeedsDeps {
  home: string
  configPath: () => string
  /** Who this machine is, as its workbench opened it, and what it calls itself (`machineLabel`). */
  machine: () => { id: string; epoch: { id: string; at: string } }
  name: () => string
  /** The person's notes here: their digests, for the state hash. */
  notes: () => readonly string[]
  /** Paths the loaded extensions declared as keys. */
  secrets: () => ReadonlySet<string>
  /** Every line of some kinds in this machine's journal, oldest first. */
  lines: (
    types: ('config_changed' | 'settings_conflict' | 'remote_synced')[],
  ) => Promise<readonly CarryLine[]>
  log: (line: {
    type: 'feed_forked' | 'remote_synced'
    detail: Record<string, string | number>
  }) => Promise<void>
  /** Said in the strip, once per trouble. */
  say: (said: string) => void
  draw: () => void
  now: () => number
}

/** One machine's journal, linked: what the near half needs of each remote. */
export type FeedsReach = (
  name: string,
) => { link: RemoteLink; remote: Remote; live: boolean } | null

export class FleetFeeds {
  private readonly deps: FleetFeedsDeps
  private store: Promise<FeedStore> | null = null
  /** The store, once it has opened: what a beat looks at without waiting. */
  private opened: FeedStore | null = null
  /** When each remote's journal was last shared, or last could not be. */
  private readonly at = new Map<string, number>()
  private readonly busy = new Set<string>()
  private readonly owed = new Set<string>()
  private readonly troubled = new Map<string, string>()
  /** Where each machine last stood, by its id: what is drawn. */
  private readonly stood = new Map<string, FleetSync>()
  /** The word last written down per machine id, so a line goes only on a change. */
  private readonly words = new Map<string, string>()
  private wordsRead: Promise<void> | null = null
  /** Forks already said, so each is said once. */
  private readonly told = new Set<string>()
  /** This machine's own journal's length, as the last share saw it. */
  private ownAt = -1
  private ownMovedAt = 0

  constructor(deps: FleetFeedsDeps) {
    this.deps = deps
  }

  /** The store, opened the first time it is needed: this machine's own journal is read through then. */
  feeds(): Promise<FeedStore> {
    if (this.store === null) {
      const machine = this.deps.machine()
      this.store = FeedStore.open(this.deps.home, { ...machine, name: this.deps.name() })
      // One that would not open is tried again next time, and said.
      this.store.then(
        (feeds) => {
          this.opened = feeds
        },
        (err: unknown) => {
          this.store = null
          this.troubles('', `Other machines' journals could not be read here: ${why(err)}`)
        },
      )
    }
    return this.store
  }

  /** Where each machine last stood, as drawn. */
  synced(): FleetSync[] {
    return [...this.stood.values()]
  }

  /** Where one machine this window links to last stood, by its name here. */
  syncedWith(name: string): FleetSync | null {
    return [...this.stood.values()].find((one) => one.way === 'to' && one.name === name) ?? null
  }

  /** What every machine's state hash and its other channels sum to here, for a summary. */
  async extras(): Promise<Omit<SyncSummary, 'feeds'>> {
    let written: unknown = {}
    try {
      written = parseYaml(await readFile(this.deps.configPath(), 'utf8')) ?? {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const changes = changesIn(await this.deps.lines(['config_changed']))
    const settings: Record<string, string> = {}
    for (const [path, register] of registersHere(written, changes, this.deps.secrets())) {
      if (register.value === undefined) continue
      settings[path] = settingDigest(textOf(register.value))
    }
    return { notes: sumOf(this.deps.notes()), settings, pinned: pinnedIn(written) }
  }

  // ── The far half ────────────────────────────────────────────────────────

  /** The heart's `WebFeeds`: another machine's exchange answered here. */
  web(): WebFeeds {
    return async (body, _device, label) =>
      answerFeeds(await this.feeds(), body as FeedsAsk, {
        extras: () => this.extras(),
        now: this.deps.now(),
        forked: (fork) => this.forked(fork),
        synced: (peer, here, there) =>
          this.stand(peer, here, there, {
            way: 'from',
            name: peer.name,
            label: seenName(label),
            forks: 0,
          }),
      })
  }

  // ── The near half ───────────────────────────────────────────────────────

  /** A link came up: share with it on the next beat. */
  up(name: string): void {
    this.owed.add(name)
  }

  /** A remote is gone: what was held for it here goes with it; its copy stays, as history. */
  forget(name: string): void {
    this.at.delete(name)
    this.owed.delete(name)
    this.troubled.delete(name)
    for (const [id, one] of this.stood)
      if (one.way === 'to' && one.name === name) this.stood.delete(id)
  }

  /**
   * The window's beat: each linked remote shared with where it is owed. Returns
   * at once — the promise is what it started, which nothing that draws awaits.
   */
  beat(names: readonly string[], reach: FeedsReach): Promise<void> {
    const started: Promise<unknown>[] = []
    const now = this.deps.now()
    const moved = this.ownMoved(now)
    for (const name of names) {
      const held = reach(name)
      if (held === null || !held.live || this.busy.has(name)) continue
      const last = this.at.get(name)
      const due =
        last === undefined || now - last >= AGAIN_MS || (moved && now - last >= MOVED_EVERY_MS)
      if (!this.owed.has(name) && !due) continue
      this.owed.delete(name)
      started.push(this.share(name, reach))
    }
    return Promise.all(started).then(() => {})
  }

  /** Whether this machine's own journal grew a line that travels since the last share. */
  private ownMoved(now: number): boolean {
    const feeds = this.opened
    if (feeds === null) return false
    void feeds.own.catchUp().then(
      () => {
        if (feeds.own.n === this.ownAt) return
        this.ownAt = feeds.own.n
        this.ownMovedAt = now
      },
      (err: unknown) =>
        this.troubles(
          'own',
          `This machine's own journal could not be read for the others: ${why(err)}`,
        ),
    )
    return this.ownMovedAt > 0 && now - this.ownMovedAt < AGAIN_MS
  }

  /** One exchange with one remote: what came of it, or null where none could be made. Never throws. */
  async share(name: string, reach: FeedsReach): Promise<FeedsShared | null> {
    const held = reach(name)
    if (held === null || this.busy.has(name)) return null
    this.busy.add(name)
    try {
      const feeds = await this.feeds()
      const done = await shareFeeds(feeds, (body) => held.link.request(name, DOOR, body), {
        name,
        extras: () => this.extras(),
        now: this.deps.now,
      })
      for (const fork of done.forks) await this.forked(fork)
      await this.stand(done.there, done.here, done.thereSummary, {
        way: 'to',
        name,
        forks: done.forks.length,
        took: done.took,
        gave: done.gave,
      })
      this.troubles(
        name,
        done.refused.length > 0 ? `${name}: ${done.refused.join('; ')}` : leftSays(name, done),
      )
      return done
    } catch (err) {
      // A link that went down is the link's news; anything else is this exchange's.
      const down = err instanceof LinkError && !(err instanceof FeedsRefused)
      if (!down || reach(name)?.live === true) {
        this.troubles(name, `${name}'s journal is not kept here: ${why(err)}`)
      }
      return null
    } finally {
      this.at.set(name, this.deps.now())
      this.busy.delete(name)
    }
  }

  /**
   * Where this machine and another stand, from both summaries: drawn, kept
   * beside that machine's copy, and written down where the word changed or a
   * feed forked. Returns the state, for the far half's answer.
   */
  private async stand(
    peer: MachineNamed,
    here: SyncSummary,
    there: SyncSummary,
    how: {
      way: 'to' | 'from'
      name: string
      label?: string
      forks: number
      took?: number
      gave?: number
    },
  ): Promise<SyncState> {
    const lines = await this.deps.lines(['settings_conflict', 'remote_synced'])
    const conflicts = conflictsSince(lines, how.name)
    const state = syncStateOf(here, there, { forks: how.forks, conflicts, at: this.deps.now() })
    const said = syncSaid(state)
    this.stood.set(peer.id, { name: how.name, id: peer.id, way: how.way, state, said })
    this.deps.draw()
    const feeds = await this.feeds()
    await feeds
      .keepSync(peer, {
        id: peer.id,
        name: peer.name,
        ...(how.way === 'to' ? { called: how.name } : {}),
        ...(how.label === undefined ? {} : { label: how.label }),
        way: how.way,
        state,
      })
      .catch((err: unknown) =>
        this.troubles(
          `keep ${peer.id}`,
          `Where this machine and ${how.name} stand could not be kept for \`tade machines\`: ${why(err)}`,
        ),
      )
    await this.readWords(lines)
    if (this.words.get(peer.id) !== state.word || how.forks > 0) {
      this.words.set(peer.id, state.word)
      await this.deps
        .log({
          type: 'remote_synced',
          detail: {
            with: how.name,
            id: peer.id,
            way: how.way,
            word: state.word,
            said,
            behind: state.behind,
            ahead: state.ahead,
            took: how.took ?? 0,
            gave: how.gave ?? 0,
            forks: how.forks,
            conflicts: state.conflicts,
            differ: state.differ.join(' '),
          },
        })
        .catch((err: unknown) =>
          this.deps.say(
            `Where this machine and ${how.name} stand is not written down here: ${why(err)}`,
          ),
        )
    }
    return state
  }

  /** The word each machine was last written down as, read from the journal once a window. */
  private readWords(lines: readonly CarryLine[]): Promise<void> {
    if (this.wordsRead === null) {
      for (const line of lines) {
        if (line.type !== 'remote_synced') continue
        const id = line.detail?.id
        const word = line.detail?.word
        if (typeof id === 'string' && typeof word === 'string') this.words.set(id, word)
      }
      this.wordsRead = Promise.resolve()
    }
    return this.wordsRead
  }

  /** A fork found here, written down and said once. */
  private async forked(fork: Forked): Promise<void> {
    const key = `${fork.machine} ${fork.epoch} ${fork.why} ${fork.kept ?? fork.from}`
    if (this.told.has(key)) return
    this.told.add(key)
    const kept = fork.kept === null ? 'here' : fork.kept
    await this.deps
      .log({
        type: 'feed_forked',
        detail: {
          machine: fork.machine,
          name: fork.name,
          epoch: fork.epoch,
          why: fork.why,
          kept,
          from: fork.from,
        },
      })
      .catch((err: unknown) =>
        this.deps.say(`A fork of ${fork.name}'s journal is not written down here: ${why(err)}`),
      )
    this.deps.say(forkSays(fork))
  }

  /** Said once for as long as it stays the same trouble, and forgotten once it has gone. */
  private troubles(key: string, said: string | null): void {
    if (said === null) this.troubled.delete(key)
    else if (this.troubled.get(key) !== said) {
      this.troubled.set(key, said)
      this.deps.say(said)
    }
  }
}

/** A fork, in the words the strip says it once. */
export function forkSays(fork: Forked): string {
  if (fork.kept === null) {
    return `${fork.from} holds a different history of ${fork.name}'s journal than this machine: the copy here is kept, and ${fork.name} itself settles it when it is next heard.`
  }
  return fork.why === 'epoch'
    ? `${fork.name}'s journal began a new life (a restore): the copy of the old one is kept at ${fork.kept}.`
    : `${fork.name}'s journal and the copy here disagree: the copy is kept at ${fork.kept}, and ${fork.name}'s own is taken from the start.`
}

/** Settings both machines changed apart, settled since the two were last in step. */
export function conflictsSince(lines: readonly CarryLine[], name: string): number {
  let n = 0
  for (const line of lines) {
    if (line.detail?.with !== name) continue
    if (line.type === 'remote_synced' && line.detail.word === 'in step') n = 0
    else if (line.type === 'settings_conflict') n++
  }
  return n
}

/** What lines left unshared come to, in words: null for none. */
function leftSays(name: string, done: FeedsShared): string | null {
  if (done.left === 0) return null
  return `Not every journal line between this machine and ${name} went across yet: the rest go at the next exchange`
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The heart's journals of other machines, read off its wiring. */
export function fleetFeedsFor(wire: Wiring, say: (said: string) => void): FleetFeeds {
  return new FleetFeeds({
    home: wire.opts.home,
    configPath: () => configPathOf(wire.opts),
    machine: () => wire.opts.client.machine,
    name: () => machineLabel(),
    notes: () => wire.opts.client.memory.shared().map((one) => one.digest),
    secrets: () => new Set((wire.opts.extensions?.secrets() ?? []).map((one) => one.path)),
    lines: (types) => wire.opts.client.events({ types }),
    log: async (line) => {
      await wire.opts.client.log.append(line)
    },
    say,
    draw: () => wire.draw(),
    now: () => wire.now(),
  })
}

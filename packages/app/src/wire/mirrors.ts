import {
  type BranchThere,
  type Elsewhere,
  fetchDue,
  formerLabel,
  liveThere,
  machineLabel,
  machineNameByDefault,
  mirrorDir,
  mirrorMachine,
  printable,
  sameRepository,
} from '@tade/core'
import type { Held, Remote, RemoteLink } from '@tade/remotes-core'
import {
  dropFromMirror,
  fetchMirror,
  headsHere,
  mirrorHeads,
  pushMirror,
  repositoryAt,
} from '@tade/status'
import { RepositoriesAnswerSchema } from '@tade/web'

// Other machines' work in this machine's projects, kept in a mirror of each
// in this home (core's `elsewhere.ts` has the
// rules, status's `mirror.ts` the git).
//
// **Where one repository is a project here and on a remote**, by the name its
// `origin` gives it on each machine (`repositoryNamed`, never a project's
// name), the remote's branches are fetched over the link this window already
// holds to it (`RemoteLink.repository`) into that project's mirror. Then the
// conflict forecast merges this machine's live branches with that one's there
// (`elsewhere()`, handed to status with every look). Nothing is written into
// the person's checkout: the mirror only reads it.
//
// **Asking is cheap and fetching is rare.** Where a remote's work is, is one
// small owner's request (`/api/repositories`) over the held link: when the
// link comes up, when its projection moves — no oftener than `SOONEST_MS` —
// and every `AGAIN_MS` anyway. A fetch happens only when one of its branches
// is on a commit the mirror does not hold (`fetchDue`), so a quiet remote is
// one request now and then and no git at all.
//
// **Nothing waits on it.** One look at a time per remote and one fetch at a
// time per mirror, started from the beat and never awaited by anything that
// draws; every wait is the link's or git's, each with its deadline. What could
// not be done is said once in the strip for as long as it stays the same
// trouble, and what was fetched before stands meanwhile: a remote that cannot
// be asked is not a remote with no branches.
//
// **And the other way, into the remote's own mirror.** A remote that says
// where its mirror of the project is (`RepositoryHere.mirror`) is handed this
// machine's branches there, under this machine's name, over the same link —
// because it cannot dial this machine, and an agent's commits here that never
// reached origin are what it needs to keep its checkout in step
// (`project-sync.ts`). Only when a branch here moved since the last push. A
// fetch that brought a remote's heads here pokes this machine's own sync.

/** How long a linked remote goes before where its work is, is asked again anyway. */
export const AGAIN_MS = 2 * 60_000

/** The least time between two asks of one remote, however often its projection moves. */
export const SOONEST_MS = 15_000

/** The far side's door for it (`@tade/web`'s `repositories.ts`). */
const DOOR = '/api/repositories'

/** One remote project mirrored into one of this machine's. */
interface There {
  machine: string
  /** Its name there. */
  project: string
  /** The branch its work merges into there. */
  base: string | null
  branches: readonly BranchThere[]
}

/** What one project here holds of other machines: its mirror, and what is in it. */
interface Mirrored {
  mirror: string
  there: readonly There[]
  /** Every head the mirror holds, of every machine, by ref. */
  heads: ReadonlyMap<string, string>
}

export interface MirrorsDeps {
  home: string
  /** The link that holds a remote and the remote as it was opened, or null for none held. */
  reach: (name: string) => { link: RemoteLink; remote: Remote; live: boolean } | null
  /** This machine's projects and where each is checked out, as status last looked. */
  projects: () => readonly { name: string; root: string }[]
  /** What names a checkout's repository (`repositoryAt`), or a test's. */
  named?: (root: string) => Promise<string | null>
  /** Said in the strip: what could not be read or fetched, once per trouble. */
  say: (said: string) => void
  now: () => number
  /** What the mirrors hold moved: a frame, to draw what reads it. */
  draw: () => void
  /** A remote's branches in one project's mirror moved: its branch here is looked at again (`ProjectSync.poke`). */
  fetched?: (project: string) => void
  /** This machine's name in another machine's mirror (`mirrorMachine`); its host name made one by default. */
  as?: () => string
}

export class Mirrors {
  private readonly deps: MirrorsDeps
  /** When each remote was last asked, or last could not be. */
  private readonly at = new Map<string, number>()
  private readonly owed = new Set<string>()
  private readonly busy = new Set<string>()
  /** Each remote's projection revision as last heard, so only a move is owed a look. */
  private readonly revs = new Map<string, number | null>()
  /** What each remote's last look could not do, so it is said once. */
  private readonly troubled = new Map<string, string>()
  /** The remotes that have said, since the window opened, which of their projects are which repository. */
  private readonly answered = new Set<string>()
  /** By project here. */
  private readonly held = new Map<string, Mirrored>()
  /** One fetch at a time into each mirror, whichever machine it is from. */
  private readonly turns = new Map<string, Promise<unknown>>()
  /** Each remote's look going on now, so one asked to look again waits for it rather than for nothing. */
  private readonly looking = new Map<string, Promise<void>>()
  /** This machine's branches as last pushed into each remote's mirror of each project, by remote and project. */
  private readonly pushed = new Map<string, string>()
  /** The mirrors this machine's branches under its former name were taken out of, this time Tade is open. */
  private readonly dropped = new Set<string>()
  private handed: Readonly<Record<string, Elsewhere>> | null = null

  constructor(deps: MirrorsDeps) {
    this.deps = deps
  }

  /** A link came up: asked on the next beat. */
  up(name: string): void {
    this.owed.add(name)
  }

  /** What a remote holds moved: asked again, soon, where its projection did. */
  moved(name: string, held: Held): void {
    // Read for its shape, as everything another machine wrote is (`machines.ts`).
    const fresh = held.projection?.fresh as { rev?: unknown } | undefined
    const rev = typeof fresh?.rev === 'number' ? fresh.rev : null
    if (this.revs.has(name) && this.revs.get(name) !== rev) this.owed.add(name)
    this.revs.set(name, rev)
  }

  /** A remote is gone: what was held of it goes with it, and its branches leave every mirror's answer. */
  forget(name: string): void {
    this.at.delete(name)
    this.owed.delete(name)
    this.revs.delete(name)
    this.troubled.delete(name)
    this.answered.delete(name)
    for (const [project, mirrored] of this.held) {
      this.held.set(project, {
        ...mirrored,
        there: mirrored.there.filter((one) => one.machine !== name),
      })
    }
    this.handed = null
  }

  /** The window's beat: what is due, looked at. The promise is what it started, which nothing that draws waits on. */
  beat(names: readonly string[]): Promise<void> {
    const now = this.deps.now()
    const started: Promise<void>[] = []
    for (const name of names) {
      if (this.busy.has(name) || this.deps.reach(name)?.live !== true) continue
      const last = this.at.get(name)
      const since = last === undefined ? Number.POSITIVE_INFINITY : now - last
      const due = since >= AGAIN_MS || (this.owed.has(name) && since >= SOONEST_MS)
      if (!due) continue
      this.owed.delete(name)
      started.push(this.look(name))
    }
    return Promise.all(started).then(() => {})
  }

  /**
   * Other machines' live branches in each project here, by its name, as the
   * mirror holds them: what status's forecast is handed with every look. The
   * same object for as long as nothing in it moved.
   */
  elsewhere(): Readonly<Record<string, Elsewhere>> {
    if (this.handed !== null) return this.handed
    const out: Record<string, Elsewhere> = {}
    for (const [project, mirrored] of this.held) {
      const branches = mirrored.there.flatMap((one) =>
        liveThere(one.machine, one.branches, mirrored.heads),
      )
      if (branches.length > 0) out[project] = { mirror: mirrored.mirror, branches }
    }
    this.handed = out
    return out
  }

  /** Whether a remote has said, since the window opened, which of its projects are which repository. */
  toldBy(name: string): boolean {
    return this.answered.has(name)
  }

  /** Other machines' projects that are one project here's repository, as each last said. */
  sameAs(project: string): readonly { machine: string; project: string }[] {
    return (this.held.get(project)?.there ?? []).map((one) => ({
      machine: one.machine,
      project: one.project,
    }))
  }

  /**
   * Each of these machines' branches in one project here fetched now, whether
   * or not what they last said moved — because what they last said is the very
   * thing that may be stale: what `ProjectSync` asks before it proposes merging
   * a parted branch, so a far branch that moved, rewound or was force-moved
   * since is in the mirror first. A look already going on is waited for, then
   * this one taken. Never throws; a machine not linked is passed over.
   */
  async lookAgain(project: string, machines: readonly string[]): Promise<void> {
    await Promise.all(
      machines.map(async (name) => {
        if (this.deps.reach(name)?.live !== true) return
        await this.looking.get(name)
        await this.look(name, project)
      }),
    )
  }

  /**
   * One remote, asked where its work is, and every project here that is the
   * same repository fetched — `fetching` fetched whatever it says. Never throws.
   */
  look(name: string, fetching?: string): Promise<void> {
    const going = this.looking.get(name)
    if (going !== undefined) return going
    const one = this.lookOnce(name, fetching).finally(() => this.looking.delete(name))
    this.looking.set(name, one)
    return one
  }

  private async lookOnce(name: string, fetching: string | undefined): Promise<void> {
    const held = this.deps.reach(name)
    if (held === null || this.busy.has(name)) return
    this.busy.add(name)
    try {
      const answer = await held.link.request(name, DOOR, {})
      if (answer.status !== 200) {
        // An older Tade there has no such door, which is a fact about it rather than trouble here.
        const why =
          answer.status === 404
            ? `${name} runs a Tade that does not say where its work is yet: update it there`
            : `${name} answered ${answer.status}`
        return this.troubles(name, `${name}'s branches are not read here: ${why}`)
      }
      const read = RepositoriesAnswerSchema.safeParse(answer.body)
      if (!read.success) {
        return this.troubles(
          name,
          `${name}'s branches are not read here: it said where its work is in a shape this Tade does not read`,
        )
      }
      const problems: string[] = []
      const projects = this.deps.projects()
      // What names each checkout's repository: a throw is this look's trouble, said below.
      const named = await Promise.all(
        projects.map((one) => (this.deps.named ?? repositoryAt)(one.root)),
      )
      for (const [i, here] of projects.entries()) {
        const there = read.data.projects.filter((one) =>
          sameRepository(named[i] ?? null, one.repository),
        )
        for (const one of there) {
          const problem = await this.mirrorOne(name, held, here, one, fetching === here.name)
          if (problem !== null) problems.push(problem)
        }
        this.keep(here.name, name, there)
      }
      this.answered.add(name)
      this.troubles(
        name,
        problems.length === 0 ? null : `${name}'s branches: ${problems.join('; ')}`,
      )
    } catch (err) {
      // A link that went down is the link's news; a request that failed while it stayed up is this one's.
      if (this.deps.reach(name)?.live === true) {
        this.troubles(
          name,
          `${name}'s branches are not read here: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } finally {
      this.at.set(name, this.deps.now())
      this.busy.delete(name)
      this.deps.draw()
    }
  }

  /**
   * One remote project into one project here's mirror: fetched where a head
   * moved, its heads read — and this machine's branches pushed into that
   * machine's own mirror, where it said where that is and one moved here.
   */
  private async mirrorOne(
    machine: string,
    held: { link: RemoteLink; remote: Remote },
    here: { name: string; root: string },
    there: {
      project: string
      root: string
      base: string | null
      branches: readonly BranchThere[]
      baseHead?: string | null | undefined
      mirror?: string | undefined
    },
    force = false,
  ): Promise<string | null> {
    const mirror = mirrorDir(this.deps.home, here.name)
    const fetched = await this.inTurn(mirror, async () => {
      const before = await mirrorHeads(mirror, machine)
      // Its base too, where it said where that is: with every agent there in
      // its checkout, no task's branch says the base moved, and the mirror
      // kept a commit that machine had long left.
      const said =
        there.base === null || there.baseHead === undefined || there.baseHead === null
          ? there.branches
          : [
              ...there.branches,
              { task: '', branch: there.base, base: null, head: there.baseHead, live: false },
            ]
      if (!force && before !== null && !fetchDue(machine, said, before)) {
        this.heads(here.name, mirror, await mirrorHeads(mirror))
        return null
      }
      let from: ReturnType<RemoteLink['repository']>
      try {
        from = held.link.repository(held.remote, there.root)
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
      if (from === null) return `a ${held.link.id} link cannot fetch from it`
      const failed = await fetchMirror(mirror, here.root, machine, from)
      this.heads(here.name, mirror, await mirrorHeads(mirror))
      if (failed === null) this.deps.fetched?.(here.name)
      return failed === null ? null : `${there.project} could not be fetched: ${printable(failed)}`
    })
    const pushed =
      there.mirror === undefined ? null : await this.pushOne(machine, held, here, there.mirror)
    return [fetched, pushed].filter((one) => one !== null).join('; ') || null
  }

  /** This machine's branches into a remote's mirror of one project, where one moved since the last push. */
  private async pushOne(
    machine: string,
    held: { link: RemoteLink; remote: Remote },
    here: { name: string; root: string },
    mirror: string,
  ): Promise<string | null> {
    const heads = await headsHere(here.root)
    if (heads === null) return `${here.name}'s branches here could not be read to hand ${machine}`
    const key = `${machine}\0${here.name}`
    if (this.pushed.get(key) === heads) return null
    let to: ReturnType<RemoteLink['repository']>
    try {
      to = held.link.repository(held.remote, mirror)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    if (to === null) return null
    const as = this.deps.as?.() ?? mirrorMachine(machineLabel())
    const failed = await pushMirror(here.root, as, to)
    if (failed !== null)
      return `${here.name}'s branches could not be handed to ${machine}: ${printable(failed)}`
    this.pushed.set(key, heads)
    return await this.dropFormer(key, here, as, to)
  }

  /**
   * This machine's branches under the name it had before it had one of its
   * own — its host name — taken out of that mirror, once: otherwise that
   * machine goes on seeing a source of that name, parted from everything, and
   * proposes merging it under that name. Never a name that could be another
   * machine's: a default, or this machine's own name now.
   */
  private async dropFormer(
    key: string,
    here: { name: string; root: string },
    as: string,
    to: NonNullable<ReturnType<RemoteLink['repository']>>,
  ): Promise<string | null> {
    if (this.dropped.has(key)) return null
    const former = mirrorMachine(formerLabel())
    const anybodys = new Set([
      as,
      'machine',
      machineNameByDefault('darwin'),
      machineNameByDefault('linux'),
    ])
    if (anybodys.has(former)) {
      this.dropped.add(key)
      return null
    }
    const failed = await dropFromMirror(here.root, former, to)
    if (failed !== null)
      return `${here.name}'s branches under this machine's former name could not be taken back: ${printable(failed)}`
    this.dropped.add(key)
    return null
  }

  /** What one remote's projects are in one project here's mirror, from now on. */
  private keep(
    project: string,
    machine: string,
    there: readonly { project: string; base: string | null; branches: readonly BranchThere[] }[],
  ): void {
    const was = this.held.get(project)
    if (was === undefined && there.length === 0) return
    const others = (was?.there ?? []).filter((one) => one.machine !== machine)
    const mine = there.map((one) => ({
      machine,
      project: one.project,
      base: one.base,
      branches: one.branches,
    }))
    this.held.set(project, {
      mirror: was?.mirror ?? mirrorDir(this.deps.home, project),
      heads: was?.heads ?? new Map(),
      there: [...others, ...mine],
    })
    this.handed = null
  }

  /** The heads a mirror holds now, every machine's: kept where they could be read. */
  private heads(project: string, mirror: string, heads: Map<string, string> | null): void {
    if (heads === null) return
    const was = this.held.get(project)
    this.held.set(project, { mirror, there: was?.there ?? [], heads })
    this.handed = null
  }

  private inTurn<T>(mirror: string, work: () => Promise<T>): Promise<T> {
    // After the one before, however it ended: whoever asked for it is the one told how.
    const before = this.turns.get(mirror) ?? Promise.resolve()
    const next = before.then(work, work)
    this.turns.set(mirror, next)
    return next
  }

  /** Said once for as long as it stays the same trouble, and forgotten once it has gone. */
  private troubles(name: string, said: string | null): void {
    if (said === null) this.troubled.delete(name)
    else if (this.troubled.get(name) !== said) {
      this.troubled.set(name, said)
      this.deps.say(said)
    }
  }
}

/** The window's half of it: every linked remote's branches mirrored from the beat. */
export function mirrorsFor(
  wire: {
    opts: { home: string }
    live: { world: { projects: readonly { name: string; root: string }[] } | null } | null
    now(): number
    draw(): void
  },
  reach: MirrorsDeps['reach'],
  say: MirrorsDeps['say'],
  fetched?: MirrorsDeps['fetched'],
): Mirrors {
  return new Mirrors({
    home: wire.opts.home,
    reach,
    projects: () => wire.live?.world?.projects ?? [],
    say,
    now: () => wire.now(),
    draw: () => wire.draw(),
    ...(fetched ? { fetched } : {}),
  })
}

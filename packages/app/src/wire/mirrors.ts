import {
  type BranchThere,
  type Elsewhere,
  fetchDue,
  liveThere,
  mirrorDir,
  mirrorRef,
  printable,
  sameRepository,
} from '@tade/core'
import type { Held, Remote, RemoteLink } from '@tade/remotes-core'
import { fetchMirror, mirrorChanged, mirrorDiff, mirrorHeads, repositoryAt } from '@tade/status'
import { RepositoriesAnswerSchema } from '@tade/web'

// Other machines' work in this machine's projects, kept in a mirror of each
// in this home (REMOTE-TADE.md §9.3, §9.5; core's `elsewhere.ts` has the
// rules, status's `mirror.ts` the git).
//
// **Where one repository is a project here and on a remote**, by the name its
// `origin` gives it on each machine (`repositoryNamed`, never a project's
// name), the remote's branches are fetched over the link this window already
// holds to it (`RemoteLink.repository`) into that project's mirror. Then the
// conflict forecast merges this machine's live branches with that one's there
// (`elsewhere()`, handed to status with every look), and the landing desk and
// the patch reader read that machine's finished work there (`workOf`).
// Nothing is written into the person's checkout: the mirror only reads it.
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

/** How long a linked remote goes before where its work is, is asked again anyway. */
export const AGAIN_MS = 2 * 60_000

/** The least time between two asks of one remote, however often its projection moves. */
export const SOONEST_MS = 15_000

/** How many branches' file lists are kept: past this, the oldest goes. */
const CHANGES_KEPT = 256

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

/** One of another machine's tasks, as its work can be read here. */
export interface WorkThere {
  /** The project here whose mirror holds it. */
  project: string
  mirror: string
  /** The commit its branch is on, as the mirror holds it. */
  head: string
  /** Where its work is measured from: a ref in the mirror, or null where there is none. */
  base: string | null
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
  /** By project here. */
  private readonly held = new Map<string, Mirrored>()
  /** One fetch at a time into each mirror, whichever machine it is from. */
  private readonly turns = new Map<string, Promise<unknown>>()
  private handed: Readonly<Record<string, Elsewhere>> | null = null
  /** What each branch changed, by its mirror, base commit and head: a function of commit ids, so kept. */
  private readonly changed = new Map<string, readonly string[]>()
  private readonly reading = new Set<string>()
  /** The branches whose file list git would not give, by the same key: said once, not asked again. */
  private readonly unread = new Set<string>()
  /** Moved whenever something a reader draws arrived, so what is kept of it is folded again. */
  private revised = 0

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
    for (const [project, mirrored] of this.held) {
      this.held.set(project, {
        ...mirrored,
        there: mirrored.there.filter((one) => one.machine !== name),
      })
    }
    this.handed = null
    this.revised++
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

  /** One of another machine's tasks, as its work can be read here; null where no mirror holds it. */
  workOf(machine: string, task: string): WorkThere | null {
    for (const [project, mirrored] of this.held) {
      for (const one of mirrored.there) {
        if (one.machine !== machine) continue
        const branch = one.branches.find((b) => b.task === task)
        const head = branch && mirrored.heads.get(mirrorRef(machine, branch.branch))
        if (!branch || !head) continue
        const from = branch.base ?? one.base
        const base =
          from && mirrored.heads.has(mirrorRef(machine, from)) ? mirrorRef(machine, from) : null
        return { project, mirror: mirrored.mirror, head, base }
      }
    }
    return null
  }

  /** A count that moves whenever what the readers draw did: a file list arrived, a mirror moved. */
  revision(): number {
    return this.revised
  }

  /**
   * The files one of another machine's tasks changed, from the mirror: at once
   * from what was read before, and read in the background where it was not —
   * null meanwhile, which is never "nothing changed" — or undefined where no
   * mirror here holds that task's work.
   */
  changes(machine: string, task: string): readonly string[] | null | undefined {
    const work = this.workOf(machine, task)
    if (work === null) return undefined
    if (work.base === null) return undefined
    const key = this.keyOf(work)
    const kept = this.changed.get(key)
    if (kept !== undefined) return kept
    // A head or a base that moved is another key, and is read again.
    if (this.unread.has(key)) return undefined
    if (!this.reading.has(key)) {
      this.reading.add(key)
      void mirrorChanged(work.mirror, work.base, work.head)
        .then((files) => {
          if (files === null) {
            this.unread.add(key)
            this.troubles(
              machine,
              `what ${task} on ${machine} changed could not be read out of this machine's mirror of it`,
            )
            return
          }
          this.changed.set(key, files)
          while (this.changed.size > CHANGES_KEPT)
            this.changed.delete(this.changed.keys().next().value as string)
          this.revised++
          this.deps.draw()
        })
        .finally(() => this.reading.delete(key))
    }
    return null
  }

  /** One file's diff on one of another machine's tasks, from the mirror; null where it cannot be read. */
  async diff(machine: string, task: string, path: string): Promise<string | null> {
    const work = this.workOf(machine, task)
    if (work === null || work.base === null) return null
    return mirrorDiff(work.mirror, work.base, work.head, path)
  }

  /** What a branch's changes are kept by: its mirror, its head, and the commit its base is on. */
  private keyOf(work: WorkThere): string {
    const base = work.base === null ? '' : (this.held.get(work.project)?.heads.get(work.base) ?? '')
    return `${work.mirror}\0${base}\0${work.head}`
  }

  /** Every task of a machine's whose work a mirror here holds, for the desk to know what it can read. */
  readable(machine: string): ReadonlySet<string> {
    const out = new Set<string>()
    for (const mirrored of this.held.values()) {
      for (const one of mirrored.there) {
        if (one.machine !== machine) continue
        for (const branch of one.branches) {
          if (mirrored.heads.has(mirrorRef(machine, branch.branch))) out.add(branch.task)
        }
      }
    }
    return out
  }

  /** One remote, asked where its work is, and every project here that is the same repository fetched. Never throws. */
  async look(name: string): Promise<void> {
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
          const problem = await this.mirrorOne(name, held, here, one)
          if (problem !== null) problems.push(problem)
        }
        this.keep(here.name, name, there)
      }
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

  /** One remote project into one project here's mirror: fetched where a head moved, its heads read. */
  private async mirrorOne(
    machine: string,
    held: { link: RemoteLink; remote: Remote },
    here: { name: string; root: string },
    there: { project: string; root: string; base: string | null; branches: readonly BranchThere[] },
  ): Promise<string | null> {
    const mirror = mirrorDir(this.deps.home, here.name)
    return this.inTurn(mirror, async () => {
      const before = await mirrorHeads(mirror, machine)
      if (before !== null && !fetchDue(machine, there.branches, before)) {
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
      return failed === null ? null : `${there.project} could not be fetched: ${printable(failed)}`
    })
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
    this.revised++
  }

  /** The heads a mirror holds now, every machine's: kept where they could be read. */
  private heads(project: string, mirror: string, heads: Map<string, string> | null): void {
    if (heads === null) return
    const was = this.held.get(project)
    this.held.set(project, { mirror, there: was?.there ?? [], heads })
    this.handed = null
    this.revised++
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
): Mirrors {
  return new Mirrors({
    home: wire.opts.home,
    reach,
    projects: () => wire.live?.world?.projects ?? [],
    say,
    now: () => wire.now(),
    draw: () => wire.draw(),
  })
}

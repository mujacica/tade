import { NOT_A_REMOTE, RemoteName } from './remotes.ts'
import type { ScheduleDoes } from './schedule.ts'

// Which machine looks with a project's watches on outside sources
// (REMOTE-TADE.md §9.5, decision 12).
//
// One repository may be a project here and on a remote (§9.1). A watch that
// reads an outside source — a review, a red build, a Sentry issue, a
// dependency, a request in Slack or Linear — finds the same thing from either
// machine, and "one red commit is one finding" holds only where one machine is
// looking: two would be two proposals to two orchestrators, and two agents
// fixing one build. So each runs on exactly one machine per repository.
//
// **Where is the project's to say** (`projects.<name>.watches`): `here`, or a
// remote's name. Unsaid, it is the remote where the same repository is a
// project too, because the machine that never closes is the one that should
// be awake for them; where no remote has it, or more than one does, here.
//
// **And evidence may only hold.** A remote whose projection says it looks with
// the same watch on the same repository (`ProjectRow.watching`) is looking, so
// this machine does not, whatever the setting says: `here` beside a remote that
// is watching is two machines watching, and the one this machine can stop is
// its own. That is said, with what to turn off where. A remote not heard from
// since the window opened is not one that has nothing — the window opens
// before its links answer — so a look that left the watch to it stands until
// it has said (`last`), the way a hold on a tree stands until a look can read
// it. A left look is written down like any other (`watch_checked` with `on`).
//
// Only a watch that says it looks at the repository (`about: 'repository'`) is
// any one machine's — declared, never read off `network`: a judge reaches a
// model somewhere else and reads this machine's agents, and one reading this
// machine's own Tade finds something different on each, so it runs on every one.
//
// Pure: facts in, an answer out.

/** `projects.<name>.watches`: `here`, or a remote by its `remotes.<name>`. */
export const WatchesOn = RemoteName

/** What `here` means wherever it is written: this machine, whatever a remote is called. */
export const WATCHES_HERE = NOT_A_REMOTE

/** A remote's project that is this project's repository, and what it says it watches there. */
export interface WatchTwin {
  /** The remote, by its `remotes.<name>` here. */
  machine: string
  /** Its project there. */
  project: string
  /** The outside watches it says it looks with there; null where its Tade does not say. */
  watching: readonly string[] | null
}

/** What is known, for one watch in one project here, about which machine should look with it. */
export interface WatchWhereFacts {
  /** `<extension>.<watch>`. */
  watch: string
  project: string
  /** Whether it looks at the repository's outside services (`WatchOffer.about`). */
  outside: boolean
  /** `projects.<project>.watches` as written, or undefined where unsaid. */
  setting: string | undefined
  /** The remotes this machine links to, by name. */
  remotes: readonly string[]
  /** The ones that have said, since this window opened, which of their projects are which repository. */
  told: ReadonlySet<string>
  /** Their projects that are this project's repository (`sameRepository`). */
  twins: readonly WatchTwin[]
  /** Its newest look here, where that left it to another machine: which, and what it said. */
  last: { on: string; said: string } | null
}

/** Where it looks: here, or left to another machine with the sentence saying why and what to do. */
export type WatchWhere = { here: true } | { here: false; on: string; said: string }

const HERE: WatchWhere = { here: true }

/** Which machine looks with one watch in one project. The rules above, in their order. */
export function watchWhere(facts: WatchWhereFacts): WatchWhere {
  if (!facts.outside) return HERE
  const { project } = facts
  const running = facts.twins.find((one) => one.watching?.includes(facts.watch) === true)
  if (running) {
    const said = `${running.machine} looks with it on the same repository (${running.project} there), so this machine does not`
    return {
      here: false,
      on: running.machine,
      said:
        facts.setting === WATCHES_HERE
          ? `${said} — projects.${project}.watches says here, so turn it off on ${running.machine} to have it look here`
          : said,
    }
  }
  const last = facts.last
  if (last !== null && facts.remotes.includes(last.on) && !facts.told.has(last.on)) {
    return { here: false, on: last.on, said: last.said }
  }
  if (facts.setting === WATCHES_HERE) return HERE
  if (facts.setting !== undefined && facts.remotes.includes(facts.setting)) {
    const on = facts.setting
    return {
      here: false,
      on,
      said: `projects.${project}.watches leaves it to ${on}${notThere(facts, on, '')}`,
    }
  }
  const machines = [...new Set(facts.twins.map((one) => one.machine))]
  const only = machines.length === 1 ? machines[0] : undefined
  if (only === undefined) return HERE
  const there = facts.twins.filter((one) => one.machine === only).map((one) => one.project)
  const instead = `, or set projects.${project}.watches to here`
  return {
    here: false,
    on: only,
    said: `${project}'s repository is a project on ${only} too (${there.join(', ')}), so it is ${only}'s to watch${notThere(facts, only, instead)}`,
  }
}

/** What is wrong there, where the machine it is left to does not look with it: said with what to do. */
function notThere(facts: WatchWhereFacts, machine: string, instead: string): string {
  if (!facts.told.has(machine)) return ''
  const twins = facts.twins.filter((one) => one.machine === machine)
  if (twins.length === 0)
    return `, which has no project of this repository: open it there${instead}`
  if (twins.every((one) => one.watching === null)) {
    return `, whose Tade does not say what it watches: update it there${instead}`
  }
  return `, which does not look with it: turn it on there${instead}`
}

/** A schedule as `watchingIn` reads it. */
export interface WatchingSchedule {
  id: string
  project: string
  paused: boolean
  does: ScheduleDoes
}

/**
 * The outside watches this machine looks with, by project: what its
 * projection says (`ProjectRow.watching`), so a machine with the same
 * repository can tell. On, its extension able to look, about the repository,
 * and not left to another one by its newest look — what this machine is
 * doing, out of its own journal, and never what it was asked to do.
 */
export function watchingIn(
  schedules: readonly WatchingSchedule[],
  offers: readonly { id: string; about: 'repository' | 'machine'; problem: string | null }[],
  leftTo: (schedule: string) => string | null,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const one of schedules) {
    if (one.paused || one.does.kind !== 'watch') continue
    const watch = one.does.watch
    const offer = offers.find((each) => each.id === watch)
    if (offer?.about !== 'repository' || offer.problem !== null) continue
    if (leftTo(one.id) !== null) continue
    const mine = out.get(one.project) ?? []
    if (!mine.includes(watch)) mine.push(watch)
    out.set(one.project, mine.sort())
  }
  return out
}

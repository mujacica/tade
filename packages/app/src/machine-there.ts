import {
  INBOX_STATES,
  type InboxState,
  printable,
  SOURCE_STATES,
  type SourceState,
} from '@tade/core'
import type { Held } from '@tade/remotes-core'
import type { MachineAnswer } from '@tade/web'
import {
  listIn,
  type Machine,
  machineOf,
  numberIn,
  objectIn,
  saidIn,
  stringIn,
  text,
} from './machines.ts'

// Everything else another machine says about itself and its work, beside its
// projects and agents (`machines.ts`): what its judge flagged and what came of
// each, the requests handed to it and its doors, its plan windows, its own
// warnings, its check runs, the documents its work produced — out of the
// projection the link holds — and what it says it is when asked as an owner
// (`/api/machine`, `wire/remote-machine.ts`): its version, its public name's
// health, its problems, its schedules and watches with their last looks.
//
// **Everything here was written on another machine**, so it is read for its
// shape, bounded, and every string a person reads is reduced to text first —
// through `machines.ts`' readers, which are the only way anything here reads a
// projection. Every moment is moved into this machine's clock by the skew the
// projection was told with, so an age drawn from one is an age here.
//
// **A machine that stopped answering keeps what it last said**: the held
// projection and the last answer are both kept, with when (`asOf`, `about.at`),
// so a page drawn while its link is down says *as of 14:02* and never *none*.
//
// Pure: what was held, in; the fields `Machine.detail` draws, out.

/** One finding its judge raised, and what came of it there. */
export interface FindingThere {
  key: string
  /** The question's own id, out of that machine's rubric. */
  question: string
  project: string
  tasks: readonly string[]
  /** When it was raised, in this machine's clock. */
  at: number | null
  /** The judge's probability: ordered by, never a verdict. */
  probability: number
  file: string
  stillThere: boolean
  /** What the agent said about it, where it accounted for it. */
  account: { did: 'fixed' | 'not real'; said: string | null } | null
  /** What somebody there decided about it. */
  verdict: 'confirmed' | 'false positive' | null
}

/** One request handed to that machine from outside, and where it stands there. */
export interface RequestThere {
  item: string
  source: string
  project: string
  state: InboxState
  /** That machine's own clause for why it stands there. */
  because: string
  /** What the request called itself, and who filed it: somebody else's words, as text. */
  title: string | null
  who: string | null
  at: number | null
  tasks: readonly string[]
}

/** One door outside work comes through there, and how it stands. */
export interface DoorThere {
  source: string
  state: SourceState
  because: string
  lookedAt: number | null
  found: number
  fresh: number
}

/** One sign-in's plan there, and how much of each window it has used. */
export interface PlanThere {
  id: string
  harness: string
  account: string | null
  pays: 'plan' | 'per-token'
  /** How much of each window is used, 0 to 100, as the service said (`PlanWindow.used`). */
  windows: readonly { label: string; used: number; resetsAt: number | null }[]
  at: number | null
  /** Why there is nothing to show, in that machine's words. */
  cannotTell: string | null
}

/** How one check has gone in one tree of a project there: its newest answer and its streak. */
export interface CheckThere {
  project: string
  /** The task whose worktree it ran in, or null for the project's own checkout. */
  task: string | null
  check: string
  required: boolean
  /** Its newest run that said anything, and since when it has said it. Null where none did. */
  streak: { state: 'pass' | 'fail'; since: number | null; runs: number } | null
  /** Its newest run of all, a skipped one included. */
  last: { state: 'pass' | 'fail' | 'other'; at: number | null } | null
  /** Who asked for the newest run there. */
  by: string | null
}

/** A document a task there says it produces, and whether it is written yet. */
export interface ProducedThere {
  task: string
  project: string
  name: string
  written: boolean
}

/** A schedule there, and what its last looks found. */
export interface ScheduleThere {
  id: string
  name: string
  project: string
  kind: 'agent' | 'ask' | 'watch'
  when: string
  paused: boolean
  next: number | null
  watch: {
    id: string
    looks: readonly {
      at: number | null
      found: number
      fresh: number
      problem: string | null
      said: string | null
      on: string | null
    }[]
    found: readonly { at: number | null; key: string; title: string | null; task: string | null }[]
  } | null
}

/** A document that machine's journal says its work produced, by its file's name. */
export interface DocumentThere {
  task: string
  project: string
  name: string
  state: 'written' | 'missing' | 'deleted' | 'gone'
  at: number | null
  bytes: number | null
  triaged: boolean
}

/** What it said it is, asked as its owner, and when. */
export interface MachineAbout {
  /** When it answered, in this machine's clock. */
  at: number
  /** How long the ask took there and back, in milliseconds. */
  roundTrip: number | null
  version: string
  newer: string | null
  public: { name: string; up: boolean; health: readonly { said: string; loud: boolean }[] } | null
  problems: readonly { from: string; at: number | null; said: string }[]
  schedules: readonly ScheduleThere[]
  documents: readonly DocumentThere[]
}

/** What the link's owner asks hold for one remote: its last answer, and why there is none. */
export interface AboutHeld {
  answer: MachineAnswer | null
  /** When it came, in this machine's clock. */
  at: number | null
  roundTrip: number | null
  /** Why it could not be asked, or did not answer: Tade's words, or that machine's as text. */
  said: string | null
}

export interface MachineDetail {
  findings: readonly FindingThere[]
  /** Findings it holds inside its own budget and did not send. */
  findingsMore: number
  requests: readonly RequestThere[]
  doors: readonly DoorThere[]
  plans: readonly PlanThere[]
  /** Status's own warnings there, with what is path-shaped already taken out. */
  warnings: readonly string[]
  checks: readonly CheckThere[]
  produced: readonly ProducedThere[]
  about: MachineAbout | null
  aboutSaid: string | null
}

/** How long a name may be here; a sentence, a little longer. */
const NAME_MOST = 80
const SAID_MOST = 400

/** One remote, as what its link holds and what it said of itself say it is now. */
export function machineThere(held: Held, skew: number, about: AboutHeld | null): Machine {
  const machine = machineOf(held, skew)
  return { ...machine, detail: detailIn(held.projection, skew, about) }
}

/** Everything else a machine said, out of its projection and its answer. */
export function detailIn(
  projection: unknown,
  skew: number,
  about: AboutHeld | null,
): MachineDetail {
  const held = objectIn(projection)
  const at = (value: unknown) => momentIn(value, skew)
  const findings = held === null ? [] : findingsIn(held, at)
  return {
    findings,
    findingsMore: numberIn(objectIn(objectIn(held?.pages)?.findings), 'omitted') ?? 0,
    requests: held === null ? [] : requestsIn(held, at),
    doors: held === null ? [] : doorsIn(held, at),
    plans: held === null ? [] : plansIn(held, at),
    warnings: listOf(objectIn(held?.fresh)?.warnings, SAID_MOST).slice(0, 40),
    checks: held === null ? [] : checksIn(held, at),
    produced: held === null ? [] : producedIn(held),
    about: about?.answer ? aboutOf(about.answer, about.at ?? 0, about.roundTrip, skew) : null,
    aboutSaid:
      about?.said === undefined || about.said === null ? null : text(about.said, SAID_MOST),
  }
}

/** A moment it sent, in this machine's clock, or null where it is not one. */
function momentIn(value: unknown, skew: number): number | null {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(at) ? at + skew : null
}

/** The strings in a list, as text, bounded; nothing else that was in it. */
function listOf(value: unknown, most: number): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((one) => {
    const said = text(one, most)
    return said === '' ? [] : [said]
  })
}

function findingsIn(
  projection: Record<string, unknown>,
  at: (value: unknown) => number | null,
): FindingThere[] {
  return listIn(projection.findings).flatMap((row) => {
    const key = text(row.key, 200)
    const probability = numberIn(row, 'probability')
    if (key === '' || probability === null) return []
    const account = objectIn(row.account)
    const did = stringIn(account, 'did')
    const was = stringIn(objectIn(row.verdict), 'was')
    return [
      {
        key,
        question: text(row.question, NAME_MOST),
        project: text(row.project, NAME_MOST),
        tasks: listOf(row.tasks, 200).slice(0, 20),
        at: at(row.at),
        probability: Math.min(1, probability),
        file: text(row.file, 400),
        stillThere: row.stillThere === true,
        account:
          did === 'fixed' || did === 'not real'
            ? { did, said: saidIn(account?.said, SAID_MOST) }
            : null,
        verdict: was === 'confirmed' || was === 'false positive' ? was : null,
      },
    ]
  })
}

function requestsIn(
  projection: Record<string, unknown>,
  at: (value: unknown) => number | null,
): RequestThere[] {
  return listIn(projection.intake).flatMap((row) => {
    const item = text(row.item, 200)
    const state = INBOX_STATES.find((one) => one === row.state)
    if (item === '' || state === undefined) return []
    return [
      {
        item,
        source: text(row.source, NAME_MOST),
        project: text(row.project, NAME_MOST),
        state,
        because: text(row.because, SAID_MOST),
        title: saidIn(row.title, 200),
        who: saidIn(row.who, NAME_MOST),
        at: at(row.at),
        tasks: listOf(row.tasks, 200).slice(0, 20),
      },
    ]
  })
}

function doorsIn(
  projection: Record<string, unknown>,
  at: (value: unknown) => number | null,
): DoorThere[] {
  return listIn(projection.sources).flatMap((row) => {
    const source = text(row.source, NAME_MOST)
    const state = SOURCE_STATES.find((one) => one === row.state)
    if (source === '' || state === undefined) return []
    return [
      {
        source,
        state,
        because: text(row.because, SAID_MOST),
        lookedAt: at(row.lookedAt),
        found: numberIn(row, 'found') ?? 0,
        fresh: numberIn(row, 'fresh') ?? 0,
      },
    ]
  })
}

function plansIn(
  projection: Record<string, unknown>,
  at: (value: unknown) => number | null,
): PlanThere[] {
  return listIn(projection.plans).flatMap((row) => {
    const id = text(row.id, 200)
    if (id === '') return []
    const cannot = text(row.cannotTell, SAID_MOST)
    return [
      {
        id,
        harness: text(row.harness, NAME_MOST),
        account: saidIn(row.account, NAME_MOST),
        pays: row.pays === 'per-token' ? 'per-token' : 'plan',
        windows: listIn(row.windows)
          .slice(0, 8)
          .flatMap((one) => {
            const used = typeof one.used === 'number' && Number.isFinite(one.used) ? one.used : null
            const label = text(one.label, NAME_MOST)
            return used === null || label === ''
              ? []
              : [{ label, used: Math.min(100, Math.max(0, used)), resetsAt: at(one.resetsAt) }]
          }),
        at: at(row.at),
        cannotTell: cannot === '' ? null : cannot,
      },
    ]
  })
}

/** Every check's newest answer in every tree of every open project there. */
function checksIn(
  projection: Record<string, unknown>,
  at: (value: unknown) => number | null,
): CheckThere[] {
  return listIn(projection.projects).flatMap((project) => {
    const name = text(project.name, NAME_MOST)
    if (name === '' || project.open === false) return []
    return listIn(project.checks).flatMap((tree) => {
      const task = typeof tree.task === 'string' ? text(tree.task, 200) : null
      return listIn(tree.checks).flatMap((track) => {
        const check = text(track.check, NAME_MOST)
        if (check === '') return []
        const runs = listIn(track.runs)
        const newest = runs.at(-1)
        const state = stringIn(newest, 'state')
        const streak = objectIn(track.streak)
        const said = stringIn(streak, 'state')
        return [
          {
            project: name,
            task,
            check,
            required: track.required === true,
            streak:
              said === 'pass' || said === 'fail'
                ? { state: said, since: at(streak?.since), runs: numberIn(streak, 'runs') ?? 0 }
                : null,
            last:
              newest === undefined
                ? null
                : {
                    state: state === 'pass' || state === 'fail' ? state : 'other',
                    at: at(newest.at),
                  },
            by: typeof track.by === 'string' ? text(track.by, 200) : null,
          },
        ]
      })
    })
  })
}

/** What each task there says it produces. */
function producedIn(projection: Record<string, unknown>): ProducedThere[] {
  return listIn(projection.tasks).flatMap((row) => {
    const produces = objectIn(row.produces)
    const task = text(row.id, 200)
    const name = text(produces?.name, 200)
    if (task === '' || name === '') return []
    return [
      { task, project: text(row.project, NAME_MOST), name, written: produces?.written === true },
    ]
  })
}

/** What it said it is, as text, in this machine's clock. */
export function aboutOf(
  answer: MachineAnswer,
  at: number,
  roundTrip: number | null,
  skew: number,
): MachineAbout {
  const when = (value: string | null) => momentIn(value, skew)
  const said = (value: string | null) => (value === null ? null : printable(value).trim() || null)
  return {
    at,
    roundTrip,
    version: printable(answer.version),
    newer: said(answer.newer),
    public:
      answer.public === null
        ? null
        : {
            name: printable(answer.public.name),
            up: answer.public.up,
            health: answer.public.health.map((one) => ({
              said: printable(one.said),
              loud: one.loud,
            })),
          },
    problems: answer.problems.map((one) => ({
      from: one.from,
      at: when(one.at),
      said: printable(one.said),
    })),
    schedules: answer.schedules.map((one) => ({
      id: printable(one.id),
      name: printable(one.name),
      project: printable(one.project),
      kind: one.kind,
      when: printable(one.when),
      paused: one.paused,
      next: when(one.next),
      watch:
        one.watch === null
          ? null
          : {
              id: printable(one.watch.id),
              looks: one.watch.looks.map((look) => ({
                at: when(look.at),
                found: look.found,
                fresh: look.fresh,
                problem: said(look.problem),
                said: said(look.said),
                on: said(look.on),
              })),
              found: one.watch.found.map((found) => ({
                at: when(found.at),
                key: printable(found.key),
                title: said(found.title),
                task: said(found.task),
              })),
            },
    })),
    documents: answer.documents.map((one) => ({
      task: printable(one.task),
      project: printable(one.project),
      name: printable(one.name),
      state: one.state,
      at: when(one.at),
      bytes: one.bytes,
      triaged: one.triaged,
    })),
  }
}

/** What a watch's newest look there came to, in a few words; empty for a schedule that is not one. */
export function lookSaid(one: ScheduleThere, date: (at: number) => string): string {
  if (one.watch === null) return ''
  const look = one.watch.looks[0]
  if (look === undefined) return 'has not looked'
  if (look.problem !== null) return `! ${look.problem}`
  if (look.on !== null) return `on ${look.on}`
  const found =
    look.fresh > 0 ? `${look.fresh} new` : look.found === 0 ? 'found nothing' : 'nothing new'
  return look.at === null ? found : `${found} ${date(look.at)}`
}

import { OUTSIDE_IS_MATERIAL } from './compose.ts'
import type { IntakeMode } from './intake.ts'
import type { IntakeItem } from './intake-journal.ts'
import { INTAKE_ATTEMPTS } from './intake-journal.ts'
import type { TaskState } from './model.ts'

// The inbox: everything that has been handed to this machine, and where each
// one of them stands.
//
// **Derived, like every other statistic here.** The journal's own fold
// (`intakeFrom`) says what arrived and what was decided; the task files say
// what became of the work; this puts the two together and answers the one
// question a person has — *is somebody waiting on me?* Nothing is kept, so
// there is no inbox to get out of step with the journal, and deleting the
// SQLite index changes none of it.
//
// **Seven states and not three.** `IntakeItem.state` is `received`, `refused`
// or `accepted`, which is what the *rule* decided; it cannot tell a request
// nobody has approved from one working, because that is the task's answer and
// not the rule's. Collapsing them is what made the first drawing of this
// unreadable: "accepted" stood for a parked proposal, a queued task, a running
// agent and a delivery that had failed twice, and the one thing somebody needs
// to see — which of these is waiting for them — was the one thing it could not
// say.
//
// **The body is not in any type here.** `InboxRow` has the source's reference
// to the raw material and its hash, and no field that could hold the request
// itself; reading it is `materialOf`, which is a separate ask with its own
// heading on the answer. That is the same enforcement-by-absence as
// `IntakeSaid`: a surface, a tool or a reply cannot leak a stranger's words
// through a shape that has nowhere to put them.
//
// Pure: facts in, rows out. No clock reads (every rule takes `now` where it
// needs one), no I/O, no async.

/**
 * Where one request stands, as a person reads it.
 *
 * Four of the seven are about *who is waiting on whom*, which is the whole
 * reason there are seven: `noticed` is Tade, `proposed` is you, `accepted` is
 * the queue, `started` is an agent. The other three are the ways it stops.
 */
export const INBOX_STATES = [
  /** A look found it and the rule allowed it; nothing has been made yet. */
  'noticed',
  /** A task is made and parked: it is waiting for a person to approve it. */
  'proposed',
  /** Approved, or granted `queue`: the queue starts it when there is room. */
  'accepted',
  /** An agent is on it, or has been. */
  'started',
  /** Something has to be answered before it can go on. */
  'held',
  /** The rule said no, or a person did. */
  'refused',
  /** Tade stopped trying, and that is a thing somebody has to see. */
  'failure',
] as const
export type InboxState = (typeof INBOX_STATES)[number]

/** Which of them is somebody at this machine's to answer. */
export const WAITING_STATES: readonly InboxState[] = ['proposed', 'held', 'failure']

/**
 * What became of one task a request made.
 *
 * Four facts and one answer that may be absent. The facts are what the task
 * file and the journal say, which anything with a home can read; `state` is
 * `deriveState`'s, which needs probes, so only a window can fill it in and
 * **null is a first-class answer** rather than a state invented here. Nothing
 * below branches on `state`: a second mapping from the world to a task's state
 * is a second answer to a question `deriveState` already answers.
 */
export interface InboxWork {
  task: string
  /** Parked: a proposal nobody has approved, or an approval that was put back. */
  parked: boolean
  /** An agent has been started on it. */
  started: boolean
  /** It is finished, by its own done rule. */
  finished: boolean
  /** Why the queue is holding it, where it is holding it. */
  held: string | null
  /** Its state where the caller could ask for one; null where nobody could. */
  state: TaskState | null
}

/**
 * One request, as a surface draws it.
 *
 * Every field is either the source's own word for something or this machine's
 * own record of what it decided — and **the grant is a path rather than a
 * boolean**, because "which policy allowed this" is only honestly answerable
 * as the key a person can go and remove.
 */
export interface InboxRow {
  /** `<source>:<externalId>`, which is the thing itself across every revision. */
  item: string
  source: string
  externalId: string
  /** The handle the source gave, never read as authority. */
  requester: string
  project: string
  /** The dotted config path of the grant that allowed it. Empty where none did. */
  grant: string
  /** The published template and the version resolved at the moment of accepting. */
  template: { name: string; version: number } | null
  /** The newest revision seen, and the one the work was made for. Two facts. */
  revision: string
  taken: string
  /** The hash of the body the work was made from: how "the text has moved" is a comparison. */
  hash: string
  /** The source's own stable reference to the raw material. Never a path Tade took from anybody. */
  ref: string
  /** The source's own page for it, where it has one. Empty for a door with no pages. */
  url: string
  /** The watch it came through, and the schedule that watch runs as. */
  watch: string
  schedule: string
  mode: IntakeMode | null
  tasks: readonly string[]
  work: readonly InboxWork[]
  state: InboxState
  /** Tade's own sentence about why it is in that state. Never a word of the request. */
  because: string
  /** How many times carrying it out has failed since the last one that worked. */
  attempts: number
  /** Out of how many Tade tries before it stops on its own. */
  tries: number
  /** How many statuses have gone back to the source about it. */
  replies: number
  /** Which of the fixed sentences have gone back, in the order they went. */
  said: readonly string[]
  /**
   * The statuses that did not go, and why.
   *
   * **A reply that failed is a person at the other end who was never told**,
   * and the one thing that must not happen to it is going quiet: the work
   * carries on — a status is never a hold — so nothing else about the row
   * changes, and this is the only place the silence is visible. Drawn by every
   * surface through `inboxProvenance`, so the window, the CLI and anything
   * later say it the same way.
   */
  unsent: readonly { saying: string; attempts: number; problem: string | null }[]
  at: number
}

/** What a person may do to one request from this machine. */
export const INBOX_ACTS = ['approve', 'start', 'refuse', 'retry'] as const
export type InboxAct = (typeof INBOX_ACTS)[number]

/**
 * Where one request stands, out of the journal's answer and the work's.
 *
 * The order is the whole of it, and it is cheapest-and-most-final first: a
 * giving-up outranks everything, because a person has to see it; a refusal
 * outranks what the work says, because there is no work; and a failure
 * outranks a park, because a task parked by an invalidated approval reads as
 * an ordinary proposal and is not one.
 */
export function inboxStateOf(
  one: IntakeItem,
  work: readonly InboxWork[],
): { state: InboxState; because: string } {
  if (one.gaveUp) {
    return {
      state: 'failure',
      because: one.problem ?? `${one.externalId} was given up on`,
    }
  }
  if (one.state === 'refused') {
    return { state: 'refused', because: refusedBecause(one) }
  }
  if (one.attempts > 0) {
    return {
      state: 'held',
      because:
        one.problem ??
        `carrying ${one.externalId} out has failed ${one.attempts} time${one.attempts === 1 ? '' : 's'}`,
    }
  }
  if (one.state === 'received') {
    return {
      state: 'noticed',
      because: `${one.source} ${one.externalId} was picked up and nothing has been made for it yet`,
    }
  }
  const held = work.find((task) => task.held !== null)
  if (held?.held) return { state: 'held', because: `${held.task} is held: ${held.held}` }
  const started = work.filter((task) => task.started)
  if (started.length > 0) {
    const done = started.filter((task) => task.finished).length
    return {
      state: 'started',
      because:
        done === started.length
          ? `${said(started.map((task) => task.task))} ${done === 1 ? 'is' : 'are'} finished`
          : `${said(started.map((task) => task.task))} ${started.length === 1 ? 'has' : 'have'} an agent on ${started.length === 1 ? 'it' : 'them'}${done > 0 ? `, ${done} finished` : ''}`,
    }
  }
  const parked = work.filter((task) => task.parked)
  if (parked.length > 0 && parked.length === work.length) {
    return {
      state: 'proposed',
      because: `${said(work.map((task) => task.task))} ${work.length === 1 ? 'is' : 'are'} parked, waiting for a person to approve ${work.length === 1 ? 'it' : 'them'}`,
    }
  }
  if (work.length === 0) {
    // Accepted, and the tasks it made are not there any more — removed by hand,
    // or a home somebody tidied. Said rather than drawn as a proposal nobody
    // can approve, which is what reading the journal alone would make of it.
    return {
      state: 'accepted',
      because: `${said([...one.tasks])} ${one.tasks.length === 1 ? 'was' : 'were'} made for it and ${one.tasks.length === 1 ? 'is' : 'are'} not there now`,
    }
  }
  return {
    state: 'accepted',
    because: `${said(work.map((task) => task.task))} ${work.length === 1 ? 'is' : 'are'} queued: the queue starts ${work.length === 1 ? 'it' : 'them'} when there is room`,
  }
}

/** Why a refusal was a refusal, in the words of the rule that made it. */
function refusedBecause(one: IntakeItem): string {
  switch (one.why) {
    case 'no_grant':
      return `${one.source} may not make work here: its grant's accept is off`
    case 'no_project':
      return `${one.grant || 'the grant'} does not list ${one.project}`
    case 'not_allowed':
      return `the grant does not list @${one.requester}`
    case 'is_bot':
      return `${one.source} says @${one.requester} is an app, and an app's request is not a person's`
    case 'by_hand':
      return one.problem ?? 'a person at this machine refused it'
    default:
      return `${one.externalId} was refused`
  }
}

/** `a`, `a and b`, `a, b and c` — the repository's own way of saying a list. */
function said(names: readonly string[]): string {
  if (names.length === 0) return 'nothing'
  if (names.length === 1) return names[0] as string
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** One row, from the journal's item and what became of the work it made. */
export function inboxRowOf(one: IntakeItem, work: readonly InboxWork[]): InboxRow {
  const mine = work.filter((task) => one.tasks.includes(task.task))
  const { state, because } = inboxStateOf(one, mine)
  return {
    item: one.item,
    source: one.source,
    externalId: one.externalId,
    requester: one.requester,
    project: one.project,
    grant: one.grant,
    template: one.template,
    revision: one.revision,
    taken: one.taken,
    hash: one.hash,
    ref: one.ref,
    url: one.url,
    watch: one.watch,
    schedule: one.schedule,
    mode: one.mode,
    tasks: one.tasks,
    work: mine,
    state,
    because,
    attempts: one.attempts,
    tries: INTAKE_ATTEMPTS,
    replies: one.replies.length,
    said: one.said.filter((reply) => reply.sent).map((reply) => reply.saying),
    // Tried and not there: a status whose last word was a failure. One that
    // went after failing twice is not here at all, which is the point —
    // `sent` is the answer, and the attempts behind it are history.
    unsent: one.said
      .filter((reply) => !reply.sent && reply.attempts > 0)
      .map((reply) => ({
        saying: reply.saying,
        attempts: reply.attempts,
        problem: reply.problem,
      })),
    at: one.at,
  }
}

/**
 * The whole inbox, newest first.
 *
 * Newest first and not grouped: a surface groups what it draws (what is
 * waiting for you, then what was taken), and the grouping is a *drawing*
 * decision that two surfaces answer differently — the window has two headings,
 * the CLI prints one list. What is not a drawing decision is the order, which
 * is the order the requests arrived in.
 */
export function inboxOf(
  items: ReadonlyMap<string, IntakeItem>,
  work: readonly InboxWork[],
  only?: { project?: string },
): InboxRow[] {
  const rows = [...items.values()]
    .map((one) => inboxRowOf(one, work))
    .filter((row) => (only?.project ? row.project === only.project : true))
  return rows.sort((a, b) => b.at - a.at)
}

/** The ones somebody at this machine has to answer, which is what a badge counts. */
export function inboxWaiting(rows: readonly InboxRow[]): InboxRow[] {
  return rows.filter((row) => WAITING_STATES.includes(row.state))
}

/**
 * Why one act cannot be done to one row, or null where it can.
 *
 * **One rule, three readers**: the window greys the button with this sentence,
 * the CLI prints it, and the act itself refuses with it. Written here rather
 * than at each door, because a button that offers what the door refuses is how
 * a surface comes to lie about what it can do.
 */
export function whyNotAct(row: InboxRow, act: InboxAct): string | null {
  if (act === 'retry') {
    // A refusal is a final answer about this revision, and handing it to the
    // source again would be asking for work somebody has just said no to. A
    // new revision of the request is a new request, and that is the way back.
    if (row.state === 'refused') {
      return `${row.externalId} is refused: a new revision of it is a new request, and this one is answered`
    }
    if (row.attempts > 0) return null
    // A delivery that failed and work the queue is holding are two different
    // troubles with two different answers, and only the first is this
    // button's. Saying which keeps somebody from pressing retry four times at
    // a budget that will not move until they answer it in the queue.
    const held = row.work.find((task) => task.held !== null)
    if (held?.held) {
      return `${row.externalId} arrived; it is ${held.task} the queue is holding: ${held.held} — answer that in the queue`
    }
    return `nothing about ${row.externalId} has failed, so there is nothing to try again`
  }
  if (act === 'refuse') {
    if (row.state === 'refused') return `${row.externalId} is already refused`
    return null
  }
  // approve, and approve-and-start.
  if (row.state === 'refused') {
    return `${row.externalId} was refused: a new revision of it is a new request, and this one is answered`
  }
  if (row.state === 'noticed') {
    return `nothing has been made for ${row.externalId} yet: the next look makes it`
  }
  if (row.state === 'failure') {
    return `${row.externalId} was given up on and nothing was made: try it again first`
  }
  if (row.work.every((task) => !task.parked)) {
    return row.work.length === 0
      ? `there is nothing of ${row.externalId}'s left to approve`
      : `${row.externalId} is already picked up: ${row.because}`
  }
  return null
}

/** What this row offers to do, with the sentence for each one it does not. */
export function inboxActs(row: InboxRow): { act: InboxAct; off: string | null }[] {
  return INBOX_ACTS.map((act) => ({ act, off: whyNotAct(row, act) }))
}

// --- provenance, and the material it is deliberately not

/** One labelled fact about where a request came from. */
export interface InboxFact {
  label: string
  value: string
}

/**
 * Where one request came from, as facts somebody can read — and **nothing a
 * stranger wrote** except the handle and the source's own ids, which are what
 * the words "who asked" mean.
 *
 * `—` rather than a blank or a nought wherever the answer is that nobody said:
 * a row drawn with an empty grant reads as a request nothing authorised, and
 * a request nothing authorised was refused and never got a row at all.
 */
export function inboxProvenance(row: InboxRow): InboxFact[] {
  const facts: InboxFact[] = [
    { label: 'source', value: row.source },
    { label: 'their id', value: row.externalId },
    { label: 'revision', value: revisionSays(row) },
    { label: 'asked by', value: row.requester ? `@${row.requester}` : '—' },
    { label: 'project', value: row.project || '—' },
    { label: 'allowed by', value: row.grant || '—' },
    { label: 'mode', value: row.mode ?? '—' },
    {
      label: 'template',
      value: row.template ? `${row.template.name}@${row.template.version}` : 'none: one task',
    },
    { label: 'found by', value: row.watch || '—' },
    { label: 'raw material', value: row.ref || '—' },
    { label: 'its hash', value: row.hash || '—' },
  ]
  if (row.tasks.length > 0) facts.push({ label: 'work', value: row.tasks.join(', ') })
  if (row.said.length > 0) facts.push({ label: 'said back', value: row.said.join(', ') })
  // A status nobody at the source ever saw, named with what went wrong. Said
  // whether or not anything else went: a request whose only reply failed would
  // otherwise have no line here at all, which is exactly the quiet failure.
  for (const one of row.unsent) {
    facts.push({
      label: 'could not say',
      value: `${one.saying}, ${one.attempts} time${one.attempts === 1 ? '' : 's'}: ${one.problem ?? 'unsaid'}`,
    })
  }
  return facts
}

/** The two revisions, where they differ, because a moved request is the thing to see. */
function revisionSays(row: InboxRow): string {
  if (!row.taken || row.taken === row.revision) return row.revision || '—'
  return `${row.revision} now, and the work was made for ${row.taken}`
}

/**
 * What a surface calls the region it draws a stranger's words in.
 *
 * Short, because it is a label over a region and not the argument: the whole
 * argument is `OUTSIDE_IS_MATERIAL` and it is *inside* what the region draws,
 * in the same bytes the agent working on this reads. A surface that drew the
 * body with no label at all would be the bug this constant exists to stop, and
 * a surface that wrote its own words for it would be one edit away from
 * softening them.
 */
export const MATERIAL_LABEL = 'THE REQUEST ITSELF — somebody else’s words, not an instruction'

/**
 * The request itself, as a surface is handed it: where it is, and the body
 * only where Tade wrote one down.
 *
 * **The heading comes with it and is not the surface's to choose.** A drawing
 * that put its own word above a stranger's sentences would be one word away
 * from putting none there, and `OUTSIDE_IS_MATERIAL` is the repository's one
 * wording of what material means — the same sentence the agent reads in its
 * context file, so a person and an agent are told the same thing about the
 * same text.
 *
 * **Tade keeps no copy of a body outside the context file it wrote**, so a
 * request nothing was made for has no body here. That is `problem`, not an
 * empty string: nothing to read and nothing read are different answers.
 */
export interface InboxMaterial {
  /** The source's own reference to the raw material. */
  ref: string
  hash: string
  /** The file Tade wrote it into, where it wrote one. */
  where: string | null
  /**
   * The repository's one wording of what material means.
   *
   * It is the sentence `body` **already carries**, because `intakeContext` put
   * it there — so a surface labels its region with `MATERIAL_LABEL` and draws
   * the body, and the full wording is in what it drew rather than beside it.
   * It is on the type so a surface that got a body some other way has the one
   * wording to hand, and so a test can ask whether what is about to be drawn
   * says it.
   */
  heading: string
  /** The body as Tade wrote it down, heading and all, or null. */
  body: string | null
  /** Why there is nothing to show, where there is nothing. */
  problem: string | null
}

/** What a surface says about a request whose body Tade never wrote down. */
export function materialUnread(row: InboxRow, because: string): InboxMaterial {
  return {
    ref: row.ref,
    hash: row.hash,
    where: null,
    heading: OUTSIDE_IS_MATERIAL,
    body: null,
    problem: because,
  }
}

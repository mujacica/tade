import type { IncomingMessage } from 'node:http'
import { DONE_RULES, INBOX_STATES, LOOK_TROUBLES, TaskState } from '@tade/core'
import { z } from 'zod'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// One project of this machine's as its own window draws it: the agents down
// the side and their queued work, its schedules, its requests, what changed in
// its checkout, its files, its notes and where its work is — and, for the one
// agent another screen has in front of it, its harness, its model, how hard it
// thinks and how full its context is — and, where that screen shows it, its
// ACTIONS tab: its commits, its review and how its checks stand.
//
// **What another of the person's machines draws the project from**, so a
// project there is drawn by that machine's own views out of the values this
// machine's window would draw it from (`packages/app/src/side.ts`), and an
// agent there looks exactly like an agent here. The values are the window's
// own (`AgentPane`, `ScheduleView`, `Change`, `FileEntry`, `NoteShown`, its
// header's `route`, `vitals` and `offers`), written out here as the wire's
// shape so the machine reading them reads them for that shape and nothing
// else — every string bounded, every list bounded, every word one of the
// words it can be — and reduces every string to text where it folds them.
//
// **An owner's, and only at this machine's own door** (`here` in
// `routes.ts`): the answer names where the project is on this machine
// (`where`) and which files are in it, which no row a phone reads holds
// (`input.ts`). Whoever holds the SSH key can already `ssh` in and look — or
// a paired phone, every one of which is the person's own, as on every owner's
// route.
//
// **It reads, and changes nothing.** Asked while another screen stands in the
// project, every beat it is drawn on; what it names is what the window here
// last looked at, never a look started for the asking — a tree nobody here
// has opened is asked for once, and answered `null` (not looked at yet) until
// the beat after.

/** How many of each kind one answer carries: past that, the rest are not sent. */
export const SIDE_MOST = {
  panes: 400,
  changes: 2000,
  files: 5000,
  notes: 500,
  schedules: 200,
  intake: 400,
  expanded: 256,
  commits: 200,
  checks: 64,
} as const

const NAME = z.string().max(400)
const TEXT = z.string().max(4000)
const LONG = z.string().max(64_000)
const COUNT = z.number().finite()
const WHEN = z.number().finite().nullable()

const Wait = z.object({ task: NAME, why: TEXT })

const WaitThereSchema = z.object({
  on: NAME,
  machine: NAME,
  task: NAME,
  heardAt: WHEN,
  silentDays: WHEN,
  why: TEXT.optional(),
})

const QueueStateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('waiting'),
    on: z.array(NAME).max(200),
    approval: z.array(NAME).max(200).optional(),
    there: z.array(WaitThereSchema).max(200).optional(),
  }),
  z.object({
    kind: z.literal('held'),
    on: NAME.nullable(),
    because: TEXT,
    changed: z.array(TEXT).max(500).optional(),
    by: z.array(NAME).max(200).optional(),
  }),
  z.object({ kind: z.literal('scheduled'), at: COUNT }),
  z.object({ kind: z.literal('paused'), all: z.boolean(), parked: z.boolean().optional() }),
  z.object({ kind: z.literal('ready') }),
])

const QueuedSchema = z.object({
  state: QueueStateSchema,
  after: z.array(Wait).max(200),
  prompt: LONG,
  touches: z.array(TEXT).max(500),
  at: WHEN,
  placed: NAME.optional(),
})

/** One of the project's agents, or a piece of its queued work: the window's `AgentPane`. */
const PaneSchema = z.object({
  task: NAME,
  project: NAME,
  name: NAME,
  title: TEXT.nullable(),
  intent: LONG.optional(),
  branch: NAME,
  lane: NAME.nullable(),
  state: TaskState,
  reason: TEXT.optional(),
  waiting: z.boolean(),
  approval: z.object({ tool: NAME, summary: LONG, id: NAME.optional() }).nullable(),
  lanes: z.array(z.object({ id: NAME, kind: NAME, title: TEXT.optional() })).max(64),
  finished: z.object({ by: NAME, summary: TEXT }).nullable().optional(),
  done: z.enum(DONE_RULES).optional(),
  by: NAME.optional(),
  queued: QueuedSchema.nullable().optional(),
  waitsOn: z.array(Wait).max(200).optional(),
  effort: NAME.optional(),
  servers: z.array(COUNT).max(64).optional(),
  conflicts: z
    .array(
      z.object({
        kind: z.enum(['branches', 'base', 'hunks', 'elsewhere']),
        with: NAME,
        files: z.array(TEXT).max(500),
      }),
    )
    .max(64)
    .optional(),
})

/** What one agent's row says it spent today, by this machine's clock. */
const SpentSchema = z.object({
  task: NAME,
  tokens: COUNT,
  usd: COUNT,
  usdExact: COUNT.optional(),
  usdEstimated: COUNT.optional(),
  usdListed: COUNT.optional(),
})

const ChangeSchema = z.object({
  path: TEXT,
  mark: z.string().max(4),
  added: WHEN,
  removed: WHEN,
})

const FileSchema = z.object({
  path: TEXT,
  name: TEXT,
  depth: z.number().int().min(0).max(256),
  folder: z.boolean(),
  open: z.boolean(),
})

const NoteSchema = z.object({
  text: LONG,
  at: NAME,
  summary: TEXT.optional(),
  scope: NAME.nullable().optional(),
  also: z.array(NAME).max(64).optional(),
  by: NAME.optional(),
  retired: z.object({ by: NAME, at: NAME, because: TEXT }).optional(),
})

const WhereSchema = z.object({
  repo: TEXT,
  branch: NAME.nullable(),
  base: NAME.nullable(),
  worktree: TEXT.nullable(),
  path: TEXT,
  shownPath: TEXT.optional(),
  links: z
    .array(z.object({ title: TEXT, url: TEXT }))
    .max(32)
    .optional(),
  servers: z.array(COUNT).max(64).optional(),
})

const ScheduleSchema = z.object({
  id: NAME,
  name: NAME,
  project: NAME,
  said: LONG,
  kind: z.enum(['agent', 'ask', 'watch']),
  does: TEXT,
  prompt: LONG,
  when: NAME,
  once: z.boolean(),
  next: z.array(COUNT).max(16),
  paused: z.boolean(),
  by: NAME,
  missed: z.enum(['once', 'skip']),
  runs: z
    .array(z.object({ due: COUNT, ran: z.boolean(), missed: COUNT, task: NAME.nullable() }))
    .max(64),
  watch: z
    .object({
      id: NAME,
      turnedOnBy: NAME,
      found: z.enum(['agent', 'ask']),
      most: COUNT,
      looks: z
        .array(
          z.object({
            at: COUNT,
            found: COUNT,
            fresh: COUNT,
            left: COUNT,
            problem: TEXT.nullable(),
            trouble: z.enum(LOOK_TROUBLES).nullable(),
            until: WHEN,
            said: TEXT.nullable(),
            on: NAME.optional(),
          }),
        )
        .max(64),
      findings: z
        .array(
          z.object({
            at: COUNT,
            key: NAME,
            title: TEXT,
            task: NAME.nullable(),
            told: NAME.nullable(),
            problem: TEXT.nullable(),
            proposed: z.boolean().optional(),
            links: z.array(TEXT).max(16).optional(),
          }),
        )
        .max(64),
    })
    .optional(),
})

/** A request handed to this machine, as much of it as its row in the side draws. */
const RequestSchema = z.object({
  item: NAME,
  source: NAME,
  externalId: NAME,
  requester: NAME,
  project: NAME,
  state: z.enum(INBOX_STATES),
  because: TEXT,
  template: z.object({ name: NAME, version: COUNT }).nullable(),
  work: z
    .array(
      z.object({
        task: NAME,
        parked: z.boolean(),
        started: z.boolean(),
        finished: z.boolean(),
        held: TEXT.nullable(),
        state: TaskState.nullable(),
      }),
    )
    .max(64),
  at: COUNT,
})

const OfferSchema = z.object({
  shown: z.boolean(),
  support: NAME,
  note: TEXT.nullable(),
})

/** What the agent in front of the asking screen runs on, as this machine's header says it. */
const AgentSchema = z.object({
  task: NAME,
  route: z.object({
    harness: NAME,
    model: NAME.nullable(),
    thinking: NAME.nullable().optional(),
    provider: NAME.nullable(),
  }),
  vitals: z
    .object({
      model: NAME.nullable(),
      thinking: NAME.nullable().optional(),
      contextPercent: COUNT.nullable(),
    })
    .nullable(),
  offers: z
    .object({
      harness: NAME,
      accounts: z.boolean(),
      model: OfferSchema,
      thinking: OfferSchema,
      rename: OfferSchema,
      levels: z.array(NAME).max(16),
    })
    .nullable(),
})

const MarkSchema = z.object({
  text: TEXT,
  tone: z.enum(['quiet', 'good', 'warning', 'bad']).optional(),
})

const CommitSchema = z.object({
  sha: NAME,
  subject: TEXT,
  at: COUNT,
  task: NAME.nullable(),
  files: COUNT.nullable(),
  added: COUNT.nullable(),
  removed: COUNT.nullable(),
})

const CheckSchema = z.object({
  id: NAME,
  title: TEXT.nullable(),
  run: TEXT.nullable(),
  state: NAME,
  required: z.boolean(),
  skip: TEXT.nullable(),
  chosen: z.boolean().nullable(),
  needs: z.array(NAME).max(64),
  summary: TEXT.nullable(),
  seconds: COUNT.nullable(),
  startedAt: WHEN,
  at: WHEN,
  commit: NAME.nullable(),
  carried: z.boolean(),
  counts: z
    .array(z.object({ label: NAME, count: COUNT, tone: z.enum(['good', 'bad', 'quiet']) }))
    .max(32),
  places: z.array(z.object({ path: TEXT, at: NAME.nullable(), note: TEXT.nullable() })).max(64),
  more: COUNT,
  tail: z.array(TEXT).max(200),
})

/**
 * What the agent in front of the asking screen has done, as this machine's
 * ACTIONS tab draws it (the window's `ActionsView`): its own commits and the
 * rest, what is not committed, the review it is out for and its checks.
 */
const ActionsSchema = z.object({
  task: NAME,
  branch: NAME.nullable(),
  base: NAME.nullable(),
  ahead: COUNT.nullable(),
  behind: COUNT.nullable(),
  dirty: COUNT,
  shared: z.boolean(),
  commit: NAME.nullable(),
  mine: z.array(CommitSchema).max(SIDE_MOST.commits),
  others: z.array(CommitSchema).max(SIDE_MOST.commits),
  review: z
    .object({
      section: NAME,
      id: NAME,
      title: TEXT,
      label: NAME.optional(),
      note: TEXT.optional(),
      marks: z.array(MarkSchema).max(32).optional(),
      figures: z.array(MarkSchema).max(32).optional(),
      age: z.object({ since: COUNT, says: NAME }).optional(),
      links: z
        .array(z.object({ title: TEXT, url: TEXT }))
        .max(16)
        .optional(),
      task: NAME.optional(),
      project: NAME.optional(),
    })
    .nullable(),
  checks: z.array(CheckSchema).max(SIDE_MOST.checks),
  rollup: z.enum(['pass', 'fail', 'unknown']),
  pending: TEXT.nullable().optional(),
  source: TEXT,
  unread: z.array(TEXT).max(64),
  running: z.object({ since: COUNT, by: NAME, done: COUNT, total: COUNT }).nullable(),
  notes: z.array(TEXT).max(32),
})

/**
 * The answer, as this machine gives it and another reads it: read for its
 * shape — another field from a newer Tade is let be — and every value bounded,
 * because it was written on another machine.
 */
export const SideAnswerSchema = z.object({
  project: NAME,
  /** No look at status has landed there yet: which agents there are is unknown, not none. */
  looking: z.boolean(),
  panes: z.array(PaneSchema).max(SIDE_MOST.panes),
  /** Absent where that machine has not read its journal yet, which is unknown and not nought. */
  spent: z.array(SpentSchema).max(SIDE_MOST.panes).nullable(),
  changes: z.array(ChangeSchema).max(SIDE_MOST.changes).nullable(),
  base: NAME.nullable(),
  files: z.array(FileSchema).max(SIDE_MOST.files).nullable(),
  marks: z.array(z.object({ path: TEXT, mark: z.string().max(4) })).max(SIDE_MOST.files),
  where: WhereSchema.nullable(),
  notes: z.array(NoteSchema).max(SIDE_MOST.notes),
  retired: z.array(NoteSchema).max(SIDE_MOST.notes),
  schedules: z.array(ScheduleSchema).max(SIDE_MOST.schedules),
  intake: z.array(RequestSchema).max(SIDE_MOST.intake),
  intakeEmpty: z.object({ short: TEXT, long: TEXT }),
  agent: AgentSchema.nullable(),
  /**
   * The agent in front's ACTIONS tab, where the ask said it is shown: null
   * until this machine has looked at its work, and absent from a Tade that
   * does not draw it for another screen.
   */
  actions: ActionsSchema.nullable().optional(),
})
export type SideAnswer = z.infer<typeof SideAnswerSchema>
export type SidePane = SideAnswer['panes'][number]

/** What the asking screen has in front of it: the project, the agent, and the folders it has open. */
export const SideAskSchema = z.strictObject({
  project: NAME,
  /** The agent in front of it, by its task id here, or none. */
  agent: NAME.nullable(),
  /** The FILES folders it has open, as paths in the tree; the tree is asked for only where `files`. */
  expanded: z.array(TEXT).max(SIDE_MOST.expanded),
  /** Whether its FILES section is open: a tree nobody is looking at is not read. */
  files: z.boolean(),
  /** Whether the agent in front's ACTIONS tab is shown: work nobody is looking at is not read. */
  actions: z.boolean().optional(),
})
export type SideAsk = z.infer<typeof SideAskSchema>

/** The window's half: the project as it would draw it, or null where it is not open here. */
export type WebSide = (ask: SideAsk) => Promise<SideAnswer | null>

/** The route. `side` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function sideHere(
  req: IncomingMessage,
  side: WebSide | undefined,
): Promise<{ body: SideAnswer } | { refusal: Refusal }> {
  if (side === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const ask = SideAskSchema.safeParse(got.body)
  if (!ask.success) return { refusal: refuse('malformed') }
  const answer = await side(ask.data)
  if (answer === null) return { refusal: refuse('no_such') }
  // What leaves is what the schema says may: a field nobody decided on stays here.
  return { body: SideAnswerSchema.parse(answer) }
}

import type { IncomingMessage } from 'node:http'
import { type Inventory, InventorySchema } from '@tade/core'
import { z } from 'zod'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// What this machine is, for another machine of the person's that links to it
// as an owner: which Tade it runs, how its public
// name stands, what has gone wrong in it, what its schedules and watches last
// found, and which documents its work produced — the half of "everything about
// a remote" the projection does not carry, because a phone has no use for it
// and every frame would pay for it.
//
// **An owner's, and only at this machine's own door** (`here` in `routes.ts`),
// for the reason its neighbours give: what makes it no wider than what already
// was is that an owner is the SSH key (`owner.ts`), and whoever holds it can
// already `ssh` in and run `tade status`, `tade schedules`, read the config's
// warnings and the journal's. **And a paired device's**, on any door: every
// one is the person's own — off this machine's door it is asked a trusted
// origin and the passkey, as acting is.
//
// **Tade's own words, and nobody's path.** Everything here is a sentence this
// machine's Tade wrote — a problem, a look's reason, a schedule's cadence — or a
// name; a document is named by its file's name and never by where it is kept.
// It changes nothing and writes nothing, and every value is bounded, because
// the machine that reads it reads it as another machine's.

/** How many of each list one answer carries; past that, the newest are kept. */
export const PROBLEMS_MOST = 40
export const SCHEDULES_MOST = 64
export const LOOKS_MOST = 5
export const FOUND_MOST = 5
export const DOCUMENTS_MOST = 64

/** A sentence this machine's Tade wrote, bounded. */
const Said = z.string().max(600)
/** A moment, as an ISO string. */
const At = z.string().max(40)

const HealthSchema = z.object({ said: Said, loud: z.boolean() })

/** Where a problem was found: what to go and look at about it. */
export const PROBLEM_FROM = ['config', 'extension', 'away', 'journal'] as const

const ProblemSchema = z.object({
  from: z.enum(PROBLEM_FROM),
  /** When it was written down, where it was; null for what is true now. */
  at: At.nullable(),
  said: Said,
})

const LookSchema = z.object({
  at: At,
  found: z.int().nonnegative(),
  fresh: z.int().nonnegative(),
  left: z.int().nonnegative(),
  /** Why it could not look; null where it did. */
  problem: Said.nullable(),
  /** Why it found nothing, where the watch said; never a problem. */
  said: Said.nullable(),
  /** The machine it left the watch to instead of looking. */
  on: z.string().max(40).nullable(),
})

const FoundSchema = z.object({
  at: At,
  key: z.string().max(200),
  /** What the outside source called it: `requests`'s, null without it. */
  title: z.string().max(400).nullable(),
  /** The work started on it there, by its task id; null where it was told instead. */
  task: z.string().max(200).nullable(),
})

const ScheduleSchema = z.object({
  id: z.string().max(120),
  name: z.string().max(200),
  project: z.string().max(200),
  kind: z.enum(['agent', 'ask', 'watch']),
  /** When it runs, in this machine's words. */
  when: Said,
  paused: z.boolean(),
  /** Its next run, or null where it has nothing left to run. */
  next: At.nullable(),
  watch: z
    .object({
      /** `<extension>.<watch>`. */
      id: z.string().max(120),
      /** Newest first. */
      looks: z.array(LookSchema).max(LOOKS_MOST),
      /** What its looks found, newest first. */
      found: z.array(FoundSchema).max(FOUND_MOST),
    })
    .nullable(),
})

const DocumentSchema = z.object({
  /** The task that produced it: `<project>/<task>`. */
  task: z.string().max(200),
  project: z.string().max(200),
  /** Its file's name, which is what `/api/document` is asked for. Never a path. */
  name: z.string().max(200),
  state: z.enum(['written', 'missing', 'deleted', 'gone']),
  /** When it finished, or was handed over. */
  at: At,
  bytes: z.int().nonnegative().nullable(),
  /** Somebody read it and said what they decided. */
  triaged: z.boolean(),
})

/**
 * How this machine's orchestrator stands, as only its window knows: what the
 * machine that reloads every machine reads to say a reload is due, and to say
 * after one whether the two orchestrators came back as one conversation
 * (`@tade/app`'s `fleet-reload.ts`). Tade's own words, never the model's.
 */
export const OrchestratorStandingSchema = z.object({
  /** Coming up, up, or it did not start (`said` says why). */
  state: z.enum(['starting', 'up', 'failed']),
  /** Why it did not start, as this Tade said it: a sign-in, a model. Null while it is not failed. */
  said: Said.nullable(),
  /** Its conversation is one on every machine: its harness keeps one, and it was opened. */
  shares: z.boolean(),
  /** The hub its conversation is one with, by this machine's name for it; null where it keeps the lease or is apart. */
  joined: z.string().max(120).nullable(),
  /** The model its config chose for it, or null where the harness picks. */
  model: z.string().max(200).nullable(),
})
export type OrchestratorStanding = z.infer<typeof OrchestratorStandingSchema>

/**
 * The answer, as this machine gives it and another reads it: read for its
 * shape and nothing more — another field from a newer Tade is let be — and
 * every value bounded, because it was written on another machine.
 */
export const MachineAnswerSchema = z.object({
  /** This machine's own clock when it answered. */
  at: At,
  /** The Tade it runs, as its package says. */
  version: z.string().max(40),
  /** The Updates check's clause for a newer Tade, or null where none is known. */
  newer: Said.nullable(),
  /**
   * The checkout it runs from and the commit it started on, or null for an
   * install: what a reload of every machine moves forward by commit, since a
   * checkout's version says nothing of where it is. Absent from an older Tade.
   */
  checkout: z
    .object({
      root: z.string().min(1).max(4096),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
    })
    .nullable()
    .optional(),
  /** Its public name and how it stands, or null for a machine with none. */
  public: z
    .object({
      name: z.string().max(253),
      /** Whether its listener is up for that name now. */
      up: z.boolean(),
      /** The certificate and the version, loudest first (`PublicHealth.lines`). */
      health: z.array(HealthSchema).max(8),
    })
    .nullable(),
  /** What has gone wrong here, as this Tade said it: the config, an extension, the away view, the journal. */
  problems: z.array(ProblemSchema).max(PROBLEMS_MOST),
  schedules: z.array(ScheduleSchema).max(SCHEDULES_MOST),
  documents: z.array(DocumentSchema).max(DOCUMENTS_MOST),
  /**
   * What it has (`@tade/core`'s `inventory.ts`): sign-ins, keys and where each
   * is set, by name and digest and never by value — live here, and kept off
   * the journal there. Null where it has not looked yet; absent from an older
   * Tade, which says nothing of it.
   */
  inventory: InventorySchema.nullable().optional(),
  /** How its orchestrator stands; absent from an older Tade, which says nothing of it. */
  orchestrator: OrchestratorStandingSchema.optional(),
  /**
   * How its away view stands, for the strip's count of machines whose away
   * view is up and the tab each has on the AWAY VIEW panel: whether it
   * listens, and its devices paired and connected now. Absent from an older Tade.
   */
  away: z
    .object({
      on: z.boolean(),
      paired: z.int().nonnegative(),
      connected: z.int().nonnegative(),
    })
    .optional(),
})
export type MachineAnswer = z.infer<typeof MachineAnswerSchema>
export type ScheduleHere = MachineAnswer['schedules'][number]
export type DocumentHere = MachineAnswer['documents'][number]
export type ProblemHere = MachineAnswer['problems'][number]

/** The window's half: everything above as it holds it now, for every project. */
export type WebMachine = () => Promise<MachineAnswer>

/** The route. `machine` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function machineHere(
  req: IncomingMessage,
  machine: WebMachine | undefined,
): Promise<{ body: MachineAnswer } | { refusal: Refusal }> {
  if (machine === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  if (!z.strictObject({}).safeParse(got.body).success) return { refusal: refuse('malformed') }
  return { body: machineFor(await machine()) }
}

/**
 * What a device is answered: every list within its bound —
 * the newest kept, because they arrive newest first — and every sentence cut
 * to what the other machine reads, so nothing here makes it refuse the whole.
 */
export function machineFor(all: MachineAnswer): MachineAnswer {
  const said = (text: string | null) => (text === null ? null : cut(text, 600))
  return {
    at: all.at,
    version: cut(all.version, 40),
    newer: said(all.newer),
    ...(all.checkout === undefined ? {} : { checkout: all.checkout }),
    public:
      all.public === null
        ? null
        : {
            name: cut(all.public.name, 253),
            up: all.public.up,
            health: all.public.health
              .slice(0, 8)
              .map((one) => ({ said: cut(one.said, 600), loud: one.loud })),
          },
    problems: all.problems
      .slice(0, PROBLEMS_MOST)
      .map((one) => ({ ...one, said: cut(one.said, 600) })),
    schedules: all.schedules.slice(0, SCHEDULES_MOST).map((one) => ({
      ...one,
      name: cut(one.name, 200),
      when: cut(one.when, 600),
      watch:
        one.watch === null
          ? null
          : {
              id: one.watch.id,
              looks: one.watch.looks
                .slice(0, LOOKS_MOST)
                .map((look) => ({ ...look, problem: said(look.problem), said: said(look.said) })),
              found: one.watch.found.slice(0, FOUND_MOST).map((found) => ({
                ...found,
                key: cut(found.key, 200),
                title: found.title !== null ? cut(found.title, 400) : null,
              })),
            },
    })),
    documents: all.documents
      .slice(0, DOCUMENTS_MOST)
      .map((one) => ({ ...one, name: cut(one.name, 200) })),
    inventory: all.inventory ? inventoryFor(all.inventory) : null,
    ...(all.orchestrator === undefined
      ? {}
      : {
          orchestrator: {
            ...all.orchestrator,
            said: said(all.orchestrator.said),
            joined: all.orchestrator.joined === null ? null : cut(all.orchestrator.joined, 120),
            model: all.orchestrator.model === null ? null : cut(all.orchestrator.model, 200),
          },
        }),
    ...(all.away === undefined ? {} : { away: all.away }),
  }
}

/**
 * The inventory as a device is told it: every value within what the other
 * machine reads — cut rather
 * than refused, so a long path never costs the whole answer.
 */
function inventoryFor(all: Inventory): Inventory {
  return {
    machine: cut(all.machine, 120),
    at: all.at,
    shell: all.shell === null ? null : cut(all.shell, 40),
    service: all.service,
    items: all.items.slice(0, 400).map((one) => ({
      ...one,
      id: cut(one.id, 300),
      label: cut(one.label, 300),
      where: one.where.slice(0, 16).map((place) => cut(place, 300)),
      said: one.said === null ? null : cut(one.said, 600),
      variables: one.variables.slice(0, 8).map((name) => cut(name, 120)),
    })),
  }
}

/** A string at most `most` long, with an ellipsis where it was cut. */
function cut(text: string, most: number): string {
  return text.length <= most ? text : `${text.slice(0, most - 1)}…`
}

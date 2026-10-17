import type { IncomingMessage } from 'node:http'
import { DONE_RULES } from '@tade/core'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { sees } from './reach.ts'
import { readBody } from './request.ts'
import { reachOf } from './surface.ts'

// Work another machine of the person's hands this one (REMOTE-TADE.md §9.2):
// queued work it was asked to start here instead ("start on vps"), and a task
// whose agent there committed and pushed its branch so the work carries on
// here ("hand to vps"). What arrives is made into queued work in one of this
// machine's projects — a task with `start` — which this window starts by its
// own rule, exactly as it would start work planned at its own keyboard.
//
// **Git is the transport, and the conversation does not move.** What crosses
// is what a task is made of — the person's words verbatim (`intent`), what its
// agent is told (`prompt`), its context file's text, its links and done rule —
// and, for work that was already under way, a branch on the project's own
// `origin` and the commit it must be on (`begins`). This machine fetches that
// with **its own credentials**, never the asking machine's (the link never
// forwards an agent, `NO_AGENT`), and begins a worktree there (`start.from`).
// No session, model or harness choice crosses: each belongs to the machine it
// ran on, and a model is resolved by the harness it is for.
//
// **An owner's, and only at this machine's own door** (`here` in
// `routes.ts`). It is the one route that makes work, and what keeps it no
// wider than what already was is who may use it: an owner session is the SSH
// key (`owner.ts`), and whoever holds that key can already `ssh` here and start
// the same work with `tade run start` in that shell. A phone's session is
// refused it however much it was granted (`out_of_scope`); within an owner's
// reach, a project the window took back from it is refused too. Nothing it
// makes is parked or held for anybody: the person pressed for it on their own
// other machine, so it is theirs (`by: you`), and the line written here says
// which machine and which device it came from.
//
// **Asked first, made second** (`check`): the machine handing a running task
// over asks whether this one would take it before telling its agent to push,
// so an agent is never stopped mid-work for a name already used here.
//
// **A hand-over asked twice is answered twice the same** (`handOver`): the
// machine handing it gives each hand-over an id, written here beside what it
// made, and a window there that closed before it heard the answer asks again
// with the same id — `already`, a success there, where the name alone would
// be a no for a name used here, and the work safe here all along.

/** The most of the context file's text one request carries, so the whole stays under `BODY_MAX`. */
export const TAKE_CONTEXT_MOST = 40_000
/** The most of the person's words, and of what its agent is told. */
export const TAKE_WORDS_MOST = 8_000

/** A branch name as git allows it and no shell or git option could be made of. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/@+-]{1,250}$/
/** A commit id, in either of git's hashes. */
const HEAD = /^[0-9a-f]{40,64}$/
/** A project's name, as the config holds one. */
const PROJECT = /^[a-z0-9][a-z0-9-]{0,99}$/
/** A task's own half of its id. */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/
/** A hand-over's id, as the machine handing it made one. */
const HAND_OVER = /^[A-Za-z0-9-]{8,64}$/

export const TakeSchema = z.strictObject({
  /** What the machine handing it calls itself, for the line written here. */
  from: z.string().min(1).max(120),
  /** Its id there, for the same line: `<project>/<task>` on that machine. */
  was: z.string().min(1).max(200),
  /** The project here it is made in. */
  project: z.string().regex(PROJECT),
  /** Its name here, which must never have been used here. */
  name: z.string().regex(SLUG),
  /** The person's words, verbatim, as they were said there. */
  intent: z.string().max(TAKE_WORDS_MOST),
  /** What its agent is told when it starts. */
  prompt: z.string().max(TAKE_WORDS_MOST).default(''),
  /** Its context file's text, as it was there. */
  context: z.string().max(TAKE_CONTEXT_MOST).default(''),
  links: z
    .array(z.strictObject({ title: z.string().max(200), url: z.string().max(2_000) }))
    .max(40)
    .default([]),
  done: z.enum(DONE_RULES).optional(),
  /** Not before this moment, as an ISO time: absolute, so the same on both clocks. */
  at: z.iso.datetime({ offset: true }).optional(),
  /**
   * Where it begins: a branch on the project's `origin`, and the commit the
   * machine handing it saw it pushed at. Absent, it begins where work here
   * begins.
   */
  begins: z
    .strictObject({ branch: z.string().regex(BRANCH), head: z.string().regex(HEAD) })
    .optional(),
  /** Only say whether it would be taken: make nothing, fetch nothing. */
  check: z.boolean().default(false),
  /** The hand-over this finishes, by the id the machine handing it gave it. */
  handOver: z.string().regex(HAND_OVER).optional(),
})
export type Take = z.infer<typeof TakeSchema>

/**
 * What this machine answered. `took: false` is a no in this machine's own
 * words — a project it does not have, a name used here, a branch it could not
 * fetch — which the asking machine says as it is.
 */
export const TakeAnswerSchema = z.union([
  z.object({
    took: z.literal(true),
    /** Its id here; with `check`, the id it would have. */
    task: z.string().max(200),
    /** What happened, in a sentence: what it begins from, and when it starts. */
    said: z.string().max(2_000),
    /**
     * Whether this machine could push to that branch with its own credentials,
     * as a dry run said, where `begins` was given: false is said, never
     * refused — its agent can still work, and somebody can give it a key.
     */
    pushes: z.boolean().nullable().default(null),
    /** Made here already, by an earlier asking of the same hand-over. */
    already: z.boolean().optional(),
  }),
  z.object({ took: z.literal(false), said: z.string().max(2_000) }),
])
export type TakeAnswer = z.infer<typeof TakeAnswerSchema>

/** The window's half: the work made, or why not. `device` is who asked, for the journal. */
export type WebTaking = (take: Take, device: string) => Promise<TakeAnswer>

/** The route. `taking` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function takeHere(
  req: IncomingMessage,
  device: Device,
  taking: WebTaking | undefined,
): Promise<{ body: TakeAnswer } | { refusal: Refusal }> {
  if (taking === undefined) return { refusal: refuse('no_such') }
  if (!device.owner) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const asked = TakeSchema.safeParse(got.body)
  if (!asked.success) return { refusal: refuse('malformed') }
  if (!sees(reachOf(device), asked.data.project)) return { refusal: refuse('out_of_scope') }
  return { body: await taking(asked.data, device.id) }
}

import type { IncomingMessage } from 'node:http'
import { TaskId } from '@tade/core'
import { z } from 'zod'
import { projectOf } from './acting.ts'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { has, sees } from './reach.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs, reachOf } from './surface.ts'

// What to run on this machine to be shown one of its agents and type into it:
// the far half of the terminal another machine's window opens over SSH and
// draws as a pane.
//
// **The one answer in this package that is an attach line**, which every row a
// phone reads promises never to be (`lanes: A COUNT … never an attach line`).
// What makes it no wider than what already was is who may ask and where: an
// owner, which is the SSH key (`owner.ts`), at this machine's own door (`here`
// in `routes.ts`), which from anywhere else is that same SSH connection — and
// the line is for running over it. Whoever holds the key can already `ssh` in
// and type `tmux ls`. A phone's session, whatever it was granted, is refused
// (`out_of_scope`), and the public listener answers the `404` of a path nobody
// built. An owner whose `lanes` the window took back, or who no longer reads
// the project, is answered as for a task that is not there.
//
// **Only this machine knows the line**: its driver, the server and session its
// lanes live in, which window each is. So it is asked for here rather than
// worked out there, and what answers is the driver's own `attachCommand` for a
// pane (`embedded`) — or nothing, where its lanes live inside its window and no
// other terminal can reach them (`remoteAttach`), with the sentence the other
// machine says instead of opening anything.
//
// **An agent's other lanes too**: the shell its pane has a tab for is asked
// for by its id (`lane`), which must be one more segment of that very task's
// — a lane of another task, or anything that walks, is refused as malformed.
//
// **It changes nothing and writes nothing.** A `POST`, because an owner's
// request carries its token and because the answer is something to run; but
// nothing moves here, and nothing goes in the journal: the terminal it opens is
// an SSH session, which is that machine's record and this one's `sshd`'s.

/**
 * One of the task's own lanes beside its agent — a shell its pane has a tab
 * for: the task's id and one more segment, so no name reaches another task's.
 */
const LANE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]{0,63}$/

const AttachBody = z
  .strictObject({ task: TaskId, lane: z.string().max(400).regex(LANE).optional() })
  .refine((body) => body.lane === undefined || body.lane.startsWith(`${body.task}/`))

/** A line to run here for that task's agent, or why there is none. */
export type AttachAnswer = { command: string } | { command: null; why: string }

/**
 * The window's half: the line for one task's agent, as its driver writes it —
 * or, given `lane`, for that lane of the task's (its shell), which is the
 * driver's line for it in the same way.
 */
export type WebAttaching = (task: string, lane?: string) => AttachAnswer

/** Why there is no line for a task this device may not see, which is the same as one not there. */
export const NO_AGENT = 'there is no agent of that task running on this machine'

export async function attachHere(
  req: IncomingMessage,
  device: Device,
  attaching: WebAttaching | undefined,
): Promise<{ body: AttachAnswer } | { refusal: Refusal }> {
  if (attaching === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = AttachBody.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  const task = parsed.data.task
  const reach = reachOf(device)
  if (!has(reach, 'lanes') || !sees(reach, projectOf(task))) {
    return { body: { command: null, why: NO_AGENT } }
  }
  const lane = parsed.data.lane
  return { body: lane === undefined ? attaching(task) : attaching(task, lane) }
}

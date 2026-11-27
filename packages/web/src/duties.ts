import type { IncomingMessage } from 'node:http'
import { type DutiesAnswer, type DutiesAsk, DutiesBody } from '@tade/core'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// Whose each duty is, when one repository is a project on several of the
// person's machines (`@tade/core`'s `duties.ts`): the machine that holds the
// link claims what it would do — a repository's watches, a batch at a commit,
// the merge of a parting — and this machine, as the hub, answers whose each
// one is, beside the turn lease it keeps for the same machines.
//
// **An owner's, at this machine's own door** (`here`), like the conversation
// and the journal beside it — **and a paired phone**, every one being the person's own:
// what a claim can do is have a watch here hold off, which an `ssh` to this
// box could do by editing its config, and what it reads is whose a duty is.
//
// **Bounded, and checked as text before anything reads it** (`DutiesBody`).

/** The heart's half: the claims answered by the board this machine keeps. Throws the reason. */
export type WebDuties = (ask: DutiesAsk) => Promise<DutiesAnswer>

/** The route. `duties` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function dutiesHere(
  req: IncomingMessage,
  _device: Device,
  duties: WebDuties | undefined,
): Promise<{ body: DutiesAnswer } | { refusal: Refusal }> {
  if (duties === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const ask = DutiesBody.safeParse(got.body)
  if (!ask.success) return { refusal: refuse('malformed') }
  return { body: await duties(ask.data) }
}

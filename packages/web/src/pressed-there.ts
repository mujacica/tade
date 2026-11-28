import type { IncomingMessage } from 'node:http'
import { MACHINE_NAMED, TaskId } from '@tade/core'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'
import { KEY } from './verbs.ts'

// A press on another machine's row, from this door's page (ONE-AWAY-VIEW
// §2.5): ipax's page on the Mac's agent, where the Mac links to ipax and ipax
// can never call it. The press is put in this machine's outbox for that one
// (`@tade/app`'s `MachineActs.pressed`), which that machine takes on its beat,
// runs through its own gate under the arm it gives an outbox (`outboxArm`)
// and answers in its next ask — so what may be done there is that machine's
// to decide, and it is the tidy tier alone (Q3b; security audit S2): whoever
// controls a hub writes its outbox, so nothing in one may type into an agent
// there or tell its agents a note.
//
// **This door names the presses too**, a short list it maps to that
// machine's tool methods itself: stop, close, park, and pausing or resuming
// queued work — the tidy tier, so it carries nothing that machine would refuse. Nothing a page sends becomes a method name, so a
// page — or anything that took one over — can ask for nothing else of the
// door either, whatever the far gate would say.
//
// **Any paired device**: every one is the person's own, and is sent the other
// machines' rows (`sentCopies`, `wire/web.ts`). An owner link is a machine whose SSH key
// reaches everything here already. The tiers are that machine's (`outboxArm`)
// and are about another *machine*, not a device.
//
// **Done once.** The page's key, bound to the device that sent it, travels
// with the act: this machine's outbox holds one act a key, and the far side
// answers one asked again with what it did the first time.

const Task = TaskId

const Machine = z.string().regex(MACHINE_NAMED)

const On = { machine: Machine, key: z.string().regex(KEY) }

const PressText = z.discriminatedUnion('verb', [
  z.strictObject({ ...On, verb: z.literal('stop'), task: Task, confirm: z.literal(true) }),
  // Closing one that is not running, never forced: that machine keeps what is not merged.
  z.strictObject({ ...On, verb: z.literal('close'), task: Task }),
  z.strictObject({ ...On, verb: z.literal('park'), task: Task, parked: z.boolean() }),
  z.strictObject({
    ...On,
    verb: z.literal('queue'),
    change: z.enum(['pause', 'resume']),
    task: Task,
  }),
  z.strictObject({
    ...On,
    verb: z.literal('queue project'),
    change: z.enum(['pause', 'resume']),
    project: z.string().regex(MACHINE_NAMED),
  }),
])

export type PressThere = z.infer<typeof PressText>

/** The presses this door carries to another machine, by the word the page sends. */
export const PRESSES_THERE = ['stop', 'close', 'park', 'queue', 'queue project'] as const

/** One of that machine's tool methods and its parameters, for a press: this door's own mapping. */
export function methodOf(press: PressThere): { method: string; params: Record<string, unknown> } {
  switch (press.verb) {
    case 'stop':
      return { method: 'worker/stop', params: { task: press.task } }
    case 'close':
      return { method: 'worker/close', params: { task: press.task } }
    case 'park':
      return { method: 'task/park', params: { task: press.task, parked: press.parked } }
    case 'queue':
      return { method: 'queue/change', params: { task: press.task, change: press.change } }
    case 'queue project':
      return { method: 'queue/change', params: { project: press.project, change: press.change } }
  }
}

/** What a press there came to: done, with that machine's word, or not, with why. */
export interface PressedThere {
  ok: boolean
  said: string
}

/** The window's half: a press into the outbox for `machine`, answered once that machine has run it. */
export interface WebPressThere {
  press(req: {
    machine: string
    key: string
    method: string
    params: Record<string, unknown>
  }): Promise<PressedThere>
}

/** `POST /api/there/press`: one press on another machine's row, carried there and answered. */
export async function pressThereHere(
  req: IncomingMessage,
  device: Device,
  there: WebPressThere | undefined,
): Promise<{ body: PressedThere } | { refusal: Refusal }> {
  if (there === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = PressText.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  const { method, params } = methodOf(parsed.data)
  return {
    body: await there.press({
      machine: parsed.data.machine,
      // Bound to the device, so two devices' keys never name one act.
      key: `${device.id}-${parsed.data.key}`,
      method,
      params,
    }),
  }
}

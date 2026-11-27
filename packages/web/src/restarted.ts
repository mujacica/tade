import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// Restarting Tade from the person's own phone: the window started again on the
// code that is on disk now, as its own reload does (ctrl+r's `reload`, the
// orchestrator's `tade_reload`) — what the page's restart bar asks for when
// Tade's code changed since it started.
//
// **The SSH key's, as the Machines page is** (`here` in `routes.ts`):
// starting Tade again is what the SSH key that started it may do, and every
// paired device is the person's own. Off this machine's door it is asked a
// trusted origin and the passkey, as acting is.
//
// **A target plus the state it expects**, like every verb: the body names how
// many lanes the device was told would stop, and the window asks again at the
// press. Where the driver's lanes outlive the window that is nought and one
// press restarts; where they would stop, the first press is answered with how
// many and nothing is done, so ending work is always a second press on a
// number somebody was shown — the window's reload panel, asked from away.

/** What a press is answered. */
export interface RestartAnswer {
  /** Tade is starting again: this answer goes out first, then the window ends. */
  restarting: boolean
  /** How many lanes run inside this window and would stop; null where this Tade cannot restart itself. */
  stops: number | null
  /** Why it cannot, in the window's words, where it cannot; null otherwise. */
  said: string | null
}

/** The window's half. */
export interface WebRestarting {
  /** How many lanes a restart would end now, or why this Tade cannot start itself again. */
  standing(): { stops: number } | { cannot: string }
  /**
   * Start again once the answer is on its way, written down as this device's.
   * `link` is another of the person's machines asking (an owner device,
   * `owner.ts`): its own reload of every machine is what asked, so this
   * machine alone starts again. A person's press reloads every machine.
   */
  restart(device: string, link: boolean): void
}

/** The lanes the device was told would stop: nought on a first press. */
const RestartBody = z.strictObject({ stops: z.int().nonnegative().max(100_000) })

/** `POST /api/restart`: start Tade again, or say what pressing again would stop. */
export async function restartHere(
  req: IncomingMessage,
  device: Device,
  restarting: WebRestarting | undefined,
): Promise<{ body: RestartAnswer } | { refusal: Refusal }> {
  if (restarting === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = RestartBody.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  const now = restarting.standing()
  if ('cannot' in now) return { body: { restarting: false, stops: null, said: now.cannot } }
  // Work that would stop is only ever stopped on the number somebody was shown.
  if (now.stops !== parsed.data.stops) {
    return { body: { restarting: false, stops: now.stops, said: null } }
  }
  restarting.restart(device.id, device.owner)
  return { body: { restarting: true, stops: now.stops, said: null } }
}

// The orchestrator alone started again, on what it is signed in as now: what
// `/login` on this machine's tab on another of the person's machines ends in
// (`Carries.signInOrchestrator` there). Its harness runs headless and keeps
// the sign-in it started with, so a sign-in made over the link reaches it only
// once it starts again — its conversation carried, as on any restart. A
// paired device's and an owner's, as `/api/restart` is: a smaller act than that one, which
// the same SSH key may already do. Nothing it asks for stops a lane.

/** What a press to start the orchestrator again is answered. */
export interface OrchestratorRestartAnswer {
  /** It is starting again, once any turn it is in is over. */
  restarting: boolean
  /** Why it is not, in the window's words, where it is not; null otherwise. */
  said: string | null
}

/** The window's half. */
export interface WebOrchestratorRestart {
  /** Start the orchestrator again, written down as this device's; why not, where it cannot be. */
  restart(device: string): { restarting: true } | { cannot: string }
}

/** Nothing is asked for: which account it runs as is this machine's to say. */
const OrchestratorRestartBody = z.strictObject({})

/** `POST /api/orchestrator/restart`: start the orchestrator again on its sign-in now. */
export async function orchestratorRestartHere(
  req: IncomingMessage,
  device: Device,
  restarting: WebOrchestratorRestart | undefined,
): Promise<{ body: OrchestratorRestartAnswer } | { refusal: Refusal }> {
  if (restarting === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  if (!OrchestratorRestartBody.safeParse(got.body).success) return { refusal: refuse('malformed') }
  const did = restarting.restart(device.id)
  if ('cannot' in did) return { body: { restarting: false, said: did.cannot } }
  return { body: { restarting: true, said: null } }
}

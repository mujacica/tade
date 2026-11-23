import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'
import { fullAccessLacks, ownsOrTheirs } from './surface.ts'

// Restarting Tade from the person's own phone: the window started again on the
// code that is on disk now, as its own reload does (ctrl+r's `reload`, the
// orchestrator's `tade_reload`) — what the page's restart bar asks for when
// Tade's code changed since it started.
//
// **Theirs, as the Machines page is** (`here` and `theirs` in `routes.ts`):
// starting Tade again is what the SSH key that started it may do, and the
// person decided their phone may do what they can. Off this machine's door it
// is asked a trusted origin and the passkey, as acting is; every other session
// is refused it however much it was granted.
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
  /** Start again once the answer is on its way, written down as this device's. */
  restart(device: string): void
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
  // Every box it lacks for full access, named: ticking it at the machine is the whole fix.
  if (!ownsOrTheirs(device)) {
    return { refusal: refuse('out_of_scope', { needs: fullAccessLacks(device) }) }
  }
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
  restarting.restart(device.id)
  return { body: { restarting: true, stops: now.stops, said: null } }
}

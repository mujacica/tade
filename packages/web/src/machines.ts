import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs } from './surface.ts'

// The Machines page, for the person's own phone: what each of their machines
// has, item by item — the window's Settings › Machines grid, a row per sign-in,
// key, environment key, MCP server, git identity, origin, app and public name,
// a column per machine — and the one move that page offers beyond looking
// again: the keys the shell's files set, moved into one file, shown first as a
// diff with every value hidden and done only on a second press.
//
// **Theirs, as `/api/machine` is** (`here` and `theirs` in `routes.ts`): what
// it reads is what `tade machine` over the SSH key reads, and what the move
// edits is the person's own shell files, which the same key can edit. The
// person decided their phone may do what they can — off this machine's door it
// is asked a trusted origin and the passkey, as acting is — and every other
// session is refused it however much it was granted.
//
// **Nothing here waits on the look or the move.** A press starts it and is
// answered with the page as it stands; the page asks again while `looking` or
// `busy` says something is under way, so no request is held open for the
// minute a look may take. Every word is the window's own: the grid is
// `machineGrid`'s, the move's sentences `applyConsolidation`'s, the file's name
// and the warning between the presses `ENV_FILE_SAID` and `KEYS_AND_AGENTS`.

/** One machine's column. */
export interface MachinesColumn {
  machine: string
  /** When what it said was heard, as an ISO moment; null for this machine, or never. */
  asOf: string | null
  /** This machine. */
  here: boolean
  /** Why it has nothing to say, where it has not. */
  said: string | null
  /** Where it and this machine stand (`syncSaid`): `in step`, `behind by 3 lines`. Null where not compared. */
  synced?: string | null
}

/** One cell: `✓` set, `✗` missing, `≠` a different key, `—` not used there, `?` cannot tell. */
export interface MachinesCell {
  mark: string
  /** Whole days a sign-in has left, where it says. */
  days: number | null
  /** Where it is set on that machine: `~/.zshenv:14`. */
  where: readonly string[]
  /** What is wrong with it, or what it is, in the window's words. */
  said: string | null
}

export interface MachinesRow {
  id: string
  kind: string
  label: string
  /** One per column, in the columns' order. */
  cells: readonly MachinesCell[]
}

/** What moving the keys would do, shown before the press that does it. */
export interface MachinesPlan {
  /** The lines that change, every value hidden. */
  diff: readonly string[]
  moved: readonly string[]
  left: readonly { name: string; where: string; why: string }[]
}

/** The page as it stands. */
export interface MachinesAnswer {
  /** Null before this machine's first look has come back. */
  columns: readonly MachinesColumn[] | null
  rows: readonly MachinesRow[]
  /** A look here is under way. */
  looking: boolean
  /** The plan shown, before a press moves the keys; null where none is. */
  plan: MachinesPlan | null
  /** Working the plan out, or moving the keys. */
  busy: boolean
  /** What the last move said, whatever happened. */
  said: string | null
  /** The one file the keys move into, as the window names it. */
  file: string
  /** What is said between the two presses: any agent can read a key written down. */
  agents: string
}

/** What a press on the page may ask: look again, work out the move, move, or leave them. */
export const MACHINES_PRESSES = ['look', 'plan', 'move', 'leave'] as const
export type MachinesPress = (typeof MACHINES_PRESSES)[number]

/** The window's half. */
export interface WebMachines {
  /** The page as the window holds it now. Never waits. */
  shown(): MachinesAnswer
  /**
   * A press, started and not waited on; `by` is `device <id>`. False where
   * `move` was asked with no plan shown — nothing is moved that nobody saw.
   */
  press(press: MachinesPress, by: string): boolean
}

/** `POST /api/machines`: the page. */
export async function machinesHere(
  req: IncomingMessage,
  device: Device,
  machines: WebMachines | undefined,
): Promise<{ body: MachinesAnswer } | { refusal: Refusal }> {
  if (machines === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  if (!z.strictObject({}).safeParse(got.body).success) return { refusal: refuse('malformed') }
  return { body: machines.shown() }
}

const PressSchema = z.strictObject({ press: z.enum(MACHINES_PRESSES) })

/**
 * `POST /api/machines/press`: one press, then the page as it stands. A move
 * with no plan shown is `gone` — the plan somebody saw was left or moved
 * while they looked — rather than worked out and done in one blind press.
 */
export async function machinesPressHere(
  req: IncomingMessage,
  device: Device,
  machines: WebMachines | undefined,
): Promise<{ body: MachinesAnswer } | { refusal: Refusal }> {
  if (machines === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = PressSchema.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  if (!machines.press(parsed.data.press, `device ${device.id}`)) return { refusal: refuse('gone') }
  return { body: machines.shown() }
}

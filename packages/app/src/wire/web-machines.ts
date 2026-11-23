import { ENV_FILE_SAID, KEYS_AND_AGENTS, printable } from '@tade/core'
import type { MachinesAnswer, WebMachines } from '@tade/web'
import { CANCEL } from '../panels/settings/machines.ts'
import { type Wiring, why } from './context.ts'
import type { Inventories } from './inventory.ts'
import { HELD_DOES, heldSaid, type WaitingThere, waitingSaid } from './notes-shared.ts'

// The Machines page as this window answers the person's own phone
// (`@tade/web`'s `machines.ts`): what Settings › Machines draws, out of the
// same subject, and a press on it through the same doors the page's own
// presses go through — so a phone and the keyboard never see two grids or
// move the keys two ways. A move is written down as the device's
// (`env_consolidated`'s `by`), never as `you`.
//
// **And a change another machine gave to a note taken here** (`Memory.held`),
// taken or left from the phone as from Settings › Remotes, written in
// `memory.jsonl` as the device's press. Read from the file each time the page
// asks, which is a request and not a frame. **And a change made here that
// waits for a press on the machine its note was taken on** (`WaitingThere`),
// only to look at: the press is that machine's.

/** What of the inventory subject the page reads and presses. */
export type MachinesHeld = Pick<Inventories, 'shown' | 'look' | 'planMove' | 'move' | 'action'>

export function machinesFrom(
  wire: Wiring,
  inventory: MachinesHeld,
  waiting?: WaitingThere,
): WebMachines {
  const started = (doing: Promise<unknown>) =>
    void doing.catch((err: unknown) =>
      wire.note(new Error(`A press from away failed: ${why(err)}`)),
    )
  const memory = () => wire.opts.client.memory
  return {
    shown: () => ({
      ...answerOf(inventory),
      notes: notesOf(wire),
      waiting: waitingOf(wire, waiting),
    }),
    press: (press, by) => {
      if (press === 'look') started(inventory.look(true))
      else if (press === 'plan') started(inventory.planMove())
      else if (press === 'leave') started(inventory.action(CANCEL))
      else {
        // Only the plan somebody was shown is moved: one left or moved while
        // they looked is refused, never worked out again and done unseen.
        if (inventory.shown()?.plan == null) return false
        started(inventory.move(by))
      }
      return true
    },
    settle: (note, answer, by) => {
      if (
        !memory()
          .held()
          .some((one) => one.digest === note)
      )
        return false
      memory().settle(note, answer, by, wire.now())
      return true
    },
  }
}

/** The changes to notes taken here waiting for a press, as the page says them. */
function notesOf(wire: Wiring): MachinesAnswer['notes'] {
  return wire.opts.client.memory.held().map((one) => ({
    id: one.digest,
    label: `${HELD_DOES[one.kind]} on ${printable(one.from)}`,
    note: printable(one.note.text),
    said: heldSaid(one),
  }))
}

/** The changes made here waiting for a press where their note was taken, as the page says them. */
function waitingOf(wire: Wiring, waiting: WaitingThere | undefined): MachinesAnswer['waiting'] {
  return (waiting?.shown(wire.opts.client.memory) ?? []).map(({ machine, change }) => ({
    id: change.digest,
    label: `${HELD_DOES[change.kind]} · waits on ${printable(machine)}`,
    note: printable(change.note.text),
    said: waitingSaid(machine, change),
  }))
}

function answerOf(inventory: MachinesHeld): Omit<MachinesAnswer, 'notes' | 'waiting'> {
  const shown = inventory.shown()
  const words = { file: ENV_FILE_SAID, agents: KEYS_AND_AGENTS }
  if (shown === null) {
    return { columns: null, rows: [], looking: true, plan: null, busy: false, said: null, ...words }
  }
  return {
    columns: shown.columns.map((one) => ({
      machine: one.machine,
      asOf: one.asOf === null ? null : new Date(one.asOf).toISOString(),
      here: one.here,
      said: one.said,
      // Only where the two were compared, so a page from before says what it did.
      ...(one.synced ? { synced: one.synced } : {}),
      ...(one.trouble ? { trouble: one.trouble } : {}),
    })),
    rows: shown.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      cells: row.cells.map((cell) => ({
        mark: cell.mark,
        days: cell.days,
        where: [...cell.where],
        said: cell.said,
      })),
    })),
    looking: shown.looking,
    plan:
      shown.plan === null
        ? null
        : {
            diff: [...shown.plan.diff],
            moved: [...shown.plan.moved],
            left: shown.plan.left.map((one) => ({ ...one })),
          },
    busy: shown.busy,
    said: shown.said,
    ...words,
  }
}

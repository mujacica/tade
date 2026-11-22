import { ENV_FILE_SAID, KEYS_AND_AGENTS } from '@tade/core'
import type { MachinesAnswer, WebMachines } from '@tade/web'
import { CANCEL } from '../panels/settings/machines.ts'
import { type Wiring, why } from './context.ts'
import type { Inventories } from './inventory.ts'

// The Machines page as this window answers the person's own phone
// (`@tade/web`'s `machines.ts`): what Settings › Machines draws, out of the
// same subject, and a press on it through the same doors the page's own
// presses go through — so a phone and the keyboard never see two grids or
// move the keys two ways. A move is written down as the device's
// (`env_consolidated`'s `by`), never as `you`.

/** What of the inventory subject the page reads and presses. */
export type MachinesHeld = Pick<Inventories, 'shown' | 'look' | 'planMove' | 'move' | 'action'>

export function machinesFrom(wire: Wiring, inventory: MachinesHeld): WebMachines {
  const started = (doing: Promise<unknown>) =>
    void doing.catch((err: unknown) =>
      wire.note(new Error(`A press from away failed: ${why(err)}`)),
    )
  return {
    shown: () => answerOf(inventory),
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
  }
}

function answerOf(inventory: MachinesHeld): MachinesAnswer {
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

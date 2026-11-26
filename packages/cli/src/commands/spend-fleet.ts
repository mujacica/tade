import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type FleetSpend,
  fleetSpendFrom,
  type MachineLines,
  machineLabel,
  type PriceTable,
  RUNTIME_EVENTS,
  type Spend,
  type SpendWindow,
} from '@tade/core'
import { readJournal } from '@tade/workbench/events'
import { copiesHeld, readCopy } from '@tade/workbench/feeds'
import { ifMissing, readMachine } from '@tade/workbench/machine-file'

// `tade spend --fleet`: every machine of the person's, a row each, and a
// bottom line that adds them (`fleetSpendFrom`, ONE-AWAY-VIEW §2.6) — out of
// this machine's own journal and the copy of each other machine's kept here
// (`readFeeds`'s copies, the current epoch of each). A question, so it reads
// the files and never opens the workbench.
//
// **When a copy was last brought up to date is when its file last moved**,
// which is all a terminal can know with no window to ask: a machine that has
// written nothing for a minute reads as not heard lately, and the total says
// it is a floor because of it — which is the honest answer, since nothing here
// can say that machine did nothing since.

/** Every machine's spend, as this home holds it. */
export async function fleetSpendHere(
  home: string,
  window: { since: number; prices?: PriceTable; accounts?: SpendWindow['accounts'] },
  now: number,
): Promise<FleetSpend> {
  const types = ['usage' as const, ...RUNTIME_EVENTS]
  const mine = await readMachine(home)
  const machines: MachineLines[] = [
    {
      name: machineLabel(),
      id: mine?.id ?? 'this machine',
      here: true,
      events: await readJournal(home, { types: [...new Set(types)] }),
      heardAt: now,
    },
  ]
  for (const held of await copiesHeld(home)) {
    if (held.lines === 0 || held.meta.machine === mine?.id) continue
    const events = await readCopy(home, held.meta, { types: [...new Set(types)] })
    if (events === null) continue
    const moved = await stat(join(home, 'machines', held.meta.machine, 'events.jsonl')).catch(
      ifMissing(null),
    )
    machines.push({
      name: held.sync?.called ?? held.meta.name,
      id: held.meta.machine,
      here: false,
      events,
      heardAt: moved === null ? null : moved.mtimeMs,
      forkedAt: held.meta.forks.at(-1)?.at ?? null,
    })
  }
  return fleetSpendFrom(machines, window, now)
}

/** Why a total is a floor, in words: the machines that make it one. */
export function floorSaid(fleet: FleetSpend): string | null {
  if (fleet.atLeast.length === 0) return null
  const why = {
    partial: 'held some work back',
    'not heard lately': 'not heard in the last minute',
    'never heard': 'never heard',
  }
  return `at least: ${fleet.atLeast.map((one) => `${one.name} ${why[one.why]}`).join(', ')}`
}

/** The lines `tade spend --fleet` prints: a row a machine, then the bottom line. */
export function fleetLines(
  fleet: FleetSpend,
  row: (name: string, width: number, spend: Spend) => string,
): string[] {
  const names = fleet.rows.map((one) => (one.here ? `${one.name} (here)` : one.name))
  const width = Math.max(...names.map((one) => one.length), 'every machine'.length)
  const out = ['every machine, each by its own journal']
  fleet.rows.forEach((one, at) => {
    const forked =
      one.forkedAt === null
        ? ''
        : `  (history before the restore of ${one.forkedAt.slice(0, 10)} is not counted)`
    out.push(`  ${row(names[at] ?? one.name, width, one.spend)}${forked}`)
  })
  const floor = floorSaid(fleet)
  out.push(`  ${row('every machine', width, fleet.total)}${floor === null ? '' : `  ≥ ${floor}`}`)
  return out
}

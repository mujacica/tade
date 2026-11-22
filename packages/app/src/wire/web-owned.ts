import type { Inventory } from '@tade/core'
import type { Wiring } from './context.ts'
import type { Inventories } from './inventory.ts'
import { notesFor } from './notes-shared.ts'
import { watchSeenFrom } from './watch-seen.ts'
import { attachingFor } from './web-attach.ts'
import type { Lifecycle } from './web-lifecycle.ts'
import { documentFrom, machineFrom, toolFrom } from './web-machine.ts'
import { type MachinesHeld, machinesFrom } from './web-machines.ts'
import { openingFrom } from './web-open.ts'
import { type PanelFacts, publicOf } from './web-panel.ts'
import { recordsFrom } from './web-records.ts'
import { repositoriesFrom } from './web-repositories.ts'
import { takingFrom } from './web-take.ts'

// What only an owner on another machine of the person's asks of this one, as
// this window answers it (`@tade/web`'s `owned.ts`): the line that shows one of
// its agents, the person's notes shared, and where each project's work is for
// a fetch over the same SSH, and what this machine is, one of its documents
// and one of its tools that only reads (`web-machine.ts`) — the first out of
// the away view's own facts, which only it holds — its public name's records
// looked at now (`web-records.ts`), what one of its watches has already
// found, for a machine taking it back (`watch-seen.ts`), and work it hands this
// machine to start (`web-take.ts`) and a project it moves here, opened
// (`web-open.ts`), and what another machine of theirs has, kept here
// (`inventory.ts`) — and every machine's inventory with the press that moves
// the keys, for the person's own phone (`web-machines.ts`). One place, so the away view's wiring names them once.

export function ownedFor(
  wire: Wiring,
  away: () => PanelFacts,
  lifecycle?: Lifecycle,
  inventory?: Pick<Inventories, 'latest' | 'heard'> & MachinesHeld,
) {
  return {
    attaching: attachingFor(wire.opts.client),
    notes: notesFor(wire),
    repositories: repositoriesFrom(
      () => wire.live?.world ?? null,
      wire.opts.home,
      (message) =>
        void wire.opts.client.log
          .append({ type: 'warning', detail: { message } })
          .catch((err: unknown) => wire.note(err)),
    ),
    machine: machineFrom(wire, {
      public: () => {
        const shown = publicOf(away())
        return shown === null ? null : { name: shown.name, up: shown.up, health: [...shown.lines] }
      },
      problem: () => away().problem,
      ...(inventory && { inventory: () => inventory.latest() }),
    }),
    document: documentFrom(wire),
    tool: toolFrom(wire),
    records: recordsFrom(wire),
    taking: takingFrom(wire),
    watchSeen: watchSeenFrom(wire),
    // What another machine of the person's has, kept here (`inventory.ts`).
    ...(inventory && {
      inventoryTold: (told: Inventory, device: string) => inventory.heard(told, device),
      machines: machinesFrom(wire, inventory),
    }),
    ...(lifecycle === undefined ? {} : { opening: openingFrom(wire, lifecycle) }),
  }
}

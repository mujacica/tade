import type { Wiring } from './context.ts'
import { notesFor } from './notes-shared.ts'
import { attachingFor } from './web-attach.ts'
import { documentFrom, machineFrom, toolFrom } from './web-machine.ts'
import { type PanelFacts, publicOf } from './web-panel.ts'
import { repositoriesFrom } from './web-repositories.ts'
import { takingFrom } from './web-take.ts'

// What only an owner on another machine of the person's asks of this one, as
// this window answers it (`@tade/web`'s `owned.ts`): the line that shows one of
// its agents, the person's notes shared, and where each project's work is for
// a fetch over the same SSH, and what this machine is, one of its documents
// and one of its tools that only reads (`web-machine.ts`) — the first out of
// the away view's own facts, which only it holds — and work it hands this
// machine to start (`web-take.ts`). One place, so the away view's wiring names
// them once.

export function ownedFor(wire: Wiring, away: () => PanelFacts) {
  return {
    attaching: attachingFor(wire.opts.client),
    notes: notesFor(wire),
    repositories: repositoriesFrom(() => wire.live?.world ?? null),
    machine: machineFrom(wire, {
      public: () => {
        const shown = publicOf(away())
        return shown === null ? null : { name: shown.name, up: shown.up, health: [...shown.lines] }
      },
      problem: () => away().problem,
    }),
    document: documentFrom(wire),
    tool: toolFrom(wire),
    taking: takingFrom(wire),
  }
}

import type { Wiring } from './context.ts'
import { notesFor } from './notes-shared.ts'
import { attachingFor } from './web-attach.ts'
import { repositoriesFrom } from './web-repositories.ts'

// What only an owner on another machine of the person's asks of this one, as
// this window answers it (`@tade/web`'s `owned.ts`): the line that shows one of
// its agents, the person's notes shared, and where each project's work is for
// a fetch over the same SSH. One place, so the away view's wiring names them
// once.

export function ownedFor(wire: Wiring) {
  return {
    attaching: attachingFor(wire.opts.client),
    notes: notesFor(wire),
    repositories: repositoriesFrom(() => wire.live?.world ?? null),
  }
}
